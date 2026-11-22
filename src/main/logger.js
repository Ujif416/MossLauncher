'use strict';

/**
 * logger.js — writes diagnostic output to <userData>/logs/launcher.log.
 *
 * Renderer console messages, failed loads and crashed renderers never reach
 * the terminal once the app is packaged, so they are persisted here. The file
 * is rotated once it grows past a few megabytes.
 */

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../shared/constants');
const { ensureDir } = require('./storage');
const errors = require('./errors');

const MAX_BYTES = 4 * 1024 * 1024;
let logFile = null;

function file() {
  if (logFile) return logFile;
  ensureDir(PATHS.logsDir);
  logFile = path.join(PATHS.logsDir, 'launcher.log');
  try {
    if (fs.statSync(logFile).size > MAX_BYTES) {
      fs.renameSync(logFile, logFile + '.1');
    }
  } catch {}
  return logFile;
}

function write(level, scope, message) {
  const line = `${new Date().toISOString()} [${level}] ${scope}: ${message}\n`;
  try {
    fs.appendFileSync(file(), line, 'utf8');
  } catch {}
  if (level === 'error' || level === 'warn') {
    errors.push({ scope, message, kind: level === 'error' ? 'error' : 'warning' });
  }
}

const log = {
  info: (scope, msg) => write('info', scope, msg),
  warn: (scope, msg) => write('warn', scope, msg),
  error: (scope, msg) => write('error', scope, msg),
  file,
};

/** Pipe every renderer diagnostic into the log file. */
function attachWindow(win) {
  const wc = win.webContents;

  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (level && typeof level === 'object') ({ level, message, lineNumber: line, sourceId } = level);
    write(level === 3 || level === 'error' ? 'error' : 'info', 'renderer', `${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
  });

  wc.on('did-fail-load', (_e, code, desc, url) => {
    write('error', 'renderer', `did-fail-load ${code} ${desc} ${url}`);
  });

  wc.on('render-process-gone', (_e, details) => {
    write('error', 'renderer', `process gone: ${details.reason} (exit ${details.exitCode})`);
  });

  wc.on('preload-error', (_e, preloadPath, error) => {
    write('error', 'preload', `${preloadPath}: ${error.stack || error.message}`);
  });
}

module.exports = { log, attachWindow };
