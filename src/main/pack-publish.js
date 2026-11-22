'use strict';

/**
 * pack-publish.js — публикация клиентской сборки в GitHub из папки сервера.
 *
 * Команда пересчитывает sha256 файлов, создаёт новый pack-index.json,
 * обновляет launcher/servers.json и одним push-ом публикует новую ревизию.
 * Авторизация — Personal Access Token из настроек лаунчера.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATHS } = require('../shared/constants');

const API_ROOT = 'https://api.github.com';
const DEFAULT_REPO = 'Ujif416/Create-Aeronautics-Skybound';
const DEFAULT_BRANCH = 'main';
const ROOTS = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks']);
const CATALOG_FILE = 'launcher/servers.json';
const INDEX_FILE = 'pack-index.json';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function blobSha(buf) { return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex'); }
function safeRel(name) {
  const parts = String(name).replace(/\\/g, '/').split('/');
  return parts.length > 0 && parts.every(p => p && p !== '.' && p !== '..' && !/[<>:"|?*\x00-\x1f]/.test(p));
}

async function api(token, method, urlPath, body) {
  const res = await fetch(API_ROOT + urlPath, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'MossLauncher',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = data && typeof data === 'object' ? (data.message || JSON.stringify(data)) : String(data);
    throw new Error(`GitHub ${method} ${urlPath}: ${res.status} ${message}`);
  }
  return data;
}

function decodeContent(entry) {
  if (!entry || typeof entry.content !== 'string') throw new Error('GitHub вернул пустое содержимое файла');
  return Buffer.from(entry.content.replace(/\s/g, ''), 'base64');
}

/** Recursively collect publishable files from the server game directory. */
function collectFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!rel && ROOTS.has(item.name)) walk(full, nextRel);
        continue;
      }
      if (!item.isFile()) continue;
      if (!safeRel(nextRel) || nextRel.length > 230) throw new Error(`Недопустимый путь файла: ${nextRel}`);
      const data = fs.readFileSync(full);
      if (data.length > 1024 ** 3) throw new Error(`Файл слишком большой: ${nextRel}`);
      out.push({ path: nextRel, size: data.length, sha256: sha256(data), bytes: data });
    }
  };
  walk(root, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  if (!out.length || out.length > 20000 || out.reduce((n, f) => n + f.size, 0) > 20 * 1024 ** 3) {
    throw new Error('Некорректный размер клиентской сборки');
  }
  return out;
}

function nextRevision(previous) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const prefix = 'skybound-' + date + '.';
  const m = /^skybound-\d{4}-\d{2}-\d{2}\.(\d+)$/.exec(previous || '');
  const n = m && previous.startsWith(prefix) ? parseInt(m[1], 10) + 1 : 1;
  return prefix + n;
}

/**
 * @param {object} opts
 * @param {string} opts.token GitHub PAT (repo scope)
 * @param {string} [opts.repo] owner/repo
 * @param {string} [opts.branch]
 * @param {string} [opts.sourceDir] папка сервера (game), откуда берём файлы
 * @param {string} [opts.revision] явный номер выпуска
 * @param {(p:object)=>void} [opts.onProgress]
 */
async function publish(opts = {}) {
  const token = String(opts.token || '').trim();
  if (!token) throw new Error('Укажите GitHub Personal Access Token в настройках');
  const repo = String(opts.repo || DEFAULT_REPO).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Некорректный GitHub-репозиторий');
  const branch = String(opts.branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  const progress = opts.onProgress || (() => {});
  const gameDir = opts.gameDir || (require('./settings').getSettings().gameDir || PATHS.defaultGameDir);
  const sourceDir = opts.sourceDir || path.join(gameDir, 'servers', 'create-skybound', 'game');
  if (!fs.existsSync(sourceDir)) throw new Error(`Папка сервера не найдена: ${sourceDir}`);

  progress({ stage: 'catalog', message: 'Получение каталога серверов', done: 0, total: 1 });
  const catalogEntry = await api(token, 'GET', `/repos/${repo}/contents/${CATALOG_FILE}?ref=${encodeURIComponent(branch)}`);
  const catalogJson = decodeContent(catalogEntry);
  const catalog = JSON.parse(catalogJson.toString('utf8'));
  const server = (catalog.servers || []).find(s => s.id === 'create-skybound');
  if (!server) throw new Error('В каталоге нет сервера create-skybound');

  progress({ stage: 'files', message: 'Пересчёт контрольных сумм', done: 0, total: 1 });
  const files = collectFiles(sourceDir);
  const excluded = new Set((server.pack && server.pack.exclude || []).map(e => e.path));
  const payload = files.filter(f => !excluded.has(f.path));

  const index = {
    name: server.name,
    minecraft: server.minecraft,
    loader: server.loader.type,
    loaderVersion: server.loader.version,
    java: server.java,
    files: payload.map(({ path: p, size, sha256: h }) => ({ path: p, size, sha256: h })),
  };
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8');
  const indexSha = sha256(indexBytes);

  progress({ stage: 'tree', message: 'Сравнение с GitHub', done: 0, total: 1 });
  const ref = await api(token, 'GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const baseSha = ref.object.sha;
  const baseCommit = await api(token, 'GET', `/repos/${repo}/git/commits/${baseSha}`);
  const tree = await api(token, 'GET', `/repos/${repo}/git/trees/${baseSha}?recursive=1`);
  const remote = new Map(tree.tree.filter(t => t.type === 'blob' && t.path).map(t => [t.path, t.sha]));

  const changes = new Map(); // path -> bytes
  let added = 0, updated = 0;
  for (const f of payload) {
    const remotePath = 'pack/' + f.path;
    const sha = blobSha(f.bytes);
    if (remote.get(remotePath) === sha) continue;
    changes.set(remotePath, f.bytes);
    if (remote.has(remotePath)) updated++; else added++;
  }
  if (remote.get(INDEX_FILE) !== blobSha(indexBytes)) changes.set(INDEX_FILE, indexBytes);

  const revision = String(opts.revision || nextRevision(server.packRevision)).trim();
  server.pack.commit = baseSha; // filled with the payload commit SHA after it is created
  server.pack.indexSha256 = indexSha;
  server.pack.exclude = (server.pack.exclude || []).filter(e => {
    const f = files.find(x => x.path === e.path);
    return f && f.sha256 === e.sha256;
  });
  server.packRevision = revision;
  catalog.catalogRevision = revision;
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  if (remote.get(CATALOG_FILE) !== blobSha(catalogBytes)) changes.set(CATALOG_FILE, catalogBytes);

  if (!changes.has(INDEX_FILE) && !changes.has(CATALOG_FILE) && !added && !updated) {
    return { revision, commit: baseSha, added: 0, updated: 0, unchanged: true, files: payload.length };
  }

  const blobs = [];
  for (const [p, bytes] of changes) {
    progress({ stage: 'upload', message: `Загрузка ${p}`, done: blobs.length + 1, total: changes.size });
    const blob = await api(token, 'POST', `/repos/${repo}/git/blobs`, {
      content: bytes.toString('base64'), encoding: 'base64',
    });
    blobs.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Commit A: payload + index. Commit B: catalog pointing at commit A.
  const payloadBlobs = blobs.filter(b => b.path !== CATALOG_FILE);
  const payloadTree = await api(token, 'POST', `/repos/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha, tree: payloadBlobs,
  });
  const payloadCommit = await api(token, 'POST', `/repos/${repo}/git/commits`, {
    message: `Publish client pack ${revision} [MossLauncher]`,
    tree: payloadTree.sha,
    parents: [baseSha],
  });
  server.pack.commit = payloadCommit.sha;
  const finalCatalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  const catalogBlob = blobs.find(b => b.path === CATALOG_FILE);
  const finalBlob = await api(token, 'POST', `/repos/${repo}/git/blobs`, {
    content: finalCatalogBytes.toString('base64'), encoding: 'base64',
  });
  const finalTree = await api(token, 'POST', `/repos/${repo}/git/trees`, {
    base_tree: payloadTree.sha,
    tree: [{ path: CATALOG_FILE, mode: '100644', type: 'blob', sha: finalBlob.sha }],
  });
  const finalCommit = await api(token, 'POST', `/repos/${repo}/git/commits`, {
    message: `Point server catalog to ${revision} [MossLauncher]`,
    tree: finalTree.sha,
    parents: [payloadCommit.sha],
  });
  await api(token, 'PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: finalCommit.sha, force: false,
  });

  progress({ stage: 'done', message: `Опубликована ревизия ${revision}`, done: 1, total: 1 });
  return { revision, commit: payloadCommit.sha, catalogCommit: finalCommit.sha, added, updated, unchanged: false, files: payload.length };
}

module.exports = { publish, collectFiles, sha256, blobSha, DEFAULT_REPO, CATALOG_FILE, INDEX_FILE };
