'use strict';

/**
 * storage.js — tiny JSON-file persistence layer.
 * One file per domain (config.json, accounts.json). Atomic-ish writes via
 * temp file + rename so a crash mid-write never corrupts settings.
 */

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * JsonStore — wraps a single JSON file.
 * Exposes get/set/patch over a plain object.
 */
class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this._data = null;
  }

  get data() {
    if (this._data === null) {
      const loaded = readJson(this.file, {});
      this._data = { ...this.defaults, ...loaded };
    }
    return this._data;
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
  }

  save() {
    writeJson(this.file, this._data);
  }
}

module.exports = { JsonStore, ensureDir, readJson, writeJson };
