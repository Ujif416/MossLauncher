'use strict';

/**
 * settings.js — launcher settings: game dir, RAM, java path, API keys.
 * Stored in <userData>/config.json.
 */

const { JsonStore } = require('./storage');
const { PATHS, DEFAULTS } = require('../shared/constants');

const store = new JsonStore(PATHS.config, DEFAULTS);

function getSettings() {
  return { ...store.data };
}

function setSettings(patch) {
  store.patch(patch);
  return getSettings();
}

function resetSettings() {
  store._data = { ...DEFAULTS };
  store.save();
  return getSettings();
}

module.exports = { getSettings, setSettings, resetSettings };
