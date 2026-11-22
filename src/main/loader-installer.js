'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Forge-family installers require a launcher profile even for a fresh directory. */
function ensureLauncherProfile(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'launcher_profiles.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never replace an existing user's profile, including malformed files.
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!profile || typeof profile.profiles !== 'object' || !profile.profiles) {
      throw new Error('Некорректный launcher_profiles.json. Существующий файл сохранён: ' + file);
    }
  }
  return file;
}

async function runInstaller({ installer, root, javaPath, label }) {
  ensureLauncherProfile(root);
  const consoleJava = path.join(path.dirname(javaPath), 'java.exe');
  const executable = fs.existsSync(consoleJava) ? consoleJava : javaPath;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-jar', installer, '--installClient', root], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const append = (data) => { tail = (tail + data.toString()).slice(-4000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${label}: установщик завершился с кодом ${code}\n${tail}`)));
  });
}

function readInstallerJson(installer, entry) {
  const zip = new (require('adm-zip'))(installer);
  const text = zip.readAsText(entry);
  return text ? JSON.parse(text) : null;
}

function installerProfileId(installer) {
  const profile = readInstallerJson(installer, 'version.json');
  if (!profile || typeof profile.id !== 'string' || !/^[\w.+-]+$/.test(profile.id)) {
    throw new Error('Установщик содержит некорректный идентификатор версии');
  }
  return profile.id;
}

/** "[group:name:version:classifier@ext]" → относительный путь в libraries/. */
function mavenPath(coordinate) {
  const clean = String(coordinate).replace(/^\[|\]$/g, '');
  const [coord, ext = 'jar'] = clean.split('@');
  const [group, name, version, classifier] = coord.split(':');
  if (!group || !name || !version) return null;
  return `${group.replace(/\./g, '/')}/${name}/${version}/${name}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
}

/**
 * Что установщик должен скачать и что он обязан создать.
 *  - libraries: все артефакты с URL из install_profile.json и version.json
 *  - patched: путь (относительно libraries/) к пропатченному клиенту, без
 *    которого игра падает с NoClassDefFoundError net/minecraft/...
 */
function installerArtifacts(installer) {
  const profile = readInstallerJson(installer, 'install_profile.json') || {};
  const version = readInstallerJson(installer, 'version.json') || {};
  const byPath = new Map();
  for (const lib of [...(profile.libraries || []), ...(version.libraries || [])]) {
    const a = lib && lib.downloads && lib.downloads.artifact;
    if (!a || !a.url || !a.path) continue; // пустой url = артефакт создаётся процессорами
    byPath.set(a.path, { url: a.url, rel: a.path, size: a.size ?? null, sha1: a.sha1 || null, name: lib.name });
  }
  const patchedCoord = profile.data && profile.data.PATCHED && profile.data.PATCHED.client;
  return { libraries: [...byPath.values()], patched: patchedCoord ? mavenPath(patchedCoord) : null };
}

/**
 * Заранее скачивает библиотеки установщика через сетевой слой лаунчера
 * (с зеркалами). Установщик Forge/NeoForge качает сам и не умеет зеркала:
 * если maven.neoforged.net недоступен, он падает и не создаёт клиент.
 * Скачанные файлы он находит на месте («exists. Checksum valid»).
 */
async function prefetchInstallerLibraries(installer, root, label, onProgress = () => {}) {
  const { downloadAll } = require('./net');
  const { libraries } = installerArtifacts(installer);
  const jobs = libraries.map((l) => ({ url: l.url, dest: path.join(root, 'libraries', l.rel), size: l.size, sha1: l.sha1, label: l.name }));
  onProgress({ stage: 'loader-libraries', done: 0, total: jobs.length });
  const res = await downloadAll(jobs, { onProgress: (p) => onProgress({ stage: 'loader-libraries', done: p.done, total: jobs.length }) });
  if (res.errors.length) {
    const list = res.errors.slice(0, 5).map((e) => `  ${e.item.label}: ${e.error}`).join('\n');
    throw new Error(`${label}: не удалось скачать ${res.errors.length} библиотек (проверьте интернет/VPN):\n${list}`);
  }
  return jobs.length;
}

module.exports = {
  ensureLauncherProfile, runInstaller, installerProfileId,
  installerArtifacts, prefetchInstallerLibraries, mavenPath,
};
