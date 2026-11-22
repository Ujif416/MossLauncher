'use strict';

/**
 * modpack-sync.js — загрузка сборок из GitHub, CurseForge и Modrinth.
 *
 * Источники:
 * - GitHub: tarball через codeload (github-sync.js), точная синхронизация по sha256.
 * - CurseForge: zip по прямой ссылке ForgeCDN (edge.forgecdn.net) — API-ключ не нужен.
 *   Внутри zip — overrides (файлы) + manifest.json со списком модов; моды
 *   скачиваются из ForgeCDN по их fileID параллельным пулом.
 * - Modrinth: .mrpack — zip с index.json (список файлов с URL) + overrides.
 *
 * Все сборки синхронизируются в <gameDir>/modpacks/<name>/ и ведут манифест
 * .moss-pack.json с sha256 — обновления пишут только изменившиеся файлы.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { API, PATHS, GAME } = require('../shared/constants');
const { fetchJson, downloadFile } = require('./net');
const { ensureDir, readJson, writeJson } = require('./storage');
const ghSync = require('./github-sync');
const AdmZip = require('adm-zip');

function sha256Buf(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

function sha1Buf(b) {
  return crypto.createHash('sha1').update(b).digest('hex');
}

// ---------------------------------------------------------------- parse

/**
 * Разбор ввода пользователя:
 *  - github: "owner/repo", "owner/repo:branch", ссылка github.com
 *  - curseforge: ссылка curseforge.com/minecraft/modpacks/<slug>[/files/<id>], "cf:<slug>[/fileId]", числовой id
 *  - modrinth: ссылка modrinth.com/modpack/<slug>[/version/<id>], "mr:<slug>[/versionId]"
 */
function parseSource(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Пустая ссылка на сборку');

  // Адресные ссылки — проверяем хост раньше остальных правил,
  // иначе "curseforge.com/..." попадёт под шаблон owner/repo.
  const cfMatch = raw.match(/curseforge\.com\/minecraft\/modpacks\/([\w-]+)(?:\/files\/(\d+))?/);
  if (cfMatch) return { source: 'curseforge', slug: cfMatch[1], fileId: cfMatch[2] || '' };

  const mrMatch = raw.match(/modrinth\.com\/modpack\/([\w-]+)(?:\/version\/([\w.-]+))?/);
  if (mrMatch) return { source: 'modrinth', slug: mrMatch[1], versionId: mrMatch[2] || '' };

  const ghMatch = raw.match(/github\.com\/([^/]+)\/([^/?#\s]+)(?:\/tree\/([^/?#\s]+)(?:\/([^?#\s]+))?)?/);
  if (ghMatch) return { source: 'github', raw };

  if (/^cf:/.test(raw)) {
    const p = raw.slice(3).split('/');
    return { source: 'curseforge', slug: p[0], fileId: p[1] || '' };
  }
  if (/^mr:/.test(raw)) {
    const p = raw.slice(3).split('/');
    return { source: 'modrinth', slug: p[0], versionId: p[1] || '' };
  }
  if (/^\d+$/.test(raw)) return { source: 'curseforge', slug: raw, fileId: '' };
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return { source: 'github', raw };

  throw new Error('Неверный формат. Поддерживаются: GitHub (owner/repo или ссылка), CurseForge (ссылка на modpack или cf:slug), Modrinth (ссылка на modpack или mr:slug)');
}

// ---------------------------------------------------------------- files sync

/**
 * Синхронизация набора файлов {relpath -> Buffer} с целевой папкой по sha256.
 * Удаляет файлы, которых нет в наборе (кроме защищённых из protect).
 */
function syncFiles(targetDir, files, meta, { protect = [], onProgress = () => {} } = {}) {
  ensureDir(targetDir);
  const manifestPath = path.join(targetDir, '.moss-pack.json');
  const prev = readJson(manifestPath, { files: {} });
  const protectedSet = new Set(protect);

  onProgress({ stage: 'sync', done: 0, total: files.size, message: `Синхронизация ${files.size} файлов…` });

  const nextFiles = {};
  let written = 0, removed = 0, kept = 0, done = 0;
  for (const [rel, buf] of files) {
    done++;
    const hash = sha256Buf(buf);
    nextFiles[rel] = { hash, size: buf.length };
    const dest = path.join(targetDir, rel);
    const needsWrite = !prev.files[rel] || prev.files[rel].hash !== hash || !fs.existsSync(dest);
    if (needsWrite) {
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      written++;
    } else kept++;
    if (done % 20 === 0 || done === files.size) onProgress({ stage: 'sync', done, total: files.size, message: `Файлы: ${done}/${files.size}` });
  }
  for (const rel of Object.keys(prev.files)) {
    if (!nextFiles[rel] && !protectedSet.has(rel)) {
      const p = path.join(targetDir, rel);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed++; }
    }
  }

  writeJson(manifestPath, { ...meta, syncedAt: Date.now(), files: nextFiles });
  return { written, removed, kept, total: files.size };
}

// ---------------------------------------------------------------- CurseForge

/**
 * Скачивание файла CF по fileID с CDN Forge.
 * Метаданные берутся из cfwidget (без ключа).
 */
async function cfWidgetModpack(slugOrId) {
  const key = String(slugOrId);
  const url = /^\d+$/.test(key) ? `${API.cfwidget}/${key}` : `${API.cfwidget}/minecraft/modpacks/${encodeURIComponent(key)}`;
  return fetchJson(url);
}

function cfCdnUrl(fileId, fileName) {
  const d = Math.floor(fileId / 1000);
  const m = fileId % 1000;
  return `https://edge.forgecdn.net/files/${d}/${m}/${encodeURIComponent(fileName)}`;
}

/**
 * Узнаёт имена файлов по {projectID,fileID} без API-ключа.
 *
 * Основной путь — cfwidget: один запрос на проект отдаёт все файлы сразу.
 * Website-endpoint `www.curseforge.com/api/v1/mods/<pid>/files/<fid>` теперь
 * закрыт Cloudflare (403), поэтому он остаётся лишь запасным вариантом.
 *
 * Возвращает Map: `${projectID}:${fileID}` -> fileName | null
 */
const cfWidgetCache = new Map(); // projectID -> cfwidget JSON

async function cfWidgetFor(projectID) {
  if (!cfWidgetCache.has(projectID)) {
    try {
      cfWidgetCache.set(projectID, await fetchJson(`${API.cfwidget}/${projectID}`));
    } catch (e) {
      cfWidgetCache.set(projectID, { id: projectID, files: [], error: e.message });
    }
  }
  return cfWidgetCache.get(projectID);
}

async function cfFileNames(items) {
  const result = new Map();
  const queue = items.slice();

  const resolveOne = async ({ projectID, fileID }) => {
    const key = `${projectID}:${fileID}`;
    const w = await cfWidgetFor(projectID);
    const hit = (w.files || []).find((f) => Number(f.id) === Number(fileID));
    if (hit) { result.set(key, hit.name); return; }
    try {
      const res = await fetchJson(`https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}`);
      if (res && res.data && res.data.fileName) { result.set(key, res.data.fileName); return; }
    } catch { /* пропускаем — файл останется неразрешённым */ }
    result.set(key, null);
  };

  const workers = Array.from({ length: Math.min(GAME.downloadConcurrency, queue.length) }, async () => {
    while (queue.length) await resolveOne(queue.shift());
  });
  await Promise.all(workers);
  return result;
}

/** id лоадера из манифеста CF: "forge-47.2.0", "fabric-0.16.9", "neoforge-21.1.80". */
function parseLoaderId(raw) {
  const s = String(raw || '').toLowerCase().trim();
  const m = s.match(/^(forge|fabric|quilt|neoforge)-(.+)$/);
  if (m) return { loader: m[1], loaderVersion: m[2] };
  return { loader: '', loaderVersion: '' };
}

async function syncCurseForge({ slug, fileId, targetName, settings, onProgress }) {
  onProgress({ stage: 'resolve', message: 'Получение информации о сборке CurseForge…' });
  const widget = await cfWidgetModpack(slug);
  const packName = targetName || widget.title || slug;

  const files = widget.files || [];
  let file;
  if (fileId) {
    file = files.find((f) => String(f.id) === String(fileId));
    if (!file) throw new Error(`Файл ${fileId} не найден в сборке ${slug}`);
  } else {
    file = files.find((f) => f.type === 'release') || files[0];
    if (!file) throw new Error('Нет доступных файлов для этой сборки');
  }

  onProgress({ stage: 'download', message: `Скачивание ${file.name || file.display}…` });
  const zipPath = path.join(PATHS.cacheDir, `cfpack-${crypto.randomUUID()}.zip`);
  await downloadFile(cfCdnUrl(file.id, file.name), zipPath, {
    size: file.filesize, timeout: 600000,
    onProgress: (p) => onProgress({ ...p, stage: 'download', message: `Скачивание ${file.name || file.display}…` }),
  });

  onProgress({ stage: 'extract', message: 'Распаковка сборки…' });
  const zip = new AdmZip(zipPath);
  const targetDir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', packName);

  // Читаем манифест (может быть в корне или в подпапке архива)
  let manifestEntry = zip.getEntry('manifest.json');
  let overridesPrefix = 'overrides/';
  if (!manifestEntry) {
    for (const e of zip.getEntries()) {
      const parts = e.entryName.split('/');
      if (!e.isDirectory && parts.length === 2 && parts[1] === 'manifest.json') {
        manifestEntry = e;
        overridesPrefix = parts[0] + '/overrides/';
        break;
      }
    }
  }

  const manifest = manifestEntry ? JSON.parse(manifestEntry.getData().toString('utf8')) : null;
  const modList = manifest && Array.isArray(manifest.files) ? manifest.files : [];

  // Собираем overrides-файлы
  const fileMap = new Map();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (name.startsWith(overridesPrefix)) {
      const rel = name.slice(overridesPrefix.length);
      if (rel && !rel.split('/').some((p) => p.startsWith('.'))) {
        fileMap.set(rel.replace(/\//g, path.sep), e.getData());
      }
    }
  }

  // Скачиваем моды из манифеста через ForgeCDN
  if (modList.length) {
    onProgress({ stage: 'resolve', message: `Получение имён ${modList.length} модов…` });
    const nameMap = await cfFileNames(modList);
    onProgress({ stage: 'mods', done: 0, total: modList.length, message: `Скачивание модов: 0/${modList.length}` });

    let done = 0;
    const queue = modList.slice();
    const workers = Array.from({ length: Math.min(GAME.downloadConcurrency, modList.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        const key = `${item.projectID}:${item.fileID}`;
        const fileName = nameMap.get(key);
        if (!fileName) {
          done++;
          onProgress({ stage: 'mods', done, total: modList.length, message: `Пропущен мод ID ${item.projectID} (файл ${item.fileID} не найден)` });
          continue;
        }
        const tmpPath = path.join(PATHS.cacheDir, `cfmod-${item.fileID}-${crypto.randomUUID()}.jar`);
        try {
          const url = cfCdnUrl(item.fileID, fileName);
          await downloadFile(url, tmpPath, { timeout: 180000 });
          fileMap.set(path.join('mods', fileName), fs.readFileSync(tmpPath));
        } catch (e) {
          onProgress({ stage: 'mods', done, total: modList.length, message: `Не удалось скачать ${fileName}: ${e.message}` });
        } finally {
          try { fs.rmSync(tmpPath, { force: true }); } catch {}
        }
        done++;
        onProgress({ stage: 'mods', done, total: modList.length, message: `Скачивание модов: ${done}/${modList.length}` });
      }
    });
    await Promise.all(workers);
  }

  // Версия игры и лоадер из манифеста — нужны для кнопки «Играть».
  const mcInfo = (manifest && manifest.minecraft) || {};
  const loaderRaw = (mcInfo.modLoaders || [])[0] || {};
  const { loader: packLoader, loaderVersion } = parseLoaderId(loaderRaw.id || '');

  const result = syncFiles(targetDir, fileMap, {
    source: 'curseforge', id: widget.id, slug,
    fileId: file.id, version: file.display || file.name,
    gameVersion: mcInfo.version || '',
    loader: packLoader, loaderVersion,
  }, { onProgress });

  try { fs.rmSync(zipPath, { force: true }); } catch {}
  onProgress({ stage: 'done', message: `Готово: ${result.written} новых, ${result.removed} удалено, ${result.kept} без изменений` });
  return { ...result, targetDir, packName };
}

// ---------------------------------------------------------------- Modrinth

async function syncModrinth({ slug, versionId, targetName, settings, onProgress }) {
  onProgress({ stage: 'resolve', message: 'Получение информации о сборке Modrinth…' });
  const project = await fetchJson(`${API.modrinth}/project/${encodeURIComponent(slug)}`);
  const versions = await fetchJson(`${API.modrinth}/project/${encodeURIComponent(slug)}/version`);

  let version;
  if (versionId) {
    version = versions.find((v) => v.id === versionId || v.version_number === versionId);
    if (!version) throw new Error(`Версия ${versionId} не найдена`);
  } else {
    version = versions[0];
    if (!version) throw new Error('Нет доступных версий для этой сборки');
  }

  const packFile = version.files.find((f) => f.primary) || version.files[0];
  if (!packFile) throw new Error('Нет файлов в выбранной версии');

  onProgress({ stage: 'download', message: `Скачивание ${packFile.filename}…` });
  const mrpackPath = path.join(PATHS.cacheDir, `mrpack-${crypto.randomUUID()}.mrpack`);
  await downloadFile(packFile.url, mrpackPath, {
    size: packFile.size, sha1: packFile.hashes && packFile.hashes.sha1, timeout: 600000,
    onProgress: (p) => onProgress({ ...p, stage: 'download', message: `Скачивание ${packFile.filename}…` }),
  });

  onProgress({ stage: 'extract', message: 'Распаковка .mrpack…' });
  const zip = new AdmZip(mrpackPath);
  const targetDir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', targetName || project.title || slug);

  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Это не .mrpack — нет modrinth.index.json');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));

  const fileMap = new Map();
  // overrides
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const e of zip.getEntries()) {
      if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
      const rel = e.entryName.slice(prefix.length);
      if (rel && !rel.split('/').some((p) => p.startsWith('.'))) {
        fileMap.set(rel.replace(/\//g, path.sep), e.getData());
      }
    }
  }

  // Файлы из index (моды, ресурспаки, шейдеры)
  const indexFiles = (index.files || []).filter((f) => !f.env || !f.env.client || f.env.client !== 'unsupported');
  onProgress({ stage: 'mods', done: 0, total: indexFiles.length, message: `Скачивание файлов: 0/${indexFiles.length}` });
  let done = 0;
  const queue = indexFiles.slice();
  const workers = Array.from({ length: Math.min(GAME.downloadConcurrency, indexFiles.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const rel = item.path.replace(/\//g, path.sep);
      try {
        const buf = await downloadToBuffer(item.downloads[0]);
        if (!buf) throw new Error('Пустой ответ');
        if (item.hashes && item.hashes.sha1 && sha1Buf(buf) !== item.hashes.sha1) {
          throw new Error('sha1 mismatch');
        }
        fileMap.set(rel, buf);
      } catch (e) {
        onProgress({ stage: 'mods', done, total: indexFiles.length, message: `Пропущен ${rel}: ${e.message}` });
      }
      done++;
      onProgress({ stage: 'mods', done, total: indexFiles.length, message: `Скачивание файлов: ${done}/${indexFiles.length}` });
    }
  });
  await Promise.all(workers);

  const deps = index.dependencies || {};
  const result = syncFiles(targetDir, fileMap, {
    source: 'modrinth', id: project.id, slug: project.slug,
    versionId: version.id, version: version.version_number,
    gameVersion: deps.minecraft || (version.game_versions || []).find((v) => /^\d+\.\d+/.test(v)) || '',
    loader: deps.fabric_loader ? 'fabric' : deps.quilt_loader ? 'quilt' : deps.neoforge ? 'neoforge' : deps.forge ? 'forge' : '',
    loaderVersion: deps.fabric_loader || deps.quilt_loader || deps.neoforge || deps.forge || '',
  }, { onProgress });

  try { fs.rmSync(mrpackPath, { force: true }); } catch {}
  onProgress({ stage: 'done', message: `Готово: ${result.written} новых, ${result.removed} удалено, ${result.kept} без изменений` });
  return { ...result, targetDir, packName: targetName || project.title || slug };
}

/** Скачивает URL в память (для небольших файлов mrpack). */
function downloadToBuffer(urlStr) {
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');
  return new Promise((resolve, reject) => {
    const doGet = (u, redirects) => {
      const urlObj = new URL(u);
      const lib = urlObj.protocol === 'http:' ? http : https;
      const req = lib.get(
        { hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443), path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': 'MossLauncher/1.0' }, timeout: 60000 },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (redirects > 5) return reject(new Error('Too many redirects'));
            return doGet(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
    };
    doGet(urlStr, 0);
  });
}

// ---------------------------------------------------------------- public

/**
 * Унифицированная синхронизация: принимает ввод пользователя, определяет
 * источник и вызывает нужный обработчик.
 */
async function syncModpack(input, options = {}) {
  const parsed = parseSource(input);
  const { targetName, settings, onProgress = () => {} } = options;

  if (parsed.source === 'github') {
    return ghSync.syncRepo({ repo: parsed.raw, branch: options.branch, subdir: options.subdir, targetName, settings, onProgress });
  }
  if (parsed.source === 'curseforge') {
    return syncCurseForge({ slug: parsed.slug, fileId: parsed.fileId, targetName, settings, onProgress });
  }
  if (parsed.source === 'modrinth') {
    return syncModrinth({ slug: parsed.slug, versionId: parsed.versionId, targetName, settings, onProgress });
  }
  throw new Error('Неизвестный источник сборки');
}

function packStatus(settings, name) {
  const dir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', name);
  const m = readJson(path.join(dir, '.moss-pack.json'), null);
  if (!m) return null;
  const pack = {
    name, dir,
    source: m.source || 'github',
    repo: m.repo || '', slug: m.slug || '', id: m.id || '',
    version: m.version || '', fileId: m.fileId || '', versionId: m.versionId || '',
    branch: m.branch || '', subdir: m.subdir || '',
    gameVersion: m.gameVersion || '', loader: m.loader || '', loaderVersion: m.loaderVersion || '',
    syncedAt: m.syncedAt, files: Object.keys(m.files || {}).length,
  };
  pack.installedVersion = matchInstalledVersion(settings, pack);
  return pack;
}

/**
 * Доступные версии сборки для диалога выбора.
 * CurseForge — cfwidget files; Modrinth — /project/<slug>/version.
 */
async function listPackVersions(source, slugOrId, { limit = 50 } = {}) {
  if (source === 'curseforge') {
    const w = await cfWidgetModpack(slugOrId);
    return (w.files || []).slice(0, limit).map((f) => ({
      id: String(f.id),
      name: f.display || f.name,
      fileName: f.name,
      type: f.type,
      gameVersions: (f.versions || []).filter((x) => /^\d/.test(x)),
      loaders: (f.versions || []).filter((x) => !/^\d/.test(x)),
      uploadedAt: f.uploaded_at,
      downloads: f.downloads || 0,
      size: f.filesize || 0,
    }));
  }
  if (source === 'modrinth') {
    const slug = String(slugOrId).replace(/^mr:/, '');
    const versions = await fetchJson(`${API.modrinth}/project/${encodeURIComponent(slug)}/version`);
    return versions.slice(0, limit).map((v) => ({
      id: v.id,
      name: v.version_number,
      fileName: (v.files.find((f) => f.primary) || v.files[0] || {}).filename || '',
      type: v.version_type,
      gameVersions: v.game_versions || [],
      loaders: v.loaders || [],
      uploadedAt: v.date_published,
      downloads: v.downloads || 0,
      size: (v.files.find((f) => f.primary) || v.files[0] || {}).size || 0,
    }));
  }
  if (source === 'github') {
    // Для GitHub — список веток как «версий».
    const repo = String(slugOrId);
    const parsed = ghSync.parseRepo(repo);
    const branches = await fetchJson(`${API.githubApi}/repos/${parsed.owner}/${parsed.repo}/branches?per_page=50`)
      .then((list) => list.map((b) => ({
        id: b.name, name: b.name, fileName: '', type: 'branch',
        gameVersions: [], loaders: [], uploadedAt: null, downloads: 0, size: 0,
      })))
      .catch(() => []);
    return branches;
  }
  throw new Error('Неизвестный источник сборки: ' + source);
}

function listPacks(settings) {
  const root = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks');
  try {
    return fs.readdirSync(root)
      .filter((d) => fs.existsSync(path.join(root, d, '.moss-pack.json')))
      .map((d) => packStatus(settings, d))
      .filter(Boolean)
      .sort((a, b) => b.syncedAt - a.syncedAt);
  } catch {
    return [];
  }
}

/** Read the actual pack directory, independently of the selected game profile. */
function listPackMods(settings, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:]/.test(name)) {
    throw new Error('Неверное имя сборки');
  }
  const root = path.resolve(settings.gameDir || PATHS.defaultGameDir, 'modpacks');
  const packDir = path.join(root, name);
  if (!fs.existsSync(path.join(packDir, '.moss-pack.json'))) throw new Error('Сборка не найдена');
  const dir = path.join(packDir, 'mods');
  if (!fs.existsSync(dir)) return [];
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Папка модов вне каталога сборок');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.jar(?:\.disabled)?$/i.test(entry.name))
    .map(entry => ({
      file: entry.name,
      name: entry.name.replace(/\.jar(?:\.disabled)?$/i, ''),
      enabled: !/\.disabled$/i.test(entry.name),
      size: fs.statSync(path.join(dir, entry.name)).size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
}

function removePack(settings, name) {
  const dir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Подбирает установленную версию под сборку: совпадение MC + лоадер.
 * Возвращает id версии или пустую строку.
 */
function matchInstalledVersion(settings, pack) {
  const mc = require('./minecraft');
  const installed = mc.listInstalled(settings);
  const parse = (id) => {
    const s = String(id || '');
    let m;
    if ((m = s.match(/^fabric-loader-[\d.]+-(.+)$/))) return { loader: 'fabric', mc: m[1] };
    if ((m = s.match(/^quilt-loader-[\d.]+-(.+)$/))) return { loader: 'quilt', mc: m[1] };
    if ((m = s.match(/^(.+)-forge-?[\d.]+$/))) return { loader: 'forge', mc: m[1] };
    if ((m = s.match(/^(.+)-neoforge-[\d.]+$/))) return { loader: 'neoforge', mc: m[1] };
    if ((m = s.match(/^neoforge-(\d+)\.(\d+)\./))) return { loader: 'neoforge', mc: `1.${m[1]}${m[2] === '0' ? '' : '.' + m[2]}` };
    return { loader: 'vanilla', mc: s };
  };
  if (pack.gameVersion && pack.loader) {
    const exact = installed.find((id) => {
      const p = parse(id);
      return p.mc === pack.gameVersion && p.loader === pack.loader;
    });
    if (exact) return exact;
  }
  // Fallback — любая версия с нужным лоадером и той же MC
  if (pack.gameVersion) {
    const byMc = installed.find((id) => parse(id).mc === pack.gameVersion);
    if (byMc) return byMc;
  }
  return installed[0] || '';
}

module.exports = { syncModpack, packStatus, listPacks, listPackMods, removePack, parseSource, listPackVersions, matchInstalledVersion };
