'use strict';

/**
 * horizon.js — полная интеграция Horizon (Minecraft: Java Edition на Rust:
 * https://github.com/horizon-rust/horizon) по официальному контракту Launch API 0.1.1.
 *
 * Поддерживает 1-клик запуск прямо из MossLauncher:
 *   1. Скачивает и проверяет сборку Horizon (Windows x64 + SHA256SUMS).
 *   2. Проверяет готовность ресурсов (`horizon-prepare --check`).
 *   3. Если ресурсы не готовы — автоматически:
 *      - находит или устанавливает требуемую Java (например, Java 25 из --launch-api);
 *      - скачивает нужную версию Minecraft (например, 26.3) через minecraft.js;
 *      - скачивает server.jar из version JSON (с проверкой SHA-1);
 *      - запускает `horizon-prepare --prepare --complete --progress json`.
 *   4. Запускает `horizon-client.exe` с `--resources`, `--game-dir`, `--home`,
 *      размерами окна и безопасной передачей Microsoft-сессии через `--session-stdin`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const AdmZip = require('adm-zip');
const net = require('./net');
const javaMod = require('./java');
const mc = require('./minecraft');
const { PATHS, API } = require('../shared/constants');

const HORIZON_REPO = 'horizon-rust/horizon';
const RELEASES_CACHE_TTL_MS = 15 * 60 * 1000;
const runningProcs = new Map();

function horizonDirs(settings = {}) {
  const root = path.join(settings.gameDir || PATHS.defaultGameDir, 'horizon');
  return {
    root,
    versions: path.join(root, 'versions'),
    resources: path.join(root, 'resources'),
    game: path.join(root, 'game'),
    cache: path.join(root, 'cache'),
    versionDir: (tag) => path.join(root, 'versions', safeTag(tag)),
  };
}

function safeTag(tag) {
  const s = String(tag || '').trim();
  if (!/^[A-Za-z0-9._@-]+$/.test(s)) throw new Error('Некорректный тег версии Horizon.');
  return s;
}

function findExecutable(dir, baseNames) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        if (baseNames.includes(e.name.toLowerCase())) return full;
      }
    }
  }
  return null;
}

function listInstalled(settings = {}) {
  const dirs = horizonDirs(settings);
  if (!fs.existsSync(dirs.versions)) return [];
  const out = [];
  for (const e of fs.readdirSync(dirs.versions, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const vdir = path.join(dirs.versions, e.name);
    const clientExe = findExecutable(vdir, ['horizon-client.exe', 'horizon.exe']);
    if (!clientExe) continue;
    const prepareExe = findExecutable(vdir, ['horizon-prepare.exe']);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(vdir, '.moss-horizon.json'), 'utf8')); } catch {}
    out.push({
      tag: e.name,
      dir: vdir,
      exeDir: path.dirname(clientExe),
      clientExe,
      prepareExe,
      installedAt: meta.installedAt || null,
      running: runningProcs.has(e.name),
    });
  }
  return out.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
}

function queryLaunchApi(exePath, rootDir = null) {
  return new Promise((resolve) => {
    const args = ['--launch-api'];
    if (rootDir) args.push('--root', rootDir);
    execFile(exePath, args, { cwd: rootDir || path.dirname(exePath), timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function checkResources(entry, settings = {}) {
  return new Promise((resolve) => {
    if (!entry?.prepareExe) return resolve(false);
    const dirs = horizonDirs(settings);
    const exeDir = path.dirname(entry.prepareExe);
    execFile(
      entry.prepareExe,
      ['--check', '--root', exeDir, '--output', dirs.resources],
      { cwd: exeDir, timeout: 10000, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

function hasPreparedResources(settings = {}) {
  const dirs = horizonDirs(settings);
  if (!fs.existsSync(dirs.resources)) return false;
  try { return fs.readdirSync(dirs.resources).length > 0; } catch { return false; }
}

function fallbackReleases() {
  return [{
    tag: 'nightly',
    name: 'Horizon Nightly (прямая ссылка)',
    publishedAt: null,
    url: `https://github.com/${HORIZON_REPO}/releases/tag/nightly`,
    asset: {
      name: 'horizon-windows-x64.zip',
      size: 0,
      url: `https://github.com/${HORIZON_REPO}/releases/download/nightly/horizon-windows-x64.zip`,
    },
    checksumUrl: `https://github.com/${HORIZON_REPO}/releases/download/nightly/SHA256SUMS`,
  }];
}

async function listReleases(settings = {}) {
  const dirs = horizonDirs(settings);
  const cacheFile = path.join(dirs.cache, 'releases.json');
  const installed = listInstalled(settings);
  let resourcesReady = hasPreparedResources(settings);
  if (installed[0] && resourcesReady) {
    resourcesReady = await checkResources(installed[0], settings);
  }

  let clientReleases = null;
  let warning = null;

  // Свежий кэш (15 минут), чтобы не упираться в лимиты GitHub API
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached.releases) && cached.releases.length && (Date.now() - (cached.at || 0)) < RELEASES_CACHE_TTL_MS) {
        clientReleases = cached.releases;
      }
    }
  } catch {}

  if (!clientReleases) {
    const headers = { Accept: 'application/vnd.github+json' };
    const token = settings.githubToken || process.env.GITHUB_TOKEN || '';
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const releases = await net.fetchJson(`${API.githubApi}/repos/${HORIZON_REPO}/releases?per_page=25`, {
        headers,
        timeout: 15000,
      });
      clientReleases = [];
      for (const r of releases || []) {
        const tag = String(r.tag_name || '');
        if (!tag || /^launcher@|^sdk-/i.test(tag)) continue;
        const asset = (r.assets || []).find((a) => /^horizon-windows-x64\.zip$/i.test(a.name || ''));
        if (!asset) continue;
        const checksumAsset = (r.assets || []).find((a) => /^SHA256SUMS$/i.test(a.name || '')) || null;
        clientReleases.push({
          tag,
          name: r.name || tag,
          publishedAt: r.published_at || null,
          url: r.html_url,
          asset: { name: asset.name, size: asset.size, url: asset.browser_download_url },
          checksumUrl: checksumAsset ? checksumAsset.browser_download_url : null,
        });
      }
      if (clientReleases.length) {
        fs.mkdirSync(dirs.cache, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), releases: clientReleases }, null, 2));
      }
    } catch (e) {
      // При лимите GitHub API используем прошлый кэш или прямую ссылку на nightly
      try {
        if (fs.existsSync(cacheFile)) {
          const stale = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (Array.isArray(stale.releases) && stale.releases.length) clientReleases = stale.releases;
        }
      } catch {}
      if (!clientReleases) clientReleases = fallbackReleases();
      warning = `Не удалось обновить список релизов с GitHub API (${e.message}). Используется резервный список.`;
    }
  }

  let requiredMc = null;
  let requiredJava = null;
  if (installed[0]?.prepareExe) {
    const api = await queryLaunchApi(installed[0].prepareExe, path.dirname(installed[0].prepareExe));
    if (api) {
      requiredMc = api.minecraft || null;
      requiredJava = api.java_major || null;
    }
  }

  return {
    repo: HORIZON_REPO,
    releases: clientReleases,
    installed,
    resourcesReady,
    requiredMc,
    requiredJava,
    warning,
    running: [...runningProcs.keys()],
  };
}

async function shaFile(file, algo = 'sha256') {
  const h = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

function parseSha256Sums(text, fileName) {
  const target = fileName.toLowerCase();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && path.basename(m[2].trim()).toLowerCase() === target) return m[1].toLowerCase();
  }
  return null;
}

function optionSet(apiObj) {
  const set = new Set();
  if (apiObj && Array.isArray(apiObj.options)) {
    for (const o of apiObj.options) if (o?.name) set.add(o.name);
  }
  return set;
}

async function installVersion(tag, settings = {}, onProgress = () => {}) {
  const cleanTag = safeTag(tag || 'nightly');
  const dirs = horizonDirs(settings);
  fs.mkdirSync(dirs.cache, { recursive: true });
  fs.mkdirSync(dirs.versions, { recursive: true });

  onProgress({ state: 'installing', stage: 'manifest', tag: cleanTag, message: `Получение релиза Horizon ${cleanTag}…` });
  const list = await listReleases(settings);
  const release = list.releases.find((r) => r.tag === cleanTag) || {
    tag: cleanTag,
    asset: {
      name: 'horizon-windows-x64.zip',
      size: 0,
      url: `https://github.com/${HORIZON_REPO}/releases/download/${encodeURIComponent(cleanTag)}/horizon-windows-x64.zip`,
    },
    checksumUrl: `https://github.com/${HORIZON_REPO}/releases/download/${encodeURIComponent(cleanTag)}/SHA256SUMS`,
  };

  const zipPath = path.join(dirs.cache, `${cleanTag}.zip`);
  onProgress({ state: 'installing', stage: 'download', tag: cleanTag, done: 0, total: release.asset.size, message: `Скачивание ${release.asset.name}…` });
  await net.downloadFile(release.asset.url, zipPath, {
    onProgress: (p) => onProgress({
      state: 'installing',
      stage: 'download',
      tag: cleanTag,
      done: p?.done || 0,
      total: p?.total || release.asset.size,
      message: `Скачивание ${release.asset.name}…`,
    }),
  });

  if (release.checksumUrl) {
    onProgress({ state: 'installing', stage: 'verify', tag: cleanTag, message: 'Проверка SHA-256…' });
    try {
      const res = await net.request(release.checksumUrl, { timeout: 15000 });
      if (res.status >= 200 && res.status < 300) {
        const expected = parseSha256Sums(res.body.toString('utf8'), release.asset.name);
        if (expected) {
          const actual = await shaFile(zipPath, 'sha256');
          if (actual !== expected) {
            try { fs.unlinkSync(zipPath); } catch {}
            throw new Error('Контрольная сумма SHA-256 архива Horizon не совпала.');
          }
        }
      }
    } catch (e) {
      if (/SHA-256/.test(e.message)) throw e;
    }
  }

  onProgress({ state: 'installing', stage: 'extract', tag: cleanTag, message: 'Распаковка Horizon…' });
  const targetDir = dirs.versionDir(cleanTag);
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);

  const clientExe = findExecutable(targetDir, ['horizon-client.exe', 'horizon.exe']);
  const prepareExe = findExecutable(targetDir, ['horizon-prepare.exe']);
  if (!clientExe) throw new Error('В архиве Horizon не найден horizon-client.exe.');

  fs.writeFileSync(path.join(targetDir, '.moss-horizon.json'), JSON.stringify({
    tag: cleanTag,
    installedAt: Date.now(),
    clientExe,
    prepareExe,
  }, null, 2));

  onProgress({ state: 'idle', stage: 'done', tag: cleanTag, message: `Horizon ${cleanTag} установлен.` });
  return { tag: cleanTag, dir: targetDir, exeDir: path.dirname(clientExe), clientExe, prepareExe };
}

/**
 * Автоматически подготавливает всё, что требует `horizon-prepare`:
 * Java нужной версии (например, 25), Minecraft нужной версии (например, 26.3),
 * server.jar из манифеста Mojang, и затем запускает `horizon-prepare --prepare --complete`.
 */
async function prepareAssets(tag, settings = {}, onLog = () => {}, onProgress = () => {}) {
  const installed = listInstalled(settings);
  const entry = installed.find((i) => i.tag === tag) || installed[0];
  if (!entry) throw new Error('Сначала установите сборку Horizon.');
  if (!entry.prepareExe) throw new Error('В установленной сборке Horizon не найден horizon-prepare.exe.');

  const dirs = horizonDirs(settings);
  const exeDir = path.dirname(entry.prepareExe);
  fs.mkdirSync(dirs.resources, { recursive: true });
  fs.mkdirSync(dirs.cache, { recursive: true });

  const api = await queryLaunchApi(entry.prepareExe, exeDir);
  const mcVersion = api?.minecraft || '26.3';
  const javaMajor = api?.java_major || 25;
  const opts = optionSet(api);

  // 1. Java нужной версии (например, 25)
  onProgress({ state: 'preparing', stage: 'java', tag: entry.tag, message: `Проверка Java ${javaMajor} для подготовки Horizon…` });
  let javaFound = await javaMod.detectJava(javaMajor, settings.javaPath);
  if (!javaFound.found) {
    onProgress({ state: 'preparing', stage: 'java', tag: entry.tag, message: `Установка Temurin Java ${javaMajor}…` });
    const installedJava = await javaMod.installJava(javaMajor, (p) => {
      onProgress({ state: 'preparing', stage: 'java', tag: entry.tag, message: p?.stage === 'extract' ? `Распаковка Java ${javaMajor}…` : `Скачивание Java ${javaMajor}…` });
    });
    javaFound = { found: installedJava };
  }
  const javaHome = path.resolve(path.dirname(javaFound.found.path), '..');
  onLog(`[horizon] java ${javaMajor}: ${javaHome}`);

  // 2. Minecraft client + libraries + assets (через стандартный загрузчик MossLauncher)
  const mcDirs = mc.gameDirs(settings);
  const versionJsonPath = mcDirs.versionJson(mcVersion);
  const clientJarPath = mcDirs.versionJar(mcVersion);
  onProgress({ state: 'preparing', stage: 'minecraft', tag: entry.tag, message: `Проверка файлов Minecraft ${mcVersion}…` });
  await mc.installVersion(mcVersion, settings, (p) => {
    if (p.stage === 'done') return;
    const pct = p.total > 0 ? Math.floor((100 * (p.done || 0)) / p.total) : null;
    onProgress({
      state: 'preparing',
      stage: 'minecraft',
      tag: entry.tag,
      done: p.done || 0,
      total: p.total || 0,
      message: `Minecraft ${mcVersion} (${p.stage})${pct !== null ? `: ${pct}%` : '…'}`,
    });
  });

  if (!fs.existsSync(versionJsonPath) || !fs.existsSync(clientJarPath)) {
    throw new Error(`Не удалось подготовить файлы Minecraft ${mcVersion}.`);
  }

  // 2b. Сырой (непереформатированный) manifest JSON от Mojang под точный SHA-1 из research-lock.json
  // (minecraft.js сохраняет 26.3.json через JSON.stringify, меняя пробелы и SHA-1)
  let rawManifestPath = versionJsonPath;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(exeDir, 'research-lock.json'), 'utf8'));
    const expectedManifestSha1 = lock?.minecraft?.manifest_sha1;
    if (expectedManifestSha1) {
      const candidate = path.join(dirs.cache, `manifest-${mcVersion}-${expectedManifestSha1.slice(0, 8)}.json`);
      let needRaw = !fs.existsSync(candidate);
      if (!needRaw && (await shaFile(candidate, 'sha1')) !== expectedManifestSha1.toLowerCase()) needRaw = true;
      if (needRaw) {
        const rawUrl = `${API.pistonMeta}/v1/packages/${expectedManifestSha1}/${mcVersion}.json`;
        await net.downloadFile(rawUrl, candidate, { sha1: expectedManifestSha1 });
      }
      rawManifestPath = candidate;
      // Также проверяем, что сырой файл assetIndex совпадает по SHA-1 и все его объекты скачаны
      // (Mojang мог перевыпустить 26.3 с другим хешем пары языковых файлов)
      const rawManifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const ai = rawManifest.assetIndex;
      if (ai?.id && ai?.url && ai?.sha1) {
        const aiPath = path.join(mcDirs.assets, 'indexes', `${ai.id}.json`);
        if (!fs.existsSync(aiPath) || (await shaFile(aiPath, 'sha1')) !== ai.sha1.toLowerCase()) {
          await net.downloadFile(ai.url, aiPath, { sha1: ai.sha1 });
        }
        const aiJson = JSON.parse(fs.readFileSync(aiPath, 'utf8'));
        const missingObjs = [];
        for (const obj of Object.values(aiJson.objects || {})) {
          if (!obj?.hash) continue;
          const pref = obj.hash.slice(0, 2);
          const objFile = path.join(mcDirs.assets, 'objects', pref, obj.hash);
          if (!fs.existsSync(objFile)) missingObjs.push({ sha1: obj.hash, size: obj.size, dest: objFile, url: `${API.resources}/${pref}/${obj.hash}` });
        }
        if (missingObjs.length) {
          onProgress({ state: 'preparing', stage: 'minecraft', tag: entry.tag, message: `Докачка недостающих ассетов (${missingObjs.length})…` });
          await net.downloadAll(missingObjs, {
            concurrency: 8,
            onProgress: (p) => onProgress({ state: 'preparing', stage: 'minecraft', tag: entry.tag, done: p.done, total: p.total, message: `Докачка ассетов: ${p.done} / ${p.total}` }),
          });
        }
      }
    }
  } catch (e) {
    onLog(`[horizon] raw manifest note: ${e.message}`);
  }

  // 3. Server JAR из version JSON (downloads.server)
  const vjson = JSON.parse(fs.readFileSync(rawManifestPath, 'utf8'));
  const serverInfo = vjson.downloads?.server;
  if (!serverInfo?.url) {
    throw new Error(`В манифесте Minecraft ${mcVersion} нет ссылки на server.jar.`);
  }
  const serverJarPath = path.join(dirs.cache, `server-${mcVersion}.jar`);
  let needServerJar = !fs.existsSync(serverJarPath);
  if (!needServerJar && serverInfo.sha1) {
    const actualSha1 = await shaFile(serverJarPath, 'sha1');
    if (actualSha1 !== serverInfo.sha1.toLowerCase()) needServerJar = true;
  }
  if (needServerJar) {
    onProgress({ state: 'preparing', stage: 'server-jar', tag: entry.tag, done: 0, total: serverInfo.size || 0, message: `Скачивание server.jar (${mcVersion})…` });
    await net.downloadFile(serverInfo.url, serverJarPath, {
      size: serverInfo.size || null,
      sha1: serverInfo.sha1 || null,
      onProgress: (p) => onProgress({
        state: 'preparing',
        stage: 'server-jar',
        tag: entry.tag,
        done: p?.done || 0,
        total: p?.total || serverInfo.size || 0,
        message: `Скачивание server.jar (${mcVersion})…`,
      }),
    });
  }

  // 4. Запуск horizon-prepare с точными флагами Launch API 0.1.1
  const args = [];
  if (!opts.size || opts.has('--prepare')) args.push('--prepare');
  if (!opts.size || opts.has('--root')) args.push('--root', exeDir);
  if (!opts.size || opts.has('--output')) args.push('--output', dirs.resources);
  if (!opts.size || opts.has('--version-json')) args.push('--version-json', rawManifestPath);
  if (!opts.size || opts.has('--client-jar')) args.push('--client-jar', clientJarPath);
  if (!opts.size || opts.has('--libraries-dir')) args.push('--libraries-dir', mcDirs.libraries);
  if (!opts.size || opts.has('--assets-dir')) args.push('--assets-dir', mcDirs.assets);
  if (!opts.size || opts.has('--server-jar')) args.push('--server-jar', serverJarPath);
  if (!opts.size || opts.has('--java-home')) args.push('--java-home', javaHome);
  if (!opts.size || opts.has('--complete')) args.push('--complete');
  if (!opts.size || opts.has('--progress')) args.push('--progress', 'json');

  const env = { ...process.env, JAVA_HOME: javaHome };
  onProgress({ state: 'preparing', stage: 'prepare', tag: entry.tag, fraction: 0, message: `Экспорт ресурсов Minecraft ${mcVersion} в формат Horizon…` });
  onLog(`[horizon] prepare: ${entry.prepareExe} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    let lastError = '';
    const proc = spawn(entry.prepareExe, args, {
      cwd: exeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdoutBuf = '';
    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.trim().startsWith('{')) {
          try {
            const j = JSON.parse(line);
            if (j.error) lastError = j.error;
            if (j.message) onLog(`[horizon-prepare] ${j.message}`);
            if (typeof j.fraction === 'number' || j.message) {
              onProgress({
                state: 'preparing',
                stage: 'prepare',
                tag: entry.tag,
                fraction: typeof j.fraction === 'number' ? j.fraction : undefined,
                message: j.message || `Подготовка ресурсов (${Math.round((j.fraction || 0) * 100)}%)…`,
              });
            }
            continue;
          } catch {}
        }
        onLog(`[horizon-prepare] ${line}`);
      }
    });
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      onLog(text);
      const trimmed = text.trim();
      if (trimmed) lastError = trimmed.split(/\r?\n/).slice(-1)[0];
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        onProgress({ state: 'preparing', stage: 'ready', tag: entry.tag, fraction: 1, message: 'Ресурсы Horizon готовы.' });
        resolve({ ok: true, resourcesDir: dirs.resources });
      } else {
        reject(new Error(lastError || `horizon-prepare завершился с кодом ${code}. Подробности на вкладке «Логи».`));
      }
    });
  });
}

async function launch(tag, settings = {}, account, onLog = () => {}, onState = () => {}, options = {}) {
  let installed = listInstalled(settings);
  let entry = installed.find((i) => i.tag === tag) || installed[0];

  // Авто-установка, если нажали «Играть» для ещё не скачанной сборки
  if (!entry) {
    await installVersion(tag || 'nightly', settings, onState);
    installed = listInstalled(settings);
    entry = installed.find((i) => i.tag === (tag || 'nightly')) || installed[0];
  }
  if (!entry) throw new Error('Не удалось найти установленную сборку Horizon.');
  if (runningProcs.has(entry.tag)) throw new Error('Horizon уже запущен.');

  // Авто-подготовка ресурсов, если --check не проходит
  const ready = await checkResources(entry, settings);
  if (!ready) {
    await prepareAssets(entry.tag, settings, onLog, onState);
  }

  const dirs = horizonDirs(settings);
  const exeDir = path.dirname(entry.clientExe);
  fs.mkdirSync(dirs.game, { recursive: true });
  fs.mkdirSync(dirs.resources, { recursive: true });

  const api = await queryLaunchApi(entry.clientExe, exeDir);
  const opts = optionSet(api);
  const args = [];

  if (!opts.size || opts.has('--resources')) args.push('--resources', dirs.resources);
  if (!opts.size || opts.has('--game-dir')) args.push('--game-dir', dirs.game);
  if (!opts.size || opts.has('--home')) args.push('--home', dirs.game);
  const width = parseInt(settings.windowWidth, 10) || 1280;
  const height = parseInt(settings.windowHeight, 10) || 720;
  if (!opts.size || opts.has('--width')) args.push('--width', String(width));
  if (!opts.size || opts.has('--height')) args.push('--height', String(height));
  if (settings.fullscreen && (!opts.size || opts.has('--fullscreen'))) args.push('--fullscreen');
  if (options.server && (!opts.size || opts.has('--quickPlayMultiplayer'))) {
    args.push('--quickPlayMultiplayer', String(options.server).trim());
  }

  const hasMsSession = !!(account && account.type === 'microsoft' && account.mcAccessToken);
  const useSessionStdin = hasMsSession && (!opts.size || opts.has('--session-stdin'));
  if (useSessionStdin) {
    args.push('--session-stdin');
  } else if (account?.username) {
    // Для офлайн-аккаунта записываем имя игрока в horizon-player.txt внутри --game-dir
    try {
      fs.writeFileSync(path.join(dirs.game, 'horizon-player.txt'), String(account.username).trim() + '\n', 'utf8');
    } catch {}
  }

  onLog(`[horizon] launch: ${entry.clientExe} ${args.join(' ')}`);
  onState({ state: 'starting', tag: entry.tag, message: 'Запуск Minecraft на Rust (Horizon)…' });

  const proc = spawn(entry.clientExe, args, {
    cwd: exeDir,
    env: { ...process.env, HORIZON_HOME: dirs.game },
    stdio: [useSessionStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  if (useSessionStdin && proc.stdin) {
    // Точная схема Session JSON из docs/api/launch.md:
    // {"name": "...", "uuid": "...", "access_token": "...", "user_type": "msa"}
    const sessionPayload = JSON.stringify({
      name: account.username,
      uuid: String(account.uuid || '').replace(/-/g, ''),
      access_token: account.mcAccessToken,
      user_type: 'msa',
    });
    proc.stdin.write(sessionPayload + '\n');
    proc.stdin.end();
  }

  runningProcs.set(entry.tag, proc);
  proc.stdout.on('data', (d) => onLog(d.toString()));
  proc.stderr.on('data', (d) => onLog(d.toString()));

  return new Promise((resolve, reject) => {
    proc.on('spawn', () => {
      onLog(`[horizon] process started (pid ${proc.pid})`);
      onState({ state: 'running', tag: entry.tag, message: 'Horizon (Rust) запущен' });
    });
    proc.on('error', (e) => {
      runningProcs.delete(entry.tag);
      onState({ state: 'error', tag: entry.tag, message: e.message });
      reject(e);
    });
    proc.on('close', (code) => {
      runningProcs.delete(entry.tag);
      onState({
        state: code === 0 ? 'idle' : 'error',
        tag: entry.tag,
        code,
        message: code === 0 ? 'Horizon закрыт' : `Horizon завершился с кодом ${code}`,
      });
      resolve({ code, instanceDir: dirs.game });
    });
  });
}

function stop(tag) {
  if (tag && runningProcs.has(tag)) {
    try { runningProcs.get(tag).kill('SIGKILL'); } catch {}
    runningProcs.delete(tag);
    return true;
  }
  let stopped = false;
  for (const [k, p] of runningProcs) {
    try { p.kill('SIGKILL'); } catch {}
    runningProcs.delete(k);
    stopped = true;
  }
  return stopped;
}

function removeVersion(tag, settings = {}) {
  const cleanTag = safeTag(tag);
  if (runningProcs.has(cleanTag)) stop(cleanTag);
  const dir = horizonDirs(settings).versionDir(cleanTag);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = {
  HORIZON_REPO,
  horizonDirs,
  listInstalled,
  listReleases,
  checkResources,
  installVersion,
  prepareAssets,
  launch,
  stop,
  removeVersion,
  parseSha256Sums,
};
