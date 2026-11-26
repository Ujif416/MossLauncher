'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const PREFIX = '/Ujif416/Create-Aeronautics-Skybound/';
const GITHUB = 'https://raw.githubusercontent.com' + PREFIX;
const MIRROR = 'https://s3.twcstorage.ru/16ea7843-721c-40d2-8233-7e888b857134/';
let preferMirror = false;

function allowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || !(u.href.startsWith(GITHUB) || u.href.startsWith(MIRROR))) throw new Error('Источник файла не разрешён');
  return u;
}
function attempt(url, { signal, family } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(allowed(url), { signal, family, headers: { 'User-Agent': 'MossLauncher' } }, res => {
      clearTimeout(connectTimer);
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${new URL(url).host}: HTTP ${res.statusCode}`)); return; }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Сервер не ответил вовремя')));
    const connectTimer = setTimeout(() => req.destroy(Object.assign(new Error('Истекло время подключения'), { code: 'ETIMEDOUT' })), 6000);
    req.on('error', e => { clearTimeout(connectTimer); reject(e); });
  });
}
async function response(url, options = {}) {
  try { return await attempt(url, options); }
  catch (first) {
    if (!options.signal?.aborted && /ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET/.test(first.code || '')) {
      try { return await attempt(url, { ...options, family: 4 }); } catch (second) { first = second; }
    }
    throw Object.assign(new Error(`Запрос ${url}: ${require('./errors').describe(first).message}`, { cause: first }), { code: first.code });
  }
}
async function readOne(url, { maxBytes, signal } = {}) {
  const res = await response(url, { signal }), chunks = []; let size = 0;
  try {
    for await (const b of res) { size += b.length; if (size > maxBytes) throw new Error('Слишком большой ответ сервера'); chunks.push(b); }
    return Buffer.concat(chunks);
  } finally { res.destroy(); }
}
async function fileOne(url, dest, expected, { signal, onBytes = () => {} } = {}) {
  const part = dest + '.part'; let received = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const digest = crypto.createHash('sha256');
  try {
    const res = await response(url, { signal });
    const meter = new Transform({ transform(chunk, _enc, done) {
      received += chunk.length;
      if (received > expected.size) return done(new Error('Размер файла не соответствует списку сборки'));
      digest.update(chunk); onBytes(received); done(null, chunk);
    } });
    await pipeline(res, meter, fs.createWriteStream(part, { flags: 'wx' }), { signal });
    if (received !== expected.size || digest.digest('hex') !== expected.sha256) throw new Error('Файл повреждён: ' + expected.path);
    fs.renameSync(part, dest);
  } finally { try { fs.unlinkSync(part); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
async function withSources(url, expected, signal, run) {
  const source = allowed(url).href;
  if (!source.startsWith(GITHUB)) return run(source);
  const suffix = source.slice(GITHUB.length);
  let key;
  if (suffix === 'main/launcher/servers.json') key = 'launcher/servers.json';
  else if (/^[a-f0-9]{40}\/pack-index\.json$/.test(suffix)) key = suffix;
  else if (expected && /^[a-f0-9]{64}$/.test(expected.sha256)) key = 'objects/' + expected.sha256;
  else return run(source);

  const mirror = MIRROR + key;
  const mirrorFirst = preferMirror && key !== 'launcher/servers.json';
  const errors = [];
  for (const candidate of mirrorFirst ? [mirror, source] : [source, mirror]) {
    signal?.throwIfAborted();
    try {
      const result = await run(candidate);
      preferMirror = candidate === mirror;
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(candidate + ' — ' + error.message);
    }
  }
  throw new Error(errors.join(' | '));
}

function read(url, options) {
  return withSources(url, null, options.signal, async candidate => {
    const bytes = await readOne(candidate, options);
    options.validate?.(bytes);
    return bytes;
  });
}

function file(url, dest, expected, options = {}) {
  return withSources(url, expected, options.signal, candidate => fileOne(candidate, dest, expected, options));
}

module.exports = { allowed, read, file };
