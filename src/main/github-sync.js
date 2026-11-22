'use strict';

/**
 * github-sync.js — sync a folder inside the game dir with a GitHub repo.
 *
 * Model: user points the launcher at `owner/repo` + optional `branch` +
 * `subdir`. We download the repo tarball (codeload — no API key needed),
 * then copy the selected subtree into <gameDir>/modpack/<name>/ keeping a
 * `.moss-pack.json` manifest of sha256 hashes; on update, only changed files
 * are written and removed files are deleted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { API, PATHS } = require('../shared/constants');
const { request, downloadFile } = require('./net');
const { ensureDir, readJson, writeJson } = require('./storage');
const { getSettings } = require('./settings');
const AdmZip = require('adm-zip');

function parseRepo(input) {
  // accepts "owner/repo", "owner/repo:branch", "https://github.com/owner/repo[/tree/branch[/subdir]]"
  input = String(input || '').trim().replace(/\/+$/, '');
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, ''), branch: urlMatch[3] || 'main', subdir: urlMatch[4] || '' };
  }
  const m = input.match(/^([\w.-]+)\/([\w.-]+)(?::([\w./-]+))?$/);
  if (m) {
    const parts = (m[3] || '').split('/');
    return { owner: m[1], repo: m[2], branch: parts[0] || 'main', subdir: parts.slice(1).join('/') };
  }
  throw new Error('Неверный формат репозитория. Используйте owner/repo или ссылку GitHub.');
}

function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

async function tryBranches(owner, repo, branch) {
  const candidates = [branch, branch === 'main' ? 'master' : 'main', 'master', 'main'];
  const seen = new Set();
  for (const b of candidates) {
    if (!b || seen.has(b)) continue;
    seen.add(b);
    const url = `${API.githubCodeload}/${owner}/${repo}/zip/refs/heads/${b}`;
    try {
      const res = await request(url, { method: 'HEAD' });
      if (res.status === 200 || res.status === 302) return b;
    } catch {}
  }
  return branch;
}

/**
 * Download repo zip → extract → sync target folder.
 * onProgress({stage, message})
 */
async function syncRepo({ repo, branch = 'main', subdir = '', targetName = '', settings, onProgress = () => {} }) {
  const { owner, repo: repoName, branch: b0, subdir: s0 } = parseRepo(repo);
  branch = branch && branch !== 'main' ? branch : b0;
  subdir = subdir || s0;

  onProgress({ stage: 'resolve', message: 'Определение ветки…' });
  branch = await tryBranches(owner, repoName, branch);

  onProgress({ stage: 'download', message: `Скачивание ${owner}/${repoName}@${branch}…` });
  const zipUrl = `${API.githubCodeload}/${owner}/${repoName}/zip/refs/heads/${branch}`;
  const zipPath = path.join(PATHS.cacheDir, `gh-${crypto.randomUUID()}.zip`);
  await downloadFile(zipUrl, zipPath, {
    timeout: 180000,
    onProgress: (p) => onProgress({ ...p, stage: 'download', message: `Скачивание ${owner}/${repoName}@${branch}…` }),
  });

  onProgress({ stage: 'extract', message: 'Распаковка…' });
  const zip = new AdmZip(zipPath);
  const root = `${repoName}-${branch}/`;
  const prefix = subdir ? root + subdir.replace(/^\/+|\/+$/g, '') + '/' : root;
  const files = new Map();
  for (const e of zip.getEntries()) {
    const name = e.entryName;
    if (e.isDirectory || !name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (!rel || rel.split('/').some((p) => p.startsWith('.git'))) continue;
    files.set(rel.replace(/\//g, path.sep), e.getData());
  }

  const targetDir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', targetName || `${owner}-${repoName}`);
  ensureDir(targetDir);
  const manifestPath = path.join(targetDir, '.moss-pack.json');
  const prev = readJson(manifestPath, { files: {} });

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
    if (!nextFiles[rel]) {
      const p = path.join(targetDir, rel);
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
    }
  }
  writeJson(manifestPath, {
    repo: `${owner}/${repoName}`, branch, subdir,
    syncedAt: Date.now(), files: nextFiles,
  });
  try { fs.unlinkSync(zipPath); } catch {}
  onProgress({ stage: 'done', message: `Готово: ${written} новых, ${removed} удалено, ${kept} без изменений` });
  return { targetDir, written, removed, kept, total: files.size };
}

function packStatus(settings, name) {
  const dir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', name);
  const m = readJson(path.join(dir, '.moss-pack.json'), null);
  if (!m) return null;
  return { name, dir, repo: m.repo, branch: m.branch, subdir: m.subdir || '', syncedAt: m.syncedAt, files: Object.keys(m.files || {}).length };
}

/** List all synced packs (folders containing .moss-pack.json). */
function listPacks(settings) {
  const root = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks');
  try {
    return fs
      .readdirSync(root)
      .filter((d) => fs.existsSync(path.join(root, d, '.moss-pack.json')))
      .map((d) => packStatus(settings, d))
      .filter(Boolean)
      .sort((a, b) => b.syncedAt - a.syncedAt);
  } catch {
    return [];
  }
}

function removePack(settings, name) {
  const dir = path.join(settings.gameDir || PATHS.defaultGameDir, 'modpacks', name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { syncRepo, packStatus, listPacks, removePack, parseRepo };
