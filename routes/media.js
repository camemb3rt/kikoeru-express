const express = require('express');
const router = express.Router();
const { config } = require('../config');
const db = require('../database/db');
const { param, validationResult } = require('express-validator');
const fs = require('fs');
const path = require('path');
const jschardet = require('jschardet');
const { getTrackList, supportedSubtitleExtList } = require('../filesystem/utils');
const { joinFragments } = require('./utils/url');
const { isValidRequest } = require('./utils/validate');

/**
 * 统一错误处理包装
 */
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * 获取 work + rootFolder
 */
async function getWorkAndRoot(id) {
  const work = await db.knex('t_work')
    .select('root_folder', 'dir', 'lyric_status')
    .where('id', '=', id)
    .first();

  if (!work) {
    throw new Error('work not found');
  }

  const rootFolder = config.rootFolders.find(
    r => r.name === work.root_folder
  );

  if (!rootFolder) {
    throw new Error(`找不到文件夹: "${work.root_folder}"`);
  }

  return { work, rootFolder };
}

/**
 * 获取 track
 */
async function getTrack(id, trackFile, rootFolder, work) {
  const tracks = await getTrackList(
    id,
    path.join(rootFolder.path, work.dir)
  );

  const track = tracks.find(
    t => t.mediaPath === `RJ${id}/${trackFile}`
  );

  if (!track) {
    return null;
  }

  return { track, tracks };
}

/**
 * =========================
 * STREAM
 * =========================
 */
router.get(
  '/stream/RJ:id/:trackFile([\\s\\S]*)',
  param('id').isInt(),
  asyncHandler(async (req, res) => {
    if (!isValidRequest(req, res)) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const id = req.params.id;

    const { work, rootFolder } = await getWorkAndRoot(id);

    const result = await getTrack(
      id,
      req.params.trackFile,
      rootFolder,
      work
    );

    if (!result) {
      return res.status(404).send({ error: 'track not found' });
    }

    const { track } = result;

    const fileName = path.join(
      rootFolder.path,
      work.dir,
      track.subtitle || '',
      track.title
    );

    const extName = path.extname(fileName).toLowerCase();

    // ===== 文本编码处理 =====
    if ([...supportedSubtitleExtList, '.txt'].includes(extName)) {
      const fileBuffer = fs.readFileSync(fileName);
      const charset = jschardet.detect(fileBuffer).encoding;
      if (charset) {
        res.setHeader('Content-Type', `text/plain; charset=${charset}`);
      }
    }

    // ===== flac 兼容 =====
    if (extName === '.flac') {
      res.setHeader('Content-Type', 'audio/flac');
    }

    // ===== offload =====
    if (
      config.offloadMedia &&
      extName !== '.txt' &&
      !supportedSubtitleExtList.includes(extName)
    ) {
      let offloadUrl = joinFragments(
        config.offloadStreamPath,
        rootFolder.name,
        work.dir,
        track.subtitle || '',
        track.title
      );

      if (process.platform === 'win32') {
        offloadUrl = offloadUrl.replace(/\\/g, '/');
      }

      return res.redirect(offloadUrl);
    }

    // ===== 默认 =====
    return res.sendFile(fileName);
  })
);

/**
 * =========================
 * DOWNLOAD
 * =========================
 */
router.get(
  '/download/RJ:id/:trackFile([\\s\\S]*)',
  param('id').isInt(),
  asyncHandler(async (req, res) => {
    if (!isValidRequest(req, res)) return;

    const id = req.params.id;

    const { work, rootFolder } = await getWorkAndRoot(id);

    const result = await getTrack(
      id,
      req.params.trackFile,
      rootFolder,
      work
    );

    if (!result) {
      return res.status(404).send({ error: 'track not found' });
    }

    const { track } = result;

    if (config.offloadMedia) {
      let offloadUrl = joinFragments(
        config.offloadDownloadPath,
        rootFolder.name,
        work.dir,
        track.subtitle || '',
        track.title
      );

      if (process.platform === 'win32') {
        offloadUrl = offloadUrl.replace(/\\/g, '/');
      }

      return res.redirect(offloadUrl);
    }

    const filePath = path.join(
      rootFolder.path,
      work.dir,
      track.subtitle || '',
      track.title
    );

    return res.download(filePath);
  })
);

/**
 * =========================
 * CHECK LRC
 * =========================
 */
router.get(
  '/check-lrc/:id/:index',
  param('id').isInt(),
  param('index').isInt(),
  asyncHandler(async (req, res) => {
    if (!isValidRequest(req, res)) return;

    const id = req.params.id;
    const index = parseInt(req.params.index, 10);

    const { work, rootFolder } = await getWorkAndRoot(id);

    const tracks = await getTrackList(
      id,
      path.join(rootFolder.path, work.dir)
    );

    const track = tracks[index];

    if (!track) {
      return res.status(404).send({ error: 'track index invalid' });
    }

    if (!work.lyric_status) {
      return res.send({
        result: false,
        message: '不存在歌词文件',
        mediaPath: ''
      });
    }

    const lyricExtensions = ['.lrc', '.srt', '.vtt'];
    const trackBaseName = track.title.substring(0, track.title.lastIndexOf('.'));
    const lyricFileNames = new Set(lyricExtensions.flatMap(extension => [
      `${trackBaseName}${extension}`,
      `${track.title}${extension}`
    ]).map(fileName => fileName.toLowerCase()));
    const found = tracks.find(candidate =>
      candidate.subtitle === track.subtitle &&
      lyricFileNames.has(candidate.title.toLowerCase())
    );

    if (found) {
      return res.send({
        result: true,
        message: '找到歌词文件',
        mediaPath: found.mediaPath,
        lyricExtension: path.extname(found.title).toLowerCase()
      });
    }

    return res.send({
      result: false,
      message: '该文件不存在歌词文件',
      mediaPath: ''
    });
  })
);

/**
 * =========================
 * 全局错误兜底（必须有）
 * =========================
 */
router.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).send({
    error: err.message || 'Internal Server Error'
  });
});

module.exports = router;
