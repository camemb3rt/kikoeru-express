const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const { param, query } = require('express-validator');
const db = require('../database/db');
const { getTrackList, toTree, manualCoverMarkerPath } = require('../filesystem/utils');
const { config } = require('../config');
const normalize = require('./utils/normalize');
const { isValidRequest } = require('./utils/validate');

const PAGE_SIZE = config.pageSize || 12;
const coverTypes = ['main', 'sam', '240x240', '360x360'];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const getCoverPath = (rjcode, type) => {
  const markerPath = manualCoverMarkerPath(rjcode);
  if (fs.existsSync(markerPath)) {
    const extension = fs.readFileSync(markerPath, 'utf8').trim();
    if (['jpg', 'png'].includes(extension)) {
      const manualPath = path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.${extension}`);
      if (fs.existsSync(manualPath)) return manualPath;
    }
  }

  for (const extension of ['jpg', 'png']) {
    const coverPath = path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.${extension}`);
    if (fs.existsSync(coverPath)) return coverPath;
  }
  return null;
};

// GET work cover image
router.get('/cover/:id', param('id').isString(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  const rjcode = req.params.id;
  const type = req.query.type || 'main'; // 'main', 'sam', '240x240', '360x360'
  const coverPath = getCoverPath(rjcode, type);
  res.sendFile(coverPath || path.join(__dirname, '../static/no-image.jpg'), err => {
    if (err) next(err);
  });
});

// Manually replace a work cover. A single JPEG or PNG is stored for every cover size
// so that the work page, cards, and compact player all update together.
router.put(
  '/cover/:id',
  param('id').isInt(),
  express.raw({ type: ['image/jpeg', 'image/png'], limit: '10mb' }),
  async (req, res, next) => {
    if (!isValidRequest(req, res)) return;

    if (config.auth && req.user.name !== 'admin') {
      return res.status(403).send({ error: 'Only the admin account can upload cover art.' });
    }

    const isJpeg = Buffer.isBuffer(req.body) && req.body.length >= 3 && req.body[0] === 0xff && req.body[1] === 0xd8 && req.body[2] === 0xff;
    const isPng = Buffer.isBuffer(req.body) && req.body.length >= 8 && req.body.subarray(0, 8).equals(pngSignature);
    if (!isJpeg && !isPng) {
      return res.status(400).send({ error: 'Upload a JPEG or PNG image smaller than 10 MB.' });
    }

    const extension = isPng ? 'png' : 'jpg';
    const rjcode = req.params.id;

    try {
      const work = await db.knex('t_work').select('id').where('id', '=', rjcode).first();
      if (!work) {
        return res.status(404).send({ error: 'Work not found.' });
      }
      fs.mkdirSync(config.coverFolderDir, { recursive: true });
      coverTypes.forEach(type => {
        for (const oldExtension of ['jpg', 'png']) {
          if (oldExtension !== extension) {
            fs.rmSync(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.${oldExtension}`), { force: true });
          }
        }
        fs.writeFileSync(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.${extension}`), req.body);
      });
      fs.writeFileSync(manualCoverMarkerPath(rjcode), extension);
      res.send({ message: 'Cover art uploaded successfully and will be kept during scans.' });
    } catch (err) {
      next(err);
    }
  }
);

// GET work metadata
router.get('/work/RJ:id', param('id').isString(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  let username = 'admin';
  if (config.auth) {
    username = req.user.name;
  }
  db.getWorkMetadata(req.params.id, username)
    .then(work => {
      // work is an Array of length 1
      normalize(work);
      res.send(work[0]);
    })
    .catch(err => next(err));
});

// GET track list in work folder
router.get('/tracks/:id', param('id').isInt(), (req, res, next) => {
  if (!isValidRequest(req, res)) return;

  db.knex('t_work')
    .select('title', 'root_folder', 'dir', 'memo')
    .where('id', '=', req.params.id)
    .first()
    .then(work => {
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder) {
        getTrackList(req.params.id, path.join(rootFolder.path, work.dir), JSON.parse(work.memo))
          .then(tracks => res.send(toTree(tracks, work.title, work.dir, rootFolder)))
          .catch(() => res.status(500).send({ error: 'Could not load the file list. Check that the files exist or run a rescan.' }));
      } else {
        res.status(500).send({ error: `Folder not found: "${work.root_folder}". Try restarting the server or running a rescan.` });
      }
    })
    .catch(err => next(err));
});

// GET list of work ids
router.get(
  '/works',
  query('page').optional({ nullable: true }).isInt(),
  query('sort').optional({ nullable: true }).isIn(['desc', 'asc']),
  query('seed').optional({ nullable: true }).isInt(),
  // eslint-disable-next-line no-unused-vars
  async (req, res, next) => {
    if (!isValidRequest(req, res)) return;

    const currentPage = parseInt(req.query.page) || 1;
    // 通过 "音声id, 添加时间, 贩卖日, 评价, 用户评价, 售出数, 评论数量, 价格, 平均评价, 全年龄新作， 评价" 排序
    // ['id', "add_time', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp, nsfw']
    const order = req.query.order || 'add_time';
    const sort = req.query.sort || 'desc';
    const lyricStatus = req.query.lyricStatus ? JSON.parse(req.query.lyricStatus) : false;
    const pageSize = parseInt(req.query.pageSize) || PAGE_SIZE;
    const offset = (currentPage - 1) * pageSize;
    const username = config.auth ? req.user.name : 'admin';
    const shuffleSeed = req.query.seed ? req.query.seed : 7;
    const excludedIds = String(req.query.excludeIds || '')
      .split(',')
      .filter(id => /^\d+$/.test(id));

    try {
      const query = () => {
        const worksQuery = db.getWorksBy({ username: username });
        return excludedIds.length ? worksQuery.whereNotIn('id', excludedIds) : worksQuery;
      };
      let totalCount;
      let works;
      if (lyricStatus) {
        totalCount = await query().where('lyric_status', '=', lyricStatus).count('id as count');
        if (order === 'random') {
          // 随机排序+分页 hack
          works = await query()
            .where('lyric_status', '=', lyricStatus)
            .orderBy(db.knex.raw('id % ?', shuffleSeed))
            .offset(offset)
            .limit(pageSize);
        } else if (order === 'betterRandom') {
          // 随心听专用，不支持分页
          works = await query().where('lyric_status', '=', lyricStatus).orderBy(db.knex.raw('random()')).limit(1);
        } else {
          works = await query()
            .where('lyric_status', '=', lyricStatus)
            .orderBy(order, sort)
            .orderBy([
              { column: 'release', order: 'desc' },
              { column: 'id', order: 'desc' }
            ])
            .offset(offset)
            .limit(pageSize);
        }
      } else {
        totalCount = await query().count('id as count');
        if (order === 'random') {
          // 随机排序+分页 hack
          works = await query().orderBy(db.knex.raw('id % ?', shuffleSeed)).offset(offset).limit(pageSize);
        } else if (order === 'betterRandom') {
          // 随心听专用，不支持分页
          works = await query().orderBy(db.knex.raw('random()')).limit(1);
        } else {
          works = await query()
            .orderBy(order, sort)
            .orderBy([
              { column: 'release', order: 'desc' },
              { column: 'id', order: 'desc' }
            ])
            .offset(offset)
            .limit(pageSize);
        }
      }

      works = normalize(works);

      res.send({
        works,
        page: currentPage,
        pageSize: pageSize,
        totalCount: totalCount[0]['count']
      });
    } catch (err) {
      res.status(500).send({ error: 'Server error' });
      console.error(err);
      // next(err);
    }
  }
);

// GET name of a circle/tag/VA
router.get('/:field(circle|tag|va)s/:id', param('field').isIn(['circle', 'tag', 'va']), (req, res, next) => {
  // In case regex matching goes wrong
  if (!isValidRequest(req, res)) return;

  return db
    .getMetadata({ field: req.params.field, id: req.params.id })
    .then(item => {
      if (item) {
        res.send(item);
      } else {
        const errorMessage = {
          circle: `社团${req.params.id}不存在`,
          tag: `标签${req.params.id}不存在`,
          va: `声优${req.params.id}不存在`
        };
        res.status(404).send({ error: errorMessage[req.params.field] });
      }
    })
    .catch(err => next(err));
});

// eslint-disable-next-line no-unused-vars
router.get('/search', async (req, res, next) => {
  const keywords = req.query.keywords;
  const currentPage = parseInt(req.query.page) || 1;
  // 通过 "音声id, 贩卖日, 用户评价， 售出数, 评论数量, 价格, 平均评价, 全年龄新作" 排序
  // ['id', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp', 'nsfw']
  const order = req.query.order || 'release';
  const sort = req.query.sort || 'desc';
  const lyricStatus = JSON.parse(req.query.lyricStatus);
  const pageSize = parseInt(req.query.pageSize) || PAGE_SIZE;
  const offset = (currentPage - 1) * pageSize;
  const username = config.auth ? req.user.name : 'admin';
  const shuffleSeed = req.query.seed ? req.query.seed : 7;

  try {
    const query = () => db.getWorksByKeyWord({ keywords: keywords, username: username });
    let totalCount;
    let works;
    if (lyricStatus) {
      totalCount = await query().where('lyric_status', '=', lyricStatus).count('id as count');
      if (order === 'random') {
        works = await query()
          .where('lyric_status', '=', lyricStatus)
          .offset(offset)
          .limit(pageSize)
          .orderBy(db.knex.raw('id % ?', shuffleSeed));
      } else {
        works = await query()
          .where('lyric_status', '=', lyricStatus)
          .offset(offset)
          .limit(pageSize)
          .orderBy(order, sort)
          .orderBy([
            { column: 'release', order: 'desc' },
            { column: 'id', order: 'desc' }
          ]);
      }
    } else {
      totalCount = await query().count('id as count');
      if (order === 'random') {
        works = await query().offset(offset).limit(pageSize).orderBy(db.knex.raw('id % ?', shuffleSeed));
      } else {
        works = await query()
          .offset(offset)
          .limit(pageSize)
          .orderBy(order, sort)
          .orderBy([
            { column: 'release', order: 'desc' },
            { column: 'id', order: 'desc' }
          ]);
      }
    }

    works = normalize(works);

    res.send({
      works,
      page: currentPage,
      pageSize: pageSize,
      totalCount: totalCount[0]['count']
    });
  } catch (err) {
    res.status(500).send({ error: 'An error occurred while querying data.' });
    console.error(err);
    next(err);
  }
});

// GET list of circles/tags/VAs
router.get('/:field(circle|tag|va)s/', param('field').isIn(['circle', 'tag', 'va']), (req, res, next) => {
  // In case regex matching goes wrong
  if (!isValidRequest(req, res)) return;

  const field = req.params.field;
  db.getLabels(field)
    .orderBy(`name`, 'asc')
    .then(list => res.send(list))
    .catch(err => next(err));
});

module.exports = router;
