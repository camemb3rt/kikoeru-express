const _ = require('lodash'); 
const express = require('express');
const router = express.Router();
const { config, setConfig, sharedConfigHandle } = require('../config');

const filterConfig = (_config, option = 'read') => {
  const currentConfig = config;
  const configClone = _.cloneDeep(_config);
  delete configClone.md5secret;
  delete configClone.jwtsecret;
  if (option === 'write') {
    delete configClone.production;
    if (process.env.NODE_ENV === 'production' || currentConfig.production) {
      delete configClone.auth;
    }
  }
  return configClone;
}

// 修改配置文件
router.put('/admin', (req, res, next) => {
  if (!config.auth || req.user.name === 'admin') {
    try {
      // Note: setConfig uses Object.assign to merge new configs
      setConfig(filterConfig(req.body.config, 'write'));
      res.send({ message: 'Saved successfully.' })
    } catch(err) {
      next(err);
    }
  } else {
    res.status(403).send({ error: 'Only the admin account can change the configuration.' });
  }
});

// 获取配置文件
router.get('/admin', (req, res, next) => {
  if (!config.auth || req.user.name === 'admin') {
    try {
      res.send({ config: filterConfig(config, 'read') });
    } catch(err) {
      next(err);
    }
  } else {
    res.status(403).send({ error: 'Only the admin account can view the configuration.' });
  }
});

router.get('/shared', (req, res, next) => {
  try {
    res.send({ sharedConfig: sharedConfigHandle.export() });
  } catch(err) {
    next(err);
  }
});

module.exports = router;
