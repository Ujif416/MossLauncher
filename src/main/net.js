'use strict';

/**
 * net.js — HTTP layer: JSON fetching, file downloads with progress + retries,
 * parallel download pool. Uses Node's https module (no extra deps beyond
 * node-fetch for convenience where redirects matter).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { ensureDir } = require('./storage');
const { GAME } = require('../shared/constants');

const UA = 'MossLauncher/1.0 (+https://github.com/mosslauncher)';

/**
 * Зеркала для хостов, которые у части провайдеров недоступны.
 * maven.neoforged.net часто режется (таймаут на connect), а без него
 * установщик NeoForge не может создать патченный клиент.
 * Целостность гарантируется проверкой sha1 из профиля.
 */
const MIRRORS = [
  { prefix: 'https://maven.neoforged.net/releases/', alts: ['https://neoforged.forgecdn.net/releases/', 'https://maven.creeperhost.net/'] },
  { prefix: 'https://maven.neoforged.net/', alts: ['https://neoforged.forgecdn.net/'] },
];
// host → время, до которого хост считается недоступным
const hostDownUntil = new Map();
const HOST_DOWN_MS = 10 * 60 * 1000;

function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
function isHostDown(u) { return (hostDownUntil.get(hostOf(u)) || 0) > Date.now(); }
function markHostDown(u) { hostDownUntil.set(hostOf(u), Date.now() + HOST_DOWN_MS); }

/** Список URL для попыток: оригинал + зеркала; недоступные хосты — в конец. */
function candidateUrls(urlStr) {
  const list = [urlStr];
  const rule = MIRRORS.find((m) => urlStr.startsWith(m.prefix));
  if (rule) for (const alt of rule.alts) list.push(alt + urlStr.slice(rule.prefix.length));
  return [...list.filter((u) => !isHostDown(u)), ...list.filter(isHostDown)];
}

/** Ошибка соединения (а не ответ сервера) — повод пометить хост недоступным. */
function isConnectError(e) {
  return !!e && (/timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EACCES|socket hang up|ENOTFOUND|EAI_AGAIN/i.test(e.message || '') ||
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EACCES|ENOTFOUND|EAI_AGAIN)$/.test(e.code || ''));
}

/** Пробует fn(url) по всем кандидатам, возвращает первый успех. */
async function withMirrors(urlStr, fn) {
  const urls = candidateUrls(urlStr);
  let lastErr;
  for (const u of urls) {
    try { return await fn(u); } catch (e) {
      lastErr = e;
      if (isConnectError(e)) markHostDown(u);
      if (urls.length === 1) break;
    }
  }
  throw lastErr;
}

function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 30000, redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(urlStr); } catch (e) { return reject(new Error('Bad URL: ' + urlStr)); }
    const lib = urlObj.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: { 'User-Agent': UA, ...headers },
        timeout,
      },
      (res) => {
        // Redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= 5) { res.resume(); return reject(new Error('Too many redirects')); }
          const next = new URL(res.headers.location, urlStr).toString();
          res.resume();
          return resolve(request(next, { method: method === 'POST' && res.statusCode !== 307 && res.statusCode !== 308 ? 'GET' : method, headers, body, timeout, redirectCount: redirectCount + 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(urlStr, opts = {}) {
  const once = async (u) => {
    const res = await request(u, opts);
    if (res.status < 200 || res.status >= 300) {
      const text = res.body.toString('utf8').slice(0, 400);
      const err = new Error(`HTTP ${res.status} for ${u}`);
      err.status = res.status; err.body = text;
      throw err;
    }
    return JSON.parse(res.body.toString('utf8'));
  };
  // POST и прочие не-GET запросы не переадресуем на зеркала
  if (opts.method && opts.method !== 'GET') return once(urlStr);
  return withMirrors(urlStr, once);
}

function sha1File(file, algorithm = 'sha1') {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) return resolve(null);
    const h = crypto.createHash(algorithm);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Download a file to disk. Verifies size and sha1 when given.
 * Skips download when file exists and matches.
 */
const activeDownloads = new Map();
function downloadFile(urlStr, dest, options = {}) {
  const key = path.resolve(dest).toLowerCase();
  const previous = activeDownloads.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => withMirrors(urlStr, (u) => downloadFileOnce(u, dest, options)));
  activeDownloads.set(key, task);
  task.finally(() => { if (activeDownloads.get(key) === task) activeDownloads.delete(key); }).catch(() => {});
  return task;
}
async function downloadFileOnce(urlStr, dest, { size = null, sha1 = null, sha256 = null, timeout = 60000, onProgress = null } = {}) {
  const expected = sha256 || sha1;
  const algorithm = sha256 ? 'sha256' : 'sha1';
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest) && (size === null || fs.statSync(dest).size === size)) {
    if (!expected || (await sha1File(dest, algorithm)) === expected) return { file: dest, skipped: true };
  }
  const tmp = dest + '.' + crypto.randomUUID() + '.part';
  try {
  await new Promise((resolve, reject) => {
    const doGet = (u, redirects) => {
      const urlObj = new URL(u);
      const lib = urlObj.protocol === 'http:' ? http : https;
      const req = lib.get(
        { hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443), path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': UA }, timeout },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (redirects > 5) return reject(new Error('Too many redirects'));
            return doGet(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
          if (onProgress) {
            const total = Number(res.headers['content-length']) || Number(size) || 0;
            let done = 0, lastReport = 0;
            const report = () => {
              lastReport = Date.now();
              try { onProgress({ done, total, unit: 'bytes' }); } catch {}
            };
            report();
            res.on('data', chunk => {
              done += chunk.length;
              if (Date.now() - lastReport >= 100) report();
            });
            res.on('end', report);
          }
          const out = fs.createWriteStream(tmp);
          require('stream').pipeline(res, out, (error) => error ? reject(error) : resolve());
        }
      );
      req.on('timeout', () => req.destroy(new Error('Download timeout: ' + u)));
      req.on('error', reject);
    };
    doGet(urlStr, 0);
  });
  if (size !== null && fs.statSync(tmp).size !== size) throw new Error('Размер файла не совпадает: ' + path.basename(dest));
  if (expected) {
    const actual = await sha1File(tmp, algorithm);
    if (actual !== expected) { fs.unlinkSync(tmp); throw new Error(`${algorithm} mismatch for ${path.basename(dest)}`); }
  }
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(tmp, dest);
  return { file: dest, skipped: false };
  } finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * Download a list of {url, dest, size, sha1} items with a concurrency pool.
 * Calls onProgress({done, total, item}) after each file.
 */
async function downloadAll(items, { concurrency = GAME.downloadConcurrency, retries = GAME.downloadRetries, onProgress = null } = {}) {
  let done = 0;
  const total = items.length;
  const errors = [];
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await downloadFile(item.url, item.dest, item);
          lastErr = null; break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) { errors.push({ item, error: lastErr.message }); }
      done++;
      if (onProgress) { try { onProgress({ done, total, item, ok: !lastErr }); } catch {} }
    }
  });
  await Promise.all(workers);
  return { done, total, errors };
}

module.exports = { request, fetchJson, downloadFile, downloadAll, sha1File, UA, candidateUrls };
