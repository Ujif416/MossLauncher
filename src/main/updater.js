'use strict';

/**
 * updater.js — проверка и установка обновлений MossLauncher через GitHub Releases.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, shell } = require('electron');
const net = require('./net');
const { PATHS, API } = require('../shared/constants');

function normalizeRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i);
  return m ? m[1] : null;
}

function parseSemver(v) {
  const clean = String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = clean.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewerVersion(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function currentAppVersion() {
  try {
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch {}
  try {
    return require('../../package.json').version;
  } catch {
    return '0.0.0';
  }
}

function isPortableBuild() {
  return !!process.env.PORTABLE_EXECUTABLE_FILE;
}

function pickReleaseAsset(assets = [], portable = false) {
  const exes = assets.filter((a) => /\.exe$/i.test(a.name || '') && a.browser_download_url);
  if (!exes.length) return null;
  if (portable) {
    return exes.find((a) => /portable/i.test(a.name)) || exes[0];
  }
  return exes.find((a) => /setup|installer/i.test(a.name)) || exes.find((a) => !/portable/i.test(a.name)) || exes[0];
}

async function checkForUpdates(settings = {}) {
  const repo = normalizeRepo(settings.updateRepo);
  const currentVersion = currentAppVersion();
  if (!repo) {
    return {
      configured: false,
      currentVersion,
      updateAvailable: false,
      message: 'Укажите GitHub-репозиторий обновлений в настройках.',
    };
  }

  const headers = { Accept: 'application/vnd.github+json' };
  if (settings.githubToken) headers.Authorization = `Bearer ${settings.githubToken}`;

  let release;
  try {
    release = await net.fetchJson(`${API.githubApi}/repos/${repo}/releases/latest`, { headers, timeout: 15000 });
  } catch (e) {
    if (e.status === 404) {
      return {
        configured: true,
        repo,
        currentVersion,
        updateAvailable: false,
        message: `В репозитории ${repo} пока нет опубликованных релизов.`,
      };
    }
    throw e;
  }

  const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
  const portable = isPortableBuild();
  const asset = pickReleaseAsset(release.assets || [], portable);
  const checksumAsset = (release.assets || []).find((a) => /sha256sums?\.txt$/i.test(a.name || '')) || null;
  const updateAvailable = !!latestVersion && isNewerVersion(latestVersion, currentVersion);

  return {
    configured: true,
    repo,
    currentVersion,
    latestVersion,
    updateAvailable,
    portable,
    releaseUrl: release.html_url || `https://github.com/${repo}/releases`,
    releaseName: release.name || `v${latestVersion}`,
    notes: String(release.body || '').trim(),
    publishedAt: release.published_at || null,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
    checksumAsset: checksumAsset ? { name: checksumAsset.name, url: checksumAsset.browser_download_url } : null,
  };
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

function parseChecksumForFile(text, fileName) {
  const lines = String(text || '').split(/\r?\n/);
  const target = fileName.toLowerCase();
  for (const line of lines) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && path.basename(m[2].trim()).toLowerCase() === target) {
      return m[1].toLowerCase();
    }
  }
  return null;
}

async function downloadAndInstall(updateInfo, onProgress = () => {}) {
  if (!updateInfo?.asset?.url || !updateInfo?.asset?.name) {
    throw new Error('В релизе не найден исполняемый файл (.exe) для Windows.');
  }
  const safeName = path.basename(updateInfo.asset.name);
  if (!/^[A-Za-z0-9._-]+\.exe$/i.test(safeName)) {
    throw new Error('Некорректное имя файла обновления.');
  }

  const dir = path.join(PATHS.cacheDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);

  onProgress({ stage: 'download', done: 0, total: updateInfo.asset.size || 0, file: safeName });
  await net.downloadFile(updateInfo.asset.url, dest, {
    onProgress: (done, total) => onProgress({ stage: 'download', done, total: total || updateInfo.asset.size || 0, file: safeName }),
  });

  if (updateInfo.checksumAsset?.url) {
    onProgress({ stage: 'verify', done: 0, total: 1, file: safeName });
    const res = await net.request(updateInfo.checksumAsset.url, { timeout: 15000 });
    if (res.status >= 200 && res.status < 300) {
      const expected = parseChecksumForFile(res.body.toString('utf8'), safeName);
      if (expected) {
        const actual = await sha256File(dest);
        if (actual !== expected) {
          try { fs.unlinkSync(dest); } catch {}
          throw new Error('Контрольная сумма SHA-256 загруженного обновления не совпала.');
        }
      }
    }
  }

  onProgress({ stage: 'launching', done: 1, total: 1, file: safeName });

  if (updateInfo.portable) {
    shell.showItemInFolder(dest);
    return { launched: false, portable: true, filePath: dest };
  }

  // Запускаем NSIS-установщик и мягко закрываем лаунчер
  const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => {
    try { app.quit(); } catch {}
  }, 600);
  return { launched: true, portable: false, filePath: dest };
}

module.exports = {
  normalizeRepo,
  isNewerVersion,
  pickReleaseAsset,
  parseChecksumForFile,
  checkForUpdates,
  downloadAndInstall,
  currentAppVersion,
  isPortableBuild,
};
