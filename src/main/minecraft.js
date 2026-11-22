'use strict';

/**
 * minecraft.js — version install + game launch.
 *
 * installVersion(id):
 *   1. version manifest → version JSON URL (cached in <gameDir>/versions/<id>/<id>.json)
 *   2. download client jar
 *   3. evaluate library rules → download jars, extract natives (windows rules only)
 *   4. asset index → download missing objects
 *   5. optional loader install (fabric/quilt via their meta, forge/neoforge via installer)
 *
 * launchVersion(id):
 *   resolves version inheritance, builds JVM+game args from the version JSON
 *   argument templates (${var} substitution), classpath, natives dir, and
 *   spawns java with the account's tokens.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { PATHS, API, GAME } = require('../shared/constants');
const { fetchJson, downloadFile, downloadAll } = require('./net');
const { ensureDir, readJson, writeJson } = require('./storage');
const AdmZip = require('adm-zip');

let manifestCache = { at: 0, data: null };
const gameProcesses = new Map(); // key: versionId → proc

// ---------------------------------------------------------------- manifest
async function getVersionManifest(force = false) {
  if (!force && manifestCache.data && Date.now() - manifestCache.at < 15 * 60 * 1000) {
    return manifestCache.data;
  }
  const data = await fetchJson(API.versionManifest);
  manifestCache = { at: Date.now(), data };
  return data;
}

async function listVersions({ releasesOnly = false } = {}) {
  const m = await getVersionManifest();
  return m.versions
    .filter((v) => !releasesOnly || v.type === 'release')
    .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url }));
}

function gameDirs(settings) {
  const root = settings.gameDir || PATHS.defaultGameDir;
  return {
    root,
    versions: path.join(root, 'versions'),
    libraries: path.join(root, 'libraries'),
    assets: path.join(root, 'assets'),
    objects: path.join(root, 'assets', 'objects'),
    indexes: path.join(root, 'assets', 'indexes'),
    natives: (versionId) => path.join(root, 'versions', versionId, 'natives'),
    versionDir: (versionId) => path.join(root, 'versions', versionId),
    versionJson: (versionId) => path.join(root, 'versions', versionId, `${versionId}.json`),
    versionJar: (versionId) => path.join(root, 'versions', versionId, `${versionId}.jar`),
  };
}

function listInstalled(settings) {
  const dirs = gameDirs(settings);
  try {
    return fs.readdirSync(dirs.versions).filter((d) => {
      const marker = readJson(path.join(dirs.versionDir(d), '.moss-installed'), null);
      return marker && !marker.installing && !marker.dependency &&
        fs.existsSync(dirs.versionJson(d)) && fs.existsSync(dirs.versionJar(d));
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- rules
/** Evaluate a version-JSON "rules" array. Returns true if allowed. */
function rulesAllow(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    let osOk = true;
    if (rule.os) {
      if (rule.os.name) {
        const name = { windows: 'windows', osx: 'osx', linux: 'linux' }[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
        osOk = rule.os.name === name;
      }
      if (osOk && rule.os.arch) {
        osOk = rule.os.arch === 'x86' ? process.arch === 'ia32' : true;
      }
      if (osOk && rule.os.version) {
        osOk = new RegExp(rule.os.version).test(os.release());
      }
    }
    let featOk = true;
    if (rule.features) {
      featOk = Object.entries(rule.features).every(([k, v]) => features[k] === v);
    }
    if (osOk && featOk) allowed = rule.action === 'allow';
  }
  return allowed;
}

// ---------------------------------------------------------------- artifacts
function artifactPath(lib) {
  const [coordinate, extension = 'jar'] = lib.name.split('@');
  const [group, name, version, classifier] = coordinate.split(':');
  const rel = `${group.replace(/\./g, '/')}/${name}/${version}/${name}-${version}${classifier ? '-' + classifier : ''}.${extension}`;
  return rel;
}

function classifierForNatives(natives) {
  if (!natives) return null;
  if (process.platform === 'win32') return natives.windows;
  if (process.platform === 'darwin') return natives.osx;
  return natives.linux;
}

function libraryEntries(vjson, features = {}) {
  const libs = [];
  const natives = [];
  for (const lib of vjson.libraries || []) {
    if (!rulesAllow(lib.rules, features)) continue;
    const rel = artifactPath(lib);
    if (lib.downloads && lib.downloads.artifact) {
      libs.push({ ...lib.downloads.artifact, rel: lib.downloads.artifact.path || rel, name: lib.name });
    } else {
      libs.push({ rel, url: (lib.url || API.libraries + '/') + rel, name: lib.name });
    }
    // natives
    const classifier = classifierForNatives(lib.natives);
    if (classifier && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier]) {
      natives.push({ ...lib.downloads.classifiers[classifier], extract: lib.extract || {}, name: lib.name });
    }
  }
  return { libs, natives };
}

// ---------------------------------------------------------------- install
async function fetchVersionJson(id, settings) {
  const dirs = gameDirs(settings);
  const local = dirs.versionJson(id);
  if (fs.existsSync(local)) return readJson(local, null);
  const manifest = await getVersionManifest();
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) return null;
  ensureDir(dirs.versionDir(id));
  const res = await fetchJson(entry.url);
  writeJson(local, res);
  return res;
}

/** Resolve parent version (inheritsFrom) chain → merged JSON (child wins). */
async function resolveVersionJson(id, settings) {
  const chain = [];
  const visited = new Set([id]);
  let cur = await fetchVersionJson(id, settings);
  if (!cur) throw new Error(`Версия ${id} не найдена`);
  chain.unshift(cur);
  while (cur.inheritsFrom) {
    const parent = cur.inheritsFrom;
    if (visited.has(parent)) throw new Error(`Циклическая зависимость версии: ${parent}`);
    visited.add(parent);
    cur = await fetchVersionJson(parent, settings);
    if (!cur) throw new Error(`Родительская версия ${parent} не найдена`);
    chain.unshift(cur);
  }
  // merge: libraries concat, scalars from child
  const merged = { ...chain[0] };
  merged.libraries = [...(chain[0].libraries || [])];
  for (let i = 1; i < chain.length; i++) {
    const child = chain[i];
    for (const [k, v] of Object.entries(child)) {
      if (k === 'libraries') merged.libraries.push(...(v || []));
      else if (k === 'arguments') merged.arguments = { game: [...(merged.arguments?.game || []), ...(v.game || [])], jvm: [...(merged.arguments?.jvm || []), ...(v.jvm || [])] };
      else merged[k] = v;
    }
  }
  merged.id = id;
  const uniqueLibraries = new Map();
  for (const lib of merged.libraries) {
    const [group, name, _version, classifier = ''] = lib.name.split(':');
    uniqueLibraries.set(`${group}:${name}:${classifier}`, lib);
  }
  merged.libraries = [...uniqueLibraries.values()];
  return merged;
}

/**
 * Install everything needed for a version. `onProgress({stage, done, total})`.
 */
async function installVersion(id, settings, onProgress = () => {}, { dependency = false } = {}) {
  const dirs = gameDirs(settings);
  const markerPath = path.join(dirs.versionDir(id), '.moss-installed');
  const previous = readJson(markerPath, null);
  const hiddenDependency = dependency && (!previous || previous.dependency === true);
  writeJson(markerPath, { installing: true, dependency: hiddenDependency });
  ensureDir(dirs.versions); ensureDir(dirs.libraries); ensureDir(dirs.objects); ensureDir(dirs.indexes);

  onProgress({ stage: 'manifest', done: 0, total: 0 });
  const vjson = await resolveVersionJson(id, settings);

  const features = { is_demo_user: false, has_custom_resolution: false };
  const { libs, natives } = libraryEntries(vjson, features);

  const jobs = [];
  // client jar
  const client = vjson.downloads && vjson.downloads.client;
  if (client) {
    jobs.push({
      url: client.url, dest: dirs.versionJar(id),
      size: client.size, sha1: client.sha1, label: `client ${id}`,
    });
  }
  for (const l of libs) {
    jobs.push({ url: l.url, dest: path.join(dirs.libraries, l.rel), size: l.size, sha1: l.sha1, label: l.name });
  }
  for (const n of natives) {
    jobs.push({ url: n.url, dest: path.join(dirs.libraries, n.path), size: n.size, sha1: n.sha1, label: n.name + ' natives' });
  }

  onProgress({ stage: 'libraries', done: 0, total: jobs.length });
  const res = await downloadAll(jobs, { onProgress: (p) => onProgress({ stage: 'libraries', done: p.done, total: jobs.length }) });
  if (res.errors.length) {
    throw new Error(`Не удалось скачать ${res.errors.length} файлов: ${res.errors[0].error}`);
  }

  // extract natives
  onProgress({ stage: 'natives', done: 0, total: natives.length });
  const nativesDir = dirs.natives(id);
  ensureDir(nativesDir);
  let ni = 0;
  for (const n of natives) {
    const jar = path.join(dirs.libraries, n.path);
    if (!fs.existsSync(jar)) { ni++; continue; }
    try {
      const zip = new AdmZip(jar);
      const exclude = (n.extract && n.extract.exclude) || [];
      for (const e of zip.getEntries()) {
        const name = e.entryName;
        if (e.isDirectory) continue;
        if (name.startsWith('META-INF/')) continue;
        if (exclude.some((x) => name.startsWith(x))) continue;
        const target = path.join(nativesDir, name);
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, e.getData());
      }
    } catch {}
    ni++;
    onProgress({ stage: 'natives', done: ni, total: natives.length });
  }

  // assets
  const ai = vjson.assetIndex;
  if (ai) {
    onProgress({ stage: 'assetindex', done: 0, total: 1 });
    const indexPath = path.join(dirs.indexes, `${ai.id}.json`);
    await downloadFile(ai.url, indexPath, { size: ai.size, sha1: ai.sha1 });
    const index = readJson(indexPath, { objects: {} });
    const objJobs = Object.entries(index.objects || {}).map(([name, o]) => ({
      url: `${API.resources}/${o.hash.slice(0, 2)}/${o.hash}`,
      dest: path.join(dirs.objects, o.hash.slice(0, 2), o.hash),
      size: o.size, sha1: o.hash, label: name,
    }));
    onProgress({ stage: 'assets', done: 0, total: objJobs.length });
    const ares = await downloadAll(objJobs, {
      concurrency: 16,
      onProgress: (p) => onProgress({ stage: 'assets', done: p.done, total: objJobs.length }),
    });
    if (ares.errors.length) {
      throw new Error(`Ассеты: ошибок ${ares.errors.length}, первый: ${ares.errors[0].error}`);
    }
  }

  writeJson(markerPath, { installedAt: Date.now(), dependency: hiddenDependency });
  onProgress({ stage: 'done', done: 1, total: 1 });
  return { id };
}

// ---------------------------------------------------------------- args
const VAR_RE = /\$\{([^}]+)\}/g;

function substitute(str, vars) {
  return str.replace(VAR_RE, (_, k) => (vars[k] !== undefined ? vars[k] : '${' + k + '}'));
}

function buildArgs(argSpec, vars) {
  if (!argSpec) return [];
  const out = [];
  for (const a of argSpec) {
    if (typeof a === 'string') { out.push(substitute(a, vars)); continue; }
    if (a && a.rules && rulesAllow(a.rules, vars.features)) {
      const v = a.value;
      (Array.isArray(v) ? v : [v]).forEach((s) => out.push(substitute(s, vars)));
    }
  }
  return out.filter(Boolean);
}

function buildLegacyArgs(minecraftArguments, vars) {
  // old format: single string of space-separated args
  return minecraftArguments.split(/\s+/).map((s) => substitute(s, vars)).filter(Boolean);
}

// ---------------------------------------------------------------- loaders
async function installFabric(mcVersion, settings, onProgress, selectedVersion) {
  const loaderVer = await require('./loaders').chooseLoaderVersion('fabric', mcVersion, selectedVersion);
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/profile/json`;
  const profile = await fetchJson(profileUrl);
  const id = `fabric-loader-${loaderVer}-${mcVersion}`;
  const dirs = gameDirs(settings);
  ensureDir(dirs.versionDir(id));
  writeJson(dirs.versionJson(id), profile);
  await installVersion(id, settings, onProgress);
  return id;
}

async function installQuilt(mcVersion, settings, onProgress, selectedVersion) {
  const loaderVer = await require('./loaders').chooseLoaderVersion('quilt', mcVersion, selectedVersion);
  const profile = await fetchJson(`https://meta.quiltmc.org/v3/versions/loader/${mcVersion}/${loaderVer}/profile/json`);
  const id = `quilt-loader-${loaderVer}-${mcVersion}`;
  const dirs = gameDirs(settings);
  ensureDir(dirs.versionDir(id));
  writeJson(dirs.versionJson(id), profile);
  await installVersion(id, settings, onProgress);
  return id;
}

async function installForge(mcVersion, settings, onProgress, selectedVersion) {
  const forgeVer = await require('./loaders').chooseLoaderVersion('forge', mcVersion, selectedVersion);
  const full = `${mcVersion}-${forgeVer}`;
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  const installer = path.join(PATHS.cacheDir, `forge-${full}-installer.jar`);
  await downloadFile(installerUrl, installer, { timeout: 120000 });

  const id = await installForgeFamily('Forge', mcVersion, installer, settings, onProgress);
  await installVersion(id, settings, onProgress);
  return id;
}

async function installNeoForge(mcVersion, settings, onProgress, selectedVersion) {
  const ver = await require('./loaders').chooseLoaderVersion('neoforge', mcVersion, selectedVersion);
  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
  const installer = path.join(PATHS.cacheDir, `neoforge-${ver}-installer.jar`);
  await downloadFile(installerUrl, installer, { timeout: 120000 });
  const id = await installForgeFamily('NeoForge', mcVersion, installer, settings, onProgress);
  await installVersion(id, settings, onProgress);
  return id;
}

async function installForgeFamily(label, mcVersion, installer, settings, onProgress) {
  const { detectJava, requiredJavaForMc } = require('./java');
  const { runInstaller, installerProfileId, installerArtifacts, prefetchInstallerLibraries } = require('./loader-installer');
  const major = requiredJavaForMc(mcVersion);
  const java = await detectJava(major, settings.javaPath);
  if (!java.found) throw new Error(`Для ${label} ${mcVersion} нужна Java ${major}. Установите её в настройках → Java.`);
  const id = installerProfileId(installer);
  const dirs = gameDirs(settings);
  // Пока установщик не отработал успешно, версия не считается установленной.
  writeJson(path.join(dirs.versionDir(id), '.moss-installed'), { installing: true, dependency: false });
  await installVersion(mcVersion, settings, onProgress, { dependency: true });
  // Библиотеки качаем сами (с зеркалами), установщик их только проверит.
  await prefetchInstallerLibraries(installer, dirs.root, label, onProgress);
  onProgress({ stage: 'loader', done: 0, total: 0 });
  await runInstaller({ installer, root: dirs.root, javaPath: java.found.path, label });
  if (!fs.existsSync(dirs.versionJson(id))) throw new Error(`${label}: профиль ${id} не создан установщиком`);
  const { patched } = installerArtifacts(installer);
  if (patched && !fs.existsSync(path.join(dirs.libraries, patched))) {
    throw new Error(`${label}: установщик не создал пропатченный клиент (${path.basename(patched)}). Переустановите версию.`);
  }
  if (patched) {
    // запоминаем, какой файл обязателен для запуска этой версии
    const vjsonPath = dirs.versionJson(id);
    const vj = readJson(vjsonPath, null);
    if (vj && vj.mossPatchedClient !== patched) { vj.mossPatchedClient = patched; writeJson(vjsonPath, vj); }
  }
  return id;
}

/**
 * Для Forge/NeoForge (BootstrapLauncher) игра берёт классы Minecraft из
 * пропатченного клиента в libraries/, созданного установщиком. Если его нет —
 * игра падает с NoClassDefFoundError net/minecraft/... Проверяем заранее.
 */
function missingPatchedClient(vjson, dirs) {
  if (!vjson || !/bootstraplauncher/i.test(vjson.mainClass || '')) return null;
  let rel = vjson.mossPatchedClient;
  if (!rel) {
    const nf = (vjson.arguments?.game || []).join(' ').match(/--fml\.neoForgeVersion\s+(\S+)/);
    const forge = (vjson.arguments?.game || []).join(' ').match(/--fml\.forgeVersion\s+(\S+)/);
    const mc = (vjson.arguments?.game || []).join(' ').match(/--fml\.mcVersion\s+(\S+)/);
    if (nf) rel = `net/neoforged/neoforge/${nf[1]}/neoforge-${nf[1]}-client.jar`;
    else if (forge && mc) rel = `net/minecraftforge/forge/${mc[1]}-${forge[1]}/forge-${mc[1]}-${forge[1]}-client.jar`;
  }
  if (!rel) return null;
  return fs.existsSync(path.join(dirs.libraries, rel)) ? null : rel;
}

function neoforgePrefixFor(mc) {
  // NeoForge version = mc minor + patch, e.g. 1.21.1 → 21.1.x
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return '';
  return `${m[1]}.${m[2] || 0}.`;
}

function semverDesc(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---------------------------------------------------------------- launch
async function launch(id, settings, account, onLog = () => {}, options = {}) {
  const processKey = options.serverId ? 'server:' + options.serverId : id;
  if (gameProcesses.has(processKey)) throw new Error('Эта версия уже запущена');
  const dirs = gameDirs(settings);
  const vjson = await resolveVersionJson(id, settings);

  const missingPatched = missingPatchedClient(vjson, dirs);
  if (missingPatched) {
    const e = new Error(`Установка ${id} не завершена: нет файла ${path.basename(missingPatched)}. ` +
      'Удалите версию и установите её заново (раньше установщик загрузчика не смог скачать файлы).');
    e.code = 'install-incomplete';
    throw e;
  }

  const { detectJava, requiredJavaForMc } = require('./java');
  const needJava = (vjson.javaVersion && vjson.javaVersion.majorVersion) || requiredJavaForMc(id);
  const java = await detectJava(needJava, settings.javaPath);
  if (!java.found) {
    const e = new Error(`Нужна Java ${needJava}. Установите её в настройках лаунчера.`);
    e.code = 'java-missing'; e.major = needJava;
    throw e;
  }

  const features = {
    is_demo_user: false,
    has_custom_resolution: !!(settings.windowWidth && settings.windowHeight),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: !!options.directConnect,
    is_quick_play_realms: false,
  };

  // classpath
  const features2 = features;
  const { libs } = libraryEntries(vjson, features2);
  const cp = [...new Set(libs.map((l) => path.join(dirs.libraries, l.rel)))];
  const clientJar = dirs.versionJar(id);
  const mainClass = vjson.mainClass || 'net.minecraft.client.main.Main';
  if (fs.existsSync(clientJar)) cp.push(clientJar);

  const authPlayerName = account.username;
  const { prepareInstance, splitJvmArgs } = require('./game-instance');
  const instanceDir = options.serverId ? options.instanceDir : prepareInstance(dirs.root, id, { packName: options.packName });
  const vars = {
    auth_player_name: authPlayerName,
    version_name: id,
    game_directory: instanceDir,
    quickPlayMultiplayer: options.directConnect || '',
    assets_root: dirs.assets,
    assets_index_name: (vjson.assetIndex && vjson.assetIndex.id) || 'legacy',
    auth_uuid: (account.uuid || '').replace(/-/g, ''),
    auth_access_token: account.mcAccessToken || '0',
    clientid: '0',
    auth_xuid: '0',
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    version_type: vjson.type || 'release',
    resolution_width: String(settings.windowWidth || 854),
    resolution_height: String(settings.windowHeight || 480),
    classpath: cp.join(path.delimiter),
    natives_directory: dirs.natives(id),
    launcher_name: 'mosslauncher',
    launcher_version: '1.0.0',
    library_directory: dirs.libraries,
    classpath_separator: path.delimiter,
    features,
  };

  let gameArgs, jvmArgs;
  if (vjson.arguments) {
    gameArgs = buildArgs(vjson.arguments.game || [], vars);
    jvmArgs = buildArgs(vjson.arguments.jvm || [], vars);
  } else if (vjson.minecraftArguments) {
    gameArgs = buildLegacyArgs(vjson.minecraftArguments, vars);
    jvmArgs = [
      '-Djava.library.path=' + vars.natives_directory,
      '-Dminecraft.launcher.brand=' + vars.launcher_name,
      '-Dminecraft.launcher.version=' + vars.launcher_version,
      '-cp', vars.classpath,
    ];
  } else {
    throw new Error('В версии нет аргументов запуска');
  }
  if (options.directConnect && !gameArgs.includes('--quickPlayMultiplayer')) {
    gameArgs.push('--quickPlayMultiplayer', options.directConnect);
  }

  const { resolveJvmFlags } = require('./jvm-presets');
  const resolvedJvm = resolveJvmFlags(settings, java.found.major || needJava);
  const ram = resolvedJvm.ram;
  const finalJvm = [
    ...resolvedJvm.flags,
    ...jvmArgs,
    ...splitJvmArgs(settings.jvmArgs),
    mainClass,
    ...gameArgs,
  ];
  if (settings.fullscreen) finalJvm.push('--fullscreen');

  onLog(`[moss] java: ${java.found.path} (major ${java.found.major || needJava})`);
  onLog(`[moss] main: ${mainClass}, libs: ${cp.length}, ram: ${ram}M, preset: ${resolvedJvm.effectivePreset}`);

  options.signal?.throwIfAborted();
  const proc = spawn(java.found.path, finalJvm, {
    cwd: instanceDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  gameProcesses.set(processKey, proc);
  proc.stdout.on('data', (d) => onLog(d.toString()));
  proc.stderr.on('data', (d) => onLog(d.toString()));
  return new Promise((resolve, reject) => {
    proc.on('error', (e) => { gameProcesses.delete(processKey); reject(e); });
    proc.on('close', (code) => {
      gameProcesses.delete(processKey);
      resolve({ code });
    });
    proc.on('spawn', () => {
      onLog(`[moss] process started (pid ${proc.pid})`);
    });
  });
}

function stop(id) {
  const p = gameProcesses.get(id);
  if (p) { try { p.kill('SIGKILL'); } catch {} gameProcesses.delete(id); return true; }
  return false;
}

function runningVersions() {
  return [...gameProcesses.keys()];
}

async function removeVersion(id, settings) {
  const dir = gameDirs(settings).versionDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  listVersions, listInstalled, installVersion, launch, stop,
  runningVersions, removeVersion, gameDirs,
  installFabric, installQuilt, installForge, installNeoForge,
  artifactPath, libraryEntries, missingPatchedClient,
};
