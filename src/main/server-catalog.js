'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const remote = require('./server-download');
const bundled = require('../shared/server-catalog.json');
const REPOSITORY = 'Ujif416/Create-Aeronautics-Skybound';
const CATALOG_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/launcher/servers.json`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
function serverId(id) {
  check(typeof id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(id), 'Некорректный ID сервера');
  return id;
}
function safePath(value) {
  check(typeof value === 'string' && value.length <= 230 && value.includes('/'), 'Некорректный путь сборки');
  const parts = value.split('/');
  check(['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks'].includes(parts[0]), 'Недопустимая папка сборки');
  check(parts.every(p => p && p !== '.' && p !== '..' && !/[\\<>:"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), 'Небезопасный путь сборки');
  return value;
}
function validateCatalog(data) {
  check(data?.schemaVersion === 1 && Array.isArray(data.servers) && data.servers.length <= 32, 'Неизвестный формат каталога серверов');
  const ids = new Set();
  for (const s of data.servers) {
    serverId(s.id); check(!ids.has(s.id), 'Повторяющийся ID сервера'); ids.add(s.id);
    check(typeof s.name === 'string' && s.name.length > 0 && s.name.length < 120, 'Не указано имя сервера');
    check(typeof s.description === 'string' && s.description.length <= 600, 'Некорректное описание сервера');
    check(typeof s.address?.host === 'string' && /^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(s.address.host), 'Некорректный адрес сервера');
    check(Number.isInteger(s.address.port) && s.address.port > 0 && s.address.port <= 65535, 'Некорректный порт');
    // This catalog currently supports the tested Minecraft 1.21.1 / NeoForge runtime.
    check(s.minecraft === '1.21.1' && s.loader?.type === 'neoforge' && /^21\.1\.\d+$/.test(s.loader.version) && s.java === 21, 'Неподдерживаемая версия игры или загрузчика в каталоге');
    check(s.pack?.repository === REPOSITORY && /^[a-f0-9]{40}$/.test(s.pack.commit) && /^[a-f0-9]{64}$/.test(s.pack.indexSha256), 'Некорректный источник сборки');
    check(Array.isArray(s.pack.exclude || []) && (s.pack.exclude || []).length <= 100, 'Некорректные исключения сборки');
    const excluded = new Set();
    for (const f of s.pack.exclude || []) {
      safePath(f.path);
      check(/^mods\/[^/]+\.jar$/.test(f.path) && /^[a-f0-9]{64}$/.test(f.sha256) && !excluded.has(f.path), 'Некорректное исключение мода');
      excluded.add(f.path);
    }
    check(typeof s.packRevision === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(s.packRevision), 'Некорректная ревизия сборки');
  }
  return data;
}
function validateIndex(data, server) {
  check(data?.minecraft === server.minecraft && data.loader === server.loader.type && Array.isArray(data.files) && data.files.length > 0 && data.files.length <= 20000, 'Сборка не соответствует серверу');
  const names = new Set(); let total = 0;
  for (const f of data.files) {
    safePath(f.path);
    check(!names.has(f.path.toLowerCase()), 'Повторяющийся путь в сборке'); names.add(f.path.toLowerCase());
    check(Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= 1024 ** 3 && /^[a-f0-9]{64}$/.test(f.sha256), 'Некорректный размер или SHA-256 файла');
    total += f.size;
  }
  check(total <= 20 * 1024 ** 3, 'Сборка превышает допустимый размер');
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { check(!names.has(parts.join('/')), 'Файл перекрывает папку сборки'); parts.pop(); }
  }
  const excluded = new Set();
  for (const f of server.pack.exclude || []) {
    check(data.files.some(actual => actual.path === f.path && actual.sha256 === f.sha256), 'Исключение мода не соответствует зафиксированной сборке');
    excluded.add(f.path);
  }
  return data.files.filter(f => !excluded.has(f.path)).map(f => ({ path: f.path, size: f.size, sha256: f.sha256 }));
}
function fileUrl(server, file = 'pack-index.json') {
  return `https://raw.githubusercontent.com/${REPOSITORY}/${server.pack.commit}/${file === 'pack-index.json' ? file : 'pack/' + file.split('/').map(encodeURIComponent).join('/')}`;
}
let current = validateCatalog(bundled), inflight;
async function refresh(cacheFile) {
  if (inflight) return inflight;
  inflight = remote.read(CATALOG_URL, { maxBytes: 128 * 1024, signal: AbortSignal.timeout(45000), validate: bytes => validateCatalog(JSON.parse(bytes)) }).then(bytes => {
    current = validateCatalog(JSON.parse(bytes));
    if (cacheFile) {
      try { noLinks(cacheFile); noLinks(cacheFile + '.tmp'); fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile + '.tmp', bytes); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch { /* A read-only cache does not prevent launching. */ }
    }
    return { catalog: current, warning: '' };
  }).catch(error => {
    if (cacheFile) {
      try { noLinks(cacheFile); if (fs.statSync(cacheFile).size <= 128 * 1024) current = validateCatalog(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))); } catch { /* Keep the validated bundled/in-memory catalog. */ }
    }
    return { catalog: current, error: require('./errors').describe(error).message, warning: 'Источники каталога недоступны. Используется сохранённая конфигурация сервера.' };
  }).finally(() => { inflight = null; });
  return inflight;
}
function get(id) { serverId(id); const s = current.servers.find(s => s.id === id); check(s, 'Сервер не найден в каталоге'); return s; }
async function index(server, signal, cacheFile) {
  if (cacheFile) {
    noLinks(cacheFile);
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size <= 8 * 1024 ** 2) {
      const cached = fs.readFileSync(cacheFile);
      if (hash(cached) === server.pack.indexSha256) return validateIndex(JSON.parse(cached), server);
    }
  }
  const bytes = await remote.read(fileUrl(server), { maxBytes: 8 * 1024 * 1024, signal,
    validate: data => check(hash(data) === server.pack.indexSha256, 'Контрольная сумма списка файлов не совпала') });
  const files = validateIndex(JSON.parse(bytes), server);
  if (cacheFile) { noLinks(cacheFile + '.tmp'); fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile + '.tmp', bytes); fs.renameSync(cacheFile + '.tmp', cacheFile); }
  return files;
}
function paths(gameDir, id) {
  const root = path.join(gameDir, 'servers', serverId(id));
  return { root, game: path.join(root, 'game'), runtime: path.join(root, 'runtime'), transaction: path.join(root, 'transaction'), state: path.join(root, 'installed.json') };
}
// Refuse junctions/symlinks in managed paths, including an existing parent of the root.
function noLinks(target) {
  let p = path.resolve(target);
  while (true) {
    try { check(!fs.lstatSync(p).isSymbolicLink(), 'Ссылки и junction в папке сервера не поддерживаются'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(p); if (parent === p) break; p = parent;
  }
  return target;
}
module.exports = { refresh, get, index, paths, noLinks, safePath, serverId, validateCatalog, validateIndex, fileUrl, hash, CATALOG_URL };
