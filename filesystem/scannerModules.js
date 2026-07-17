const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const LimitPromise = require('limit-promise'); // 限制并发数量

const axios = require('../scraper/axios.js'); // 数据请求
const { scrapeWorkMetadataFromDLsite, scrapeDynamicWorkMetadataFromDLsite } = require('../scraper/dlsite');
const { scrapeWorkMetadataFromAsmrOne } = require('../scraper/asmrOne');
const scrapeWorkMetadataFromHVDB = require('../scraper/hvdb');
const { scrapeWorkMemo } = require('../scraper/memo');

const db = require('../database/db');
const { createSchema } = require('../database/schema');

const { getFolderList, deleteCoverImageFromDisk, saveCoverImageToDisk } = require('./utils');
const { md5 } = require('../auth/utils');
const { nameToUUID, toDlsiteWorkCode } = require('../scraper/utils');

const { config } = require('../config');
const { updateLock } = require('../upgrade');

// 只有在子进程中 process 对象才有 send() 方法
process.send = process.send || function () {};

const tasks = [];
const failedTasks = [];
const mainLogs = [];
const results = [];

const logger = {
  finish(message) {
    console.log(` * ${message}`);
    process.send({ event: 'SCAN_FINISHED', payload: { message } });
  },
  main: {
    __internal__(level, message) {
      console[level](message);

      mainLogs.push({ level, message });
      process.send({ event: 'SCAN_MAIN_LOGS', payload: { mainLogs } });
    },
    log(msg) {
      // default log at level info
      this.__internal__('info', msg);
    },
    debug(msg) {
      this.__internal__('debug', msg);
    },
    info(msg) {
      this.__internal__('info', msg);
    },
    error(msg) {
      this.__internal__('error', msg);
    },
    warn(msg) {
      this.__internal__('warn', msg);
    }
  },
  result: {
    add(rjcode, result, count) {
      results.push({ rjcode, result, count });
      process.send({ event: 'SCAN_RESULTS', payload: { results } });
    }
  },
  task: {
    // 添加作品专门的log记录
    add(taskId) {
      // taskId == rjcode, e.g. "443322" or "01134321"
      // console.log("[TASK] Add", taskId);
      console.assert(typeof taskId === 'string' && (taskId.length === 6 || taskId.length === 8));
      tasks.push({ rjcode: taskId, result: null, logs: [] });
    },

    // 移除作品的专属log，如果该作品的对应任务失败，则发送相应的失败消息
    remove(taskId, result) {
      // console.log("[task] Remove", taskId);
      const index = tasks.findIndex(task => task.rjcode === taskId);
      if (index == -1) {
        // 当前任务并没有被添加，则跳过remove操作
        return;
      }

      const removedTask = tasks[index];
      removedTask.result = result;
      tasks.splice(index, 1);
      process.send({ event: 'SCAN_TASKS', payload: { tasks } });

      if (removedTask.result === 'failed') {
        failedTasks.push(removedTask);
        process.send({ event: 'SCAN_FAILED_TASKS', payload: { failedTasks } });
      }
    },
    __internal_task__(taskId, level, msg) {
      console.assert(typeof taskId === 'string' && (taskId.length === 6 || taskId.length === 8));
      console[level](`-> [RJ${taskId}]`, msg);

      const task = tasks.find(task => task.rjcode === taskId);
      if (task) {
        task.logs.push({ level, message: msg });
        process.send({ event: 'SCAN_TASKS', payload: { tasks } });
      }
    },
    log(taskId, msg) {
      // default log at level info
      this.__internal_task__(taskId, 'info', msg);
    },
    debug(taskId, msg) {
      this.__internal_task__(taskId, 'debug', msg);
    },
    info(taskId, msg) {
      this.__internal_task__(taskId, 'info', msg);
    },
    error(taskId, msg) {
      this.__internal_task__(taskId, 'error', msg);
    },
    warn(taskId, msg) {
      this.__internal_task__(taskId, 'warn', msg);
    }
  }
};

process.on('message', m => {
  if (m.emit === 'SCAN_INIT_STATE') {
    process.send({ event: 'SCAN_INIT_STATE', payload: { tasks, failedTasks, mainLogs, results } });
  } else if (m.exit) {
    logger.main.error(' ! Scan cancelled.');
    process.exit(1);
  }
});

/**
 * 通过数组 arr 中每个对象的 id 属性来对数组去重
 * @param {Array} arr
 */
function uniqueFolderListSeparate(arr) {
  const uniqueList = [];
  const duplicateSet = {};

  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i].id === arr[j].id) {
        duplicateSet[arr[i].id] = duplicateSet[arr[i].id] || [];
        duplicateSet[arr[i].id].push(arr[i]);
        ++i;
      }
    }
    uniqueList.push(arr[i]);
  }

  return {
    uniqueList, // 去重后的数组
    duplicateSet // 对象，键为id，值为多余的重复项数组
  };
}

/**
 * 通过DLsite或asmr-one的方式爬取元数据（部分RJ号作品可能下架）
 * @param {string} id
 * @param {string} language
 * @returns object对象
 */
async function scrapeWorkMetadata(id, language) {
  const rjcode = id;
  return scrapeWorkMetadataFromDLsite(id, language)
    .then(metadata => {
      return metadata;
    })
    .catch(err => {
      logger.task.warn(rjcode, `DLsite metadata request failed; trying ASMR.one: ${err.message}`);
      return scrapeWorkMetadataFromAsmrOne(id, language)
        .then(metadata => {
          return metadata;
        })
        .catch(err => {
          logger.task.warn(rjcode, `ASMR.one metadata request failed: ${err.message}`);
          return scrapeWorkMetadataFromHVDB(id)
            .then(metadata => {
              return metadata;
            })
            .catch(err => {
              logger.task.warn(rjcode, `HVDB metadata request failed: ${err.message}`);
              throw err;
            });
        });
    });
}

/**
 * 从 DLsite 抓取该音声的元数据，并保存到数据库，
 * 返回一个 Promise 对象，处理结果: 'added' or 'failed'
 * @param {object} folder
 * @param {string} tagLanguage 标签语言，'ja-jp', 'zh-tw' or 'zh-cn'，默认'zh-cn'
 */
async function getMetadata(folder, tagLanguage) {
  const rjcode = folder.id;

  // 先从DLsite抓取元数据，若失败则从asmr-one抓取元数据
  return scrapeWorkMetadata(folder.id, tagLanguage)
    .then(async metadata => {
      logger.task.info(rjcode, 'Metadata fetched successfully. Adding it to the database...');

      metadata.rootFolderName = folder.rootFolderName;
      metadata.dir = folder.relativePath;
      metadata.addTime = folder.addTime;

      return db
        .insertWorkMetadata(metadata)
        .then(() => {
          logger.task.info(rjcode, 'Database: metadata added successfully.');
          return 'added';
        })
        .catch(err => {
          logger.task.warn(rjcode, `Database: failed to add metadata: ${err.message}`);
          return 'failed';
        });
    })
    .catch(err => {
      logger.task.warn(rjcode, `Database: metadata request failed: ${err.message}`);
      return 'failed';
    });
}

/**
 * Build a DLsite cover URL for a work code. Translation pages can use a
 * different code from the cover artwork's original work, so callers should
 * resolve the cover code from the product page before using this helper.
 */
const getDlsiteCoverUrl = (id, type) => {
  const id2 = id % 1000 === 0 ? id : Math.floor(id / 1000) * 1000 + 1000;
  const rjcode = toDlsiteWorkCode(id);
  const rjcode2 = toDlsiteWorkCode(id2);

  if (type === '240x240' || type === '360x360') {
    return `https://img.dlsite.jp/resize/images2/work/doujin/RJ${rjcode2}/RJ${rjcode}_img_main_${type}.jpg`;
  }
  return `https://img.dlsite.jp/modpub/images2/work/doujin/RJ${rjcode2}/RJ${rjcode}_img_${type}.jpg`;
};

/**
 * Resolve a translated DLsite work to the work code used by its cover image.
 */
const resolveDlsiteCoverCode = async id => {
  const url = `https://www.dlsite.com/maniax/work/=/product_id/RJ${toDlsiteWorkCode(id)}.html?locale=en_US`;
  const response = await axios.retryGet(url, {
    retry: {},
    headers: { cookie: 'locale=en_US', 'accept-language': 'en-US,en;q=0.9' }
  });
  const $ = cheerio.load(response.data);
  const coverUrl = $('meta[property="og:image"]').attr('content') || '';
  const match = coverUrl.match(/RJ(\d+)_img_main\.jpg/);
  return match ? match[1] : String(id);
};

/**
 * Downloads cover images and saves them with the local work's RJ code.
 * 返回一个 Promise 对象，处理结果: 'added' or 'failed'
 * @param {number} id work id
 * @param {Array} types img types: ['main', 'sam', 'sam@2x', 'sam@3x', '240x240', '360x360']
 */
const getCoverImage = async (id, types) => {
  const rjcode = String(id);
  let dlsiteCoverCode = String(id);
  try {
    dlsiteCoverCode = await resolveDlsiteCoverCode(id);
    if (dlsiteCoverCode !== String(id)) {
      logger.task.info(rjcode, `Resolved translated work cover to RJ${dlsiteCoverCode}.`);
    }
  } catch (err) {
    logger.task.warn(rjcode, `Could not resolve the DLsite cover code: ${err.message}`);
  }

  const results = await Promise.all(
    types.map(async type => {
      const urls = [getDlsiteCoverUrl(Number(dlsiteCoverCode), type)];
      if (dlsiteCoverCode !== String(id)) urls.push(getDlsiteCoverUrl(id, type));
      urls.push(`https://api.asmr-200.com/api/cover/${id}.jpg?type=${type}`);

      for (const url of urls) {
        try {
          const imageRes = await axios.retryGet(url, { responseType: 'stream', retry: {} });
          await saveCoverImageToDisk(imageRes.data, rjcode, type);
          logger.task.info(rjcode, `Cover image RJ${rjcode}_img_${type}.jpg downloaded successfully.`);
          return 'added';
        } catch (err) {
          logger.task.warn(rjcode, `Cover source failed for ${type}: ${err.message}`);
        }
      }

      logger.task.error(rjcode, `Could not download cover image RJ${rjcode}_img_${type}.jpg.`);
      return 'failed';
    })
  );

  return results.every(result => result === 'added') ? 'added' : 'failed';
};

const getMissingCoverTypes = id => {
  const coverTypes = ['main', 'sam', '240x240'];
  return coverTypes.filter(type => !fs.existsSync(path.join(config.coverFolderDir, `RJ${id}_img_${type}.jpg`)));
};

/**
 * 获取作品本地信息
 * @param {string} id 作品RJ号
 * @param {string} dir 文件夹路径
 */
async function getWorkMemo(id, dir, readMemo = {}) {
  logger.task.info(id, 'Scanning local file data...');
  return scrapeWorkMemo(id, dir, readMemo)
    .then(async ({ workDuration, memo, lyricStatus }) => {
      logger.task.info(id, 'Local file data scanned successfully. Updating the database...');
      return db
        .setWorkMemo(id, workDuration, memo, lyricStatus)
        .then(async () => {
          logger.task.info(id, 'Database: local file data updated successfully.');
          return 'added';
        })
        .catch(err => {
          logger.task.warn(id, `Database: failed to update local file data: ${err.message}`);
          return 'failed';
        });
    })
    .catch(err => {
      logger.task.warn(id, `Failed to update local file data: ${err.message}`);
    });
}

/**
 * 获取音声元数据，获取音声封面图片，
 * 返回一个 Promise 对象，处理结果: 'added', 'skipped' or 'failed'
 * @param {string} folder 音声文件夹对象 { relativePath: '相对路径', rootFolderName: '根文件夹别名', id: '音声ID' }
 */
async function processFolder(folder) {
  return db
    .knex('t_work')
    .select('id')
    .where('id', '=', folder.id)
    .count()
    .first()
    .then(res => {
      const rjcode = folder.id;
      const coverTypes = ['main', 'sam', '240x240'];
      const count = res['count(*)'];
      if (count) {
        // 查询数据库，检查是否已经写入该音声的元数据
        // 已经成功写入元数据
        // 检查音声封面图片是否缺失
        const lostCoverTypes = [];
        coverTypes.forEach(type => {
          const coverPath = path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`);
          if (!fs.existsSync(coverPath)) {
            lostCoverTypes.push(type);
          }
        });

        if (lostCoverTypes.length) {
          logger.task.add(rjcode);
          logger.task.info(rjcode, 'Cover image is missing. Downloading it again...');

          return getCoverImage(folder.id, lostCoverTypes);
        } else {
          return 'skipped';
        }
      } else {
        logger.task.add(rjcode);
        logger.task.info(rjcode, `New folder found: "${folder.absolutePath}"`);

        return getMetadata(folder, config.tagLanguage).then(result => {
          if (result === 'failed') {
            // 如果获取元数据失败，跳过封面图片下载
            return 'failed';
          } else {
            return getWorkMemo(folder.id, folder.absolutePath).then(result => {
              if (result === 'failed') {
                return 'failed';
              } else {
                // 下载封面图片
                logger.task.info(rjcode, 'Downloading cover image from DLsite...');
                return getCoverImage(folder.id, coverTypes);
              }
            });
          }
        });
      }
    });
}

const MAX = config.maxParallelism; // 并发请求上限
const limitP = new LimitPromise(MAX); // 核心控制器
/**
 * 限制 processFolder 并发数量，
 * 使用控制器包装 processFolder 方法，实际上是将请求函数递交给控制器处理
 */
async function processFolderLimited(folder) {
  return await limitP.call(processFolder, folder);
}

/**
 * 清理本地不再存在的音声: 将其元数据从数据库中移除，并删除其封面图片
 */
async function performCleanup() {
  const trxProvider = db.knex.transactionProvider();
  const trx = await trxProvider();
  const works = await trx('t_work').select('id', 'root_folder', 'dir');

  await Promise.all(
    works.map(async work => {
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder && fs.existsSync(path.join(rootFolder.path, work.dir))) {
        // 仍然存在，不需要清理
        return;
      }

      await db.removeWork(work.id, trxProvider);
      const rjcode = work.id;
      try {
        await deleteCoverImageFromDisk(rjcode);
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          logger.main.error(` ! [RJ${rjcode}] Failed to delete cover image: ${err.message}`);
        }
      }
    })
  );
  trx.commit();
}

// 尝试创建数据库
async function tryCreateDatabase() {
  try {
    await createSchema();
  } catch (err) {
    logger.main.error(` ! Failed to build the database schema: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// 尝试创建管理员账号，如果已存在则忽略
// 如果发生其他异常则直接杀死本进程
async function tryCreateAdminUser() {
  try {
    // 创建内置的管理员账号
    await db.createUser({ name: 'admin', password: md5('admin'), group: 'administrator' });
  } catch (err) {
    if (err.message.indexOf('已存在') === -1) {
      logger.main.error(` ! Failed to create the admin account: ${err.message}`);
      process.exit(1);
    }
  }
}

// 修复以往的数据库问题，老逻辑了，不太清楚具体修复的问题是什么，先放在这里
// 成功返回true，失败返回false
async function fixVADatabase() {
  // Fix hash collision bug in t_va
  // Scan to repopulate the Voice Actor data for those problematic works
  // かの仔 and こっこ
  let success = true;
  if (updateLock.isLockFilePresent && updateLock.lockFileConfig.fixVA) {
    logger.main.log('-> Starting voice-actor metadata repair (internet connection required).');
    try {
      const updateResult = await fixVoiceActorBug();
      counts.updated += updateResult;
      updateLock.removeLockFile();
      logger.main.log('-> Metadata repair complete.');
    } catch (err) {
      logger.main.error('->', err.toString());
      success = false;
    }
  }
  return success;
}

// 尝试清理不存在的数据，该阶段可能会根据用户配置跳过
// 如果清理过程中发生一场则杀死该进程
async function tryCleanupStage() {
  if (config.skipCleanup) {
    logger.main.info('-> Skipping cleanup of missing works.');
  } else {
    try {
      logger.main.info('-> Removing database data and cover images for works no longer present locally...');
      await performCleanup();
      logger.main.info('-> Cleanup complete. Starting scan...');
    } catch (err) {
      logger.main.error(` ! Cleanup failed: ${err.message}`);
      process.exit(1);
    }
  }
}

// 尝试扫描所有媒体库的文件夹
// 返回扫描得到的work的文件夹
async function tryScanRootFolders() {
  let folderList = [];
  try {
    for (const rootFolder of config.rootFolders) {
      for await (const folder of getFolderList(rootFolder, '', 0, logger.main)) {
        folderList.push(folder);
      }
    }
    logger.main.info(`-> Found ${folderList.length} work folder(s).`);
  } catch (err) {
    logger.main.error(` ! Failed to scan the root folder: ${err.message}`);
    process.exit(1);
  }
  return folderList;
}

// 并行处理这些文件夹
// 返回总的处理结果，表明处理的数量
// {
//   added: 0, // 添加的文件夹数量
//   failed: 0, // 失败
//   skipped: 0, // 跳过
//   updated: 0, // 更新
// };
async function tryProcessFolderListParallel(folderList) {
  const counts = { added: 0, failed: 0, skipped: 0, updated: 0 };

  try {
    // 去重，避免在之后的并行处理文件夹过程中，出现对数据库同时写入同一条记录的错误
    const { uniqueList: uniqueFolderList, duplicateSet } = uniqueFolderListSeparate(folderList);
    const duplicateNum = folderList.length - uniqueFolderList.length;

    if (duplicateNum) {
      logger.main.info(`-> Found ${duplicateNum} work(s) with duplicate folders.`);

      for (const key in duplicateSet) {
        // duplicateSet中并不包含存在于uniqueFolderList中的文件夹，
        // 将unique和duplicate重复的选项添加回duplicateSet，方便用户观察那些文件夹是重复的
        const addedFolder = uniqueFolderList.find(folder => folder.id === key);
        duplicateSet[key].push(addedFolder); // 最后一项为是被添加到数据库中的音声文件夹，将其一同展示给用户

        const rjcode = key; // zero-pad to 6 or 8 digits

        logger.main.info(` -> [RJ${rjcode}] has multiple folders:`);

        // 打印音声文件夹的绝对路径
        duplicateSet[key].forEach(folder => {
          const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === folder.rootFolderName);
          const absolutePath = path.join(rootFolder.path, folder.relativePath);
          logger.main.info(` --> ${absolutePath}`);
        });
      }
    }

    counts.skipped += duplicateNum;

    await Promise.all(
      uniqueFolderList.map(async folder => {
        const result = await processFolderLimited(folder);
        counts[result] += 1;

        const rjcode = folder.id; // zero-pad to 6 digits\
        switch (result) {
          case 'added':
            logger.task.info(rjcode, `Added successfully. Total added: ${counts.added}`);
            break;
          case 'failed':
            logger.task.error(rjcode, `Failed to add work. Total failed: ${counts.failed}`);
            break;
          default:
            break;
        }
        logger.task.remove(rjcode, result);
        if (result !== 'skipped') logger.result.add(rjcode, result, counts[result]);
      })
    );
  } catch (err) {
    logger.main.error(` ! Failed while processing work folders in parallel: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  return counts;
}

/**
 * 执行扫描
 * createCoverFolder => createSchema => cleanup => getAllFolderList => processAllFolder
 */
async function performScan() {
  if (!fs.existsSync(config.coverFolderDir)) {
    try {
      fs.mkdirSync(config.coverFolderDir, { recursive: true });
    } catch (err) {
      logger.main.error(` ! Failed to create the work-cover image directory: ${err.message}`);
      process.exit(1);
    }
  }

  await tryCreateDatabase();
  await tryCreateAdminUser();

  const fixVADatabaseSuccess = await fixVADatabase();
  await tryCleanupStage();

  const folderList = await tryScanRootFolders();
  const result = await tryProcessFolderListParallel(folderList);

  const message = result.updated
    ? `Scan complete: updated ${result.updated}, added ${result.added}, skipped ${result.skipped}, failed ${result.failed}.`
    : `Scan complete: added ${result.added}, skipped ${result.skipped}, failed ${result.failed}.`;
  logger.finish(message);

  db.knex.destroy();
  if (!fixVADatabaseSuccess) {
    process.exit(1);
  }
  process.exit(0);
}

/**
 * 更新音声的动态元数据
 * @param {number} id work id
 * @param {options = {}} options includeVA, includeTags
 */
async function updateMetadata(id, options = {}) {
  let scrapeProcessor = () => scrapeDynamicWorkMetadataFromDLsite(id);
  if (options.includeVA || options.includeTags || options.includeNSFW || options.refreshAll) {
    // static + dynamic
    scrapeProcessor = () => scrapeWorkMetadata(id, config.tagLanguage);
  }

  const rjcode = String(id);
  logger.task.add(rjcode); // logger.task.add only accepts a string

  try {
    const metadata = await scrapeProcessor(); // 抓取该音声的元数据
    // 将抓取到的元数据插入到数据库
    logger.task.log(rjcode, 'Metadata fetched successfully. Preparing to update it...');
    metadata.id = id;

    await db.updateWorkMetadata(metadata, options);
    logger.task.log(rjcode, 'Metadata updated successfully.');

    const missingCoverTypes = getMissingCoverTypes(id);
    if (missingCoverTypes.length) {
      fs.mkdirSync(config.coverFolderDir, { recursive: true });
      logger.task.log(rjcode, 'Downloading missing cover images...');
      const coverResult = await getCoverImage(id, missingCoverTypes);
      if (coverResult === 'failed') {
        logger.task.warn(rjcode, 'Some cover images could not be downloaded.');
      }
    }
    return 'updated';
  } catch (err) {
    logger.task.error(rjcode, `Failed to fetch metadata: ${err}`);
    console.error(err.stack);
    return 'failed';
  }
}

const updateMetadataLimited = (id, options = null) => limitP.call(updateMetadata, id, options);
const updateVoiceActorLimited = id => limitP.call(updateMetadata, id, { includeVA: true });

// eslint-disable-next-line no-unused-vars
async function performUpdate(options = null, workId = null) {
  let baseQuery = db.knex('t_work').select('id');
  if (workId) {
    baseQuery = baseQuery.where('id', workId);
  }
  const processor = id => updateMetadataLimited(id, options);

  const counts = await refreshWorks(baseQuery, 'id', processor);

  logger.finish(`Metadata refresh complete: updated ${counts.updated}, failed ${counts.failed}.`);
  db.knex.destroy();
  if (counts.failed) process.exit(1);
}

async function fixVoiceActorBug() {
  const baseQuery = db.knex('r_va_work').select('va_id', 'work_id');
  const filter = query => query.where('va_id', nameToUUID('かの仔')).orWhere('va_id', nameToUUID('こっこ'));
  const processor = id => updateVoiceActorLimited(id);
  return await refreshWorks(filter(baseQuery), 'work_id', processor);
}

async function refreshWorks(query, idColumnName, processor) {
  return query.then(async works => {
    logger.main.info(`Refreshing metadata for ${works.length} work(s).`);

    const counts = { updated: 0, failed: 0 };

    await Promise.all(
      works.map(async work => {
        const workid = work[idColumnName];
        const rjcode = workid;

        const result = (await processor(workid)) === 'failed' ? 'failed' : 'updated';

        counts[result]++;
        logger.task.remove(rjcode, result);
        logger.result.add(rjcode, result, counts[result]);
      })
    );

    logger.main.log(`Metadata refresh complete: updated ${counts.updated}, failed ${counts.failed}.`);
    return counts;
  });
}

// 扫描一个作品的文件夹中的文件信息
// 例如音频时长、是否包含歌词文件等
async function scanWorkFile(work) {
  logger.task.add(work.id);
  logger.task.info(work.id, `Scanning work folder: "${work.dir}"`);

  const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
  if (!rootFolder) return 'skipped';

  const absoluteWorkDir = path.join(rootFolder.path, work.dir);
  const localMemo = work.memo ? JSON.parse(work.memo) : {};

  return getWorkMemo(work.id, absoluteWorkDir, localMemo).then(result => {
    return result.replace('added', 'updated');
  });
}
const scanWorkFileLimited = work => limitP.call(scanWorkFile, work);
async function scanWorkFiles(query) {
  return query.then(async works => {
    logger.main.info(`Scanning local files for ${works.length} work(s).`);

    const counts = { updated: 0, skipped: 0, failed: 0 };

    await Promise.all(
      works.map(async work => {
        const result = await scanWorkFileLimited(work);

        counts[result]++;
        logger.task.remove(work.id, result);
        logger.result.add(work.id, result, counts[result]);
      })
    );

    logger.main.log(`Local file update complete: updated ${counts.updated}, skipped ${counts.skipped}, failed ${counts.failed}.`);
    return counts;
  });
}
async function performModify() {
  const baseQuery = db.knex('t_work').select('id', 'root_folder', 'dir', 'memo');

  const counts = await scanWorkFiles(baseQuery);

  logger.finish(`Local file scan complete: updated ${counts.updated}, skipped ${counts.skipped}, failed ${counts.failed}.`);
  db.knex.destroy();
  if (counts.failed) process.exit(1);
  process.exit(0);
}

module.exports = { performScan, performUpdate, performModify };
