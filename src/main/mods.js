'use strict';

/**
 * mods.js — Modrinth + CurseForge mod search & install.
 *
 * Modrinth: публичный API, работает без ключа.
 * CurseForge: официальный API требует API-ключ. Для работы без ключа
 * используется cfwidget — публичный витринный endpoint, который отдаёт
 * метаданные проекта и список файлов. Установка идёт напрямую через
 * CDN Forge (edge.forgecdn.net), который не требует авторизации.
 *
 * Поиск на CurseForge без ключа невозможен (Cloudflare закрывает поиск),
 * поэтому UI предлагает вставить ссылку на мод вручную — мы разрешаем её
 * через cfwidget и показываем найденный проект.
 *
 * Моды ставятся в <gameDir>/mods/<versionId>/ — у каждой версии свои моды.
 */

const fs = require('fs');
const path = require('path');
const { API, PATHS } = require('../shared/constants');
const { fetchJson, downloadFile } = require('./net');
const { ensureDir, readJson, writeJson } = require('./storage');

const MR = API.modrinth;
const CFW = API.cfwidget;
const CF_GAME_ID = 432; // Minecraft

function modsDirFor(settings, versionId) {
  const root = settings.gameDir || PATHS.defaultGameDir;
  return path.join(root, 'mods', versionId);
}

/** Дублируем parseVersionId локально — renderer-модули недоступны из main. */
function parseVersionId(id) {
  const s = String(id || '');
  let m;
  if ((m = s.match(/^fabric-loader-[\d.]+-(.+)$/))) return { loader: 'fabric', mcVersion: m[1] };
  if ((m = s.match(/^quilt-loader-[\d.]+-(.+)$/))) return { loader: 'quilt', mcVersion: m[1] };
  if ((m = s.match(/^(.+)-forge-?[\d.]+$/))) return { loader: 'forge', mcVersion: m[1] };
  if ((m = s.match(/^(.+)-neoforge-[\d.]+$/))) return { loader: 'neoforge', mcVersion: m[1] };
  if ((m = s.match(/^neoforge-(\d+)\.(\d+)\./))) return { loader: 'neoforge', mcVersion: `1.${m[1]}${m[2] === '0' ? '' : '.' + m[2]}` };
  return { loader: 'vanilla', mcVersion: s };
}

// ---------------------------------------------------------------- Modrinth
async function mrSearch({ query = '', loader = '', version = '', limit = 20, offset = 0 } = {}) {
  const facets = [['project_type:mod']];
  if (version) facets.push([`versions:${version}`]);
  if (loader) facets.push([`categories:${loader}`]);
  const url = `${MR}/search?limit=${limit}&offset=${offset}&index=downloads` +
    `&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const res = await fetchJson(url);
  return {
    total: res.total_hits,
    hits: res.hits.map((h) => ({
      source: 'modrinth',
      id: h.project_id,
      slug: h.slug,
      name: h.title,
      description: h.description,
      downloads: h.downloads,
      follows: h.follows,
      icon: h.icon_url,
      author: h.author,
      versions: h.versions,
      categories: h.categories,
    })),
  };
}

async function mrVersions(projectId, { loader = '', version = '' } = {}) {
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  if (version) params.set('game_versions', JSON.stringify([version]));
  const q = params.toString();
  return fetchJson(`${MR}/project/${projectId}/version${q ? '?' + q : ''}`);
}

async function mrInstall(projectId, { loader, mcVersion, versionId = mcVersion, settings }) {
  const versions = await mrVersions(projectId, { loader, version: mcVersion });
  if (!versions.length) throw new Error('Нет файла под эту версию игры/лоадер');
  const v = versions[0];
  const file = v.files.find((f) => f.primary) || v.files[0];
  const destDir = modsDirFor(settings, versionId);
  ensureDir(destDir);
  const dest = path.join(destDir, file.filename);
  await downloadFile(file.url, dest, { size: file.size, sha1: file.hashes && file.hashes.sha1 });
  updateModsManifest(settings, versionId, (list) => {
    const i = list.findIndex((m) => m.source === 'modrinth' && m.id === projectId);
    const entry = {
      source: 'modrinth', id: projectId, name: v.name,
      file: file.filename, versionId: v.id, versionNumber: v.version_number,
      enabled: true, installedAt: Date.now(),
    };
    if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
    return list;
  });
  return { file: dest, version: v.version_number };
}

// ---------------------------------------------------------------- CurseForge
function cfHeaders(settings) {
  const key = settings.curseforgeApiKey || '';
  return key ? { 'x-api-key': key, Accept: 'application/json' } : { Accept: 'application/json' };
}

function cfLoaderType(loader) {
  return { forge: 1, 'forge-old': 1, fabric: 4, quilt: 5, neoforge: 6, any: 0 }[loader] ?? 0;
}

function cfLoaderName(loader) {
  return { forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge' }[loader] || '';
}

/**
 * Поиск CurseForge без ключа невозможен (Cloudflare блокирует).
 * Возвращаем marker needsKey, чтобы UI мог показать поле для ручного ввода ссылки.
 */
async function cfSearch({ query = '', loader = '', version = '', limit = 20, offset = 0, settings }) {
  const key = settings.curseforgeApiKey;
  if (!key) {
    return { needsKey: true, hits: [], total: 0 };
  }
  const params = new URLSearchParams({
    gameId: CF_GAME_ID, classId: 6, searchFilter: query,
    pageSize: limit, index: offset, sortField: 2, sortOrder: 'desc',
  });
  if (version) params.set('gameVersion', version);
  if (loader) params.set('modLoaderType', cfLoaderType(loader));
  const res = await fetchJson(`${API.curseforge}/mods/search?${params}`, { headers: cfHeaders(settings) });
  return {
    total: res.pagination.totalCount,
    hits: res.data.map((m) => ({
      source: 'curseforge',
      id: String(m.id),
      slug: m.slug,
      name: m.name,
      description: m.summary,
      downloads: m.downloadCount,
      icon: m.logo && m.logo.thumbnailUrl,
      author: (m.authors && m.authors[0] && m.authors[0].name) || '',
      categories: (m.categories || []).map((c) => c.name),
    })),
  };
}

/** Файлы через официальный API (нужен ключ). */
async function cfFilesOfficial(modId, { loader = '', version = '', settings }) {
  const params = new URLSearchParams({ pageSize: 50 });
  if (version) params.set('gameVersion', version);
  if (loader) params.set('modLoaderType', cfLoaderType(loader));
  const res = await fetchJson(`${API.curseforge}/mods/${modId}/files?${params}`, { headers: cfHeaders(settings) });
  return res.data;
}

/**
 * Метаданные проекта через cfwidget (без ключа).
 * Принимает slug или числовой id.
 */
async function cfWidgetProject(slugOrId) {
  const key = String(slugOrId);
  const url = /^\d+$/.test(key) ? `${CFW}/${key}` : `${CFW}/minecraft/mc-mods/${encodeURIComponent(key)}`;
  return fetchJson(url);
}

/** Подбор файла по фильтрам версии и лоадера из списка cfwidget. */
function pickCfFile(files, { version = '', loader = '' }) {
  if (!files || !files.length) return null;
  const loaderName = cfLoaderName(loader);
  const candidates = files.filter((f) => {
    const vs = f.versions || [];
    const okV = !version || vs.includes(version);
    const okL = !loaderName || vs.includes(loaderName);
    return okV && okL;
  });
  const pool = candidates.length ? candidates : files;
  for (const t of ['release', 'beta', 'alpha']) {
    const hit = pool.find((f) => f.type === t);
    if (hit) return hit;
  }
  return pool[0];
}

/**
 * Установка мода с CurseForge.
 * С ключом — через официальный API; без — через cfwidget + CDN.
 * Принимает modId или slug.
 */
async function cfInstall(modIdOrSlug, { loader, mcVersion, versionId = mcVersion, settings }) {
  if (settings.curseforgeApiKey) {
    const files = await cfFilesOfficial(modIdOrSlug, { loader, version: mcVersion, settings });
    const file = files.find((f) => f.downloadUrl) || files[0];
    if (!file) throw new Error('Нет файла под эту версию игры/лоадер');
    const destDir = modsDirFor(settings, versionId);
    ensureDir(destDir);
    const dest = path.join(destDir, file.fileName);
    const url = file.downloadUrl ||
      `https://edge.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${encodeURIComponent(file.fileName)}`;
    await downloadFile(url, dest, { size: file.fileLength });
    updateModsManifest(settings, versionId, (list) => {
      const i = list.findIndex((m) => m.source === 'curseforge' && String(m.id) === String(modIdOrSlug));
      const entry = {
        source: 'curseforge', id: String(modIdOrSlug),
        name: file.displayName || file.fileName, file: file.fileName,
        fileId: file.id, enabled: true, installedAt: Date.now(),
      };
      if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
      return list;
    });
    return { file: dest };
  }

  // Путь без ключа — через cfwidget
  const widget = await cfWidgetProject(modIdOrSlug);
  const files = widget.files || [];
  const file = pickCfFile(files, { version: mcVersion, loader });
  if (!file) throw new Error(`Нет файла под ${mcVersion || 'эту версию игры'}${loader ? ' / ' + loader : ''}`);

  const destDir = modsDirFor(settings, versionId);
  ensureDir(destDir);
  const dest = path.join(destDir, file.name);
  const d = Math.floor(file.id / 1000);
  const m = file.id % 1000;
  const url = `https://edge.forgecdn.net/files/${d}/${m}/${encodeURIComponent(file.name)}`;
  await downloadFile(url, dest, { size: file.filesize });

  updateModsManifest(settings, versionId, (list) => {
    const i = list.findIndex((x) => x.source === 'curseforge' && String(x.id) === String(widget.id));
    const entry = {
      source: 'curseforge', id: String(widget.id), slug: modIdOrSlug,
      name: widget.title || file.display || file.name,
      file: file.name, fileId: file.id, enabled: true, installedAt: Date.now(),
    };
    if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
    return list;
  });
  return { file: dest };
}

/**
 * Проверка доступных обновлений для установленных модов.
 *
 * Modrinth — версии приходят от новых к старым, поэтому текущая версия
 * ищется по её position в списке: всё, что выше, — новее.
 * CurseForge — cfwidget не гарантирует порядок, сортируем по id файла
 * (он монотонно растёт с каждой загрузкой).
 */
async function checkUpdates(settings, versionId) {
  const manifest = readModsManifest(settings, versionId);
  const { mcVersion, loader } = parseVersionId(versionId);
  const updates = [];

  for (const mod of manifest) {
    if (mod.source !== 'modrinth' && mod.source !== 'curseforge') continue;
    try {
      const raw = await getVersions(mod.source, mod.id, { loader, version: mcVersion, settings });
      if (!raw.length) continue;

      let versions = raw;
      if (mod.source === 'curseforge') {
        versions = raw.slice().sort((a, b) => Number(b.id) - Number(a.id));
      }

      const currentKey = mod.source === 'modrinth'
        ? (mod.versionId || mod.versionNumber || '')
        : String(mod.fileId || '');
      const idx = versions.findIndex((v) =>
        mod.source === 'modrinth'
          ? v.id === currentKey || v.versionNumber === currentKey
          : String(v.id) === currentKey
      );

      // idx === 0 — установлена самая свежая; idx < 0 — версии нет в списке
      // (мод обновился под другой MC/лоадер), считаем что обновление есть.
      if (idx === 0) continue;
      const latest = versions[0];
      if (!latest) continue;

      updates.push({
        source: mod.source,
        projectId: mod.id,
        file: mod.file,
        modName: mod.name || mod.file,
        currentVersion: mod.source === 'modrinth'
          ? (mod.versionNumber || currentKey || '—')
          : (mod.file || '—'),
        latestVersion: latest.versionNumber,
        latestFile: latest.files.find((f) => f.primary) || latest.files[0] || null,
      });
    } catch {
      // Мод мог быть удалён с хоста — молча пропускаем.
    }
  }

  return updates;
}

/**
 * Разрешает ссылку CurseForge или slug в объект проекта для UI.
 */
async function cfResolve(input) {
  const s = String(input || '').trim();
  let slug = s;
  const urlMatch = s.match(/curseforge\.com\/minecraft\/(?:mc-mods|modpacks|texture-packs|customization|worlds)\/([\w-]+)/);
  if (urlMatch) slug = urlMatch[1];
  const w = await cfWidgetProject(slug);
  return {
    source: 'curseforge',
    id: String(w.id),
    slug,
    name: w.title,
    description: w.summary,
    downloads: (w.downloads && w.downloads.total) || 0,
    icon: w.thumbnail || null,
    author: (w.members && w.members[0] && w.members[0].username) || '',
    categories: (w.categories || []).map((c) => c.title || c),
    files: (w.files || []).map((f) => ({
      id: f.id, name: f.name, display: f.display,
      version: f.version, filesize: f.filesize, type: f.type,
      versions: f.versions, downloads: f.downloads, uploaded_at: f.uploaded_at,
    })),
  };
}

// ---------------------------------------------------------------- manifest / local
function modsManifestPath(settings, versionId) {
  return path.join(modsDirFor(settings, versionId), 'mods.moss.json');
}

function readModsManifest(settings, versionId) {
  return readJson(modsManifestPath(settings, versionId), []);
}

function updateModsManifest(settings, versionId, fn) {
  const list = readModsManifest(settings, versionId);
  const next = fn(list);
  ensureDir(modsDirFor(settings, versionId));
  writeJson(modsManifestPath(settings, versionId), next);
  return next;
}

/** List jar files + manifest entries merged for display. */
function listMods(settings, versionId) {
  const dir = modsDirFor(settings, versionId);
  const manifest = readModsManifest(settings, versionId);
  const jars = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled')) : [];
  const known = new Set(manifest.map((m) => m.file));
  const extra = jars.filter((j) => !known.has(j.replace(/\.disabled$/, ''))).map((j) => ({
    source: 'local', id: j, name: j.replace(/\.jar(\.disabled)?$/, ''), file: j.replace(/\.disabled$/, ''),
    enabled: !j.endsWith('.disabled'), local: true,
  }));
  return manifest.map((m) => ({ ...m, enabled: m.enabled !== false && jars.includes(m.file) })).concat(extra);
}

function toggleMod(settings, versionId, file, enabled) {
  const dir = modsDirFor(settings, versionId);
  const from = path.join(dir, enabled ? file + '.disabled' : file);
  const to = path.join(dir, enabled ? file : file + '.disabled');
  const src = fs.existsSync(from) ? from : (fs.existsSync(to) ? null : (fs.existsSync(path.join(dir, file)) ? path.join(dir, file) : null));
  if (!src) throw new Error('Файл мода не найден');
  const target = enabled ? path.join(dir, file) : path.join(dir, file + '.disabled');
  if (src !== target) fs.renameSync(src, target);
  updateModsManifest(settings, versionId, (list) => list.map((m) => (m.file === file ? { ...m, enabled } : m)));
}

function removeMod(settings, versionId, file) {
  const dir = modsDirFor(settings, versionId);
  for (const f of [file, file + '.disabled']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  updateModsManifest(settings, versionId, (list) => list.filter((m) => m.file !== file));
}

// ---------------------------------------------------------------- unified
async function searchAll(params, settings) {
  const [mr, cf] = await Promise.allSettled([
    params.source === 'curseforge' ? Promise.resolve({ hits: [], total: 0 }) : mrSearch(params),
    params.source === 'modrinth' ? Promise.resolve({ hits: [], total: 0 }) : cfSearch({ ...params, settings }),
  ]);
  return {
    modrinth: mr.status === 'fulfilled' ? mr.value : { error: mr.reason.message, hits: [] },
    curseforge: cf.status === 'fulfilled' ? cf.value : { error: cf.reason.message, hits: [] },
  };
}

async function install(source, projectId, args) {
  if (source === 'modrinth') return mrInstall(projectId, args);
  if (source === 'curseforge') return cfInstall(projectId, args);
  throw new Error('Unknown source ' + source);
}

/**
 * Версии проекта для диалога выбора файла.
 * Modrinth — живой API; CurseForge — из cfwidget (или официального API при наличии ключа).
 */
async function getVersions(source, projectId, { loader = '', version = '', settings } = {}) {
  if (source === 'modrinth') {
    const list = await mrVersions(projectId, { loader, version });
    return list.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      name: v.name,
      type: v.version_type,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      datePublished: v.date_published,
      downloads: v.downloads,
      files: (v.files || []).map((f) => ({
        url: f.url, filename: f.filename, primary: f.primary,
        size: f.size, sha1: f.hashes && f.hashes.sha1, sha512: f.hashes && f.hashes.sha512,
      })),
    }));
  }
  if (source === 'curseforge') {
    const w = await cfWidgetProject(projectId);
    return (w.files || []).map((f) => ({
      id: f.id,
      versionNumber: f.display || f.name,
      name: f.name,
      type: f.type,
      gameVersions: (f.versions || []).filter((x) => /^\d/.test(x)),
      loaders: (f.versions || []).filter((x) => !/^\d/.test(x)),
      datePublished: f.uploaded_at,
      downloads: f.downloads,
      files: [{ url: null, filename: f.name, primary: true, size: f.filesize, fileId: f.id }],
    }));
  }
  throw new Error('Unknown source ' + source);
}

/**
 * Установка конкретного файла (выбранного пользователем в диалоге версий).
 * file — объект из getVersions: { url, filename, size, sha1, fileId }.
 */
async function installFile(source, projectId, file, { loader, mcVersion, versionId = mcVersion, settings }) {
  const destDir = modsDirFor(settings, versionId);
  ensureDir(destDir);
  const filename = file.filename || file.name;
  const dest = path.join(destDir, filename);

  if (source === 'modrinth') {
    if (!file.url) throw new Error('Файл не содержит URL для скачивания');
    await downloadFile(file.url, dest, { size: file.size, sha1: file.sha1 });
    updateModsManifest(settings, versionId, (list) => {
      const i = list.findIndex((m) => m.source === 'modrinth' && String(m.id) === String(projectId));
      const entry = {
        source: 'modrinth', id: String(projectId), name: filename,
        file: filename, versionId: file.versionId || '', versionNumber: file.versionNumber || '',
        enabled: true, installedAt: Date.now(),
      };
      if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
      return list;
    });
    return { file: dest };
  }
  if (source === 'curseforge') {
    const fileId = file.fileId || file.id;
    if (!fileId) throw new Error('Не удалось определить id файла CurseForge');
    const d = Math.floor(fileId / 1000);
    const m = fileId % 1000;
    const url = `https://edge.forgecdn.net/files/${d}/${m}/${encodeURIComponent(filename)}`;
    await downloadFile(url, dest, { size: file.size || file.filesize });
    updateModsManifest(settings, versionId, (list) => {
      const i = list.findIndex((x) => x.source === 'curseforge' && String(x.id) === String(projectId));
      const entry = {
        source: 'curseforge', id: String(projectId),
        name: filename, file: filename, fileId: Number(fileId),
        enabled: true, installedAt: Date.now(),
      };
      if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
      return list;
    });
    return { file: dest };
  }
  throw new Error('Unknown source ' + source);
}

module.exports = { searchAll, install, installFile, getVersions, checkUpdates, listMods, toggleMod, removeMod, modsDirFor, cfResolve };
