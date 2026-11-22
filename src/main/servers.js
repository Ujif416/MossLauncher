'use strict';
const fs = require('fs');
const path = require('path');
const catalog = require('./server-catalog');
const synchronizer = require('./server-sync');
const serverChangelog = require('./server-changelog');
const serverStatus = require('./server-status');
const mc = require('./minecraft');
const java = require('./java');
const auth = require('./auth');
const settings = require('./settings');
const { PATHS } = require('../shared/constants');
const tasks = new Map(), states = new Map();
let emit = () => {};
let javaInstall = null;
function configure(callback) { emit = callback; }
function dirs(id, s = settings.getSettings()) { return catalog.paths(s.gameDir || PATHS.defaultGameDir, id); }
function update(id, patch) {
  const next = { id, ...states.get(id), ...patch, updatedAt: Date.now() }; states.set(id, next); emit('state', next); return next;
}
async function list() {
  const result = await catalog.refresh(path.join(PATHS.cacheDir, 'server-catalog.json'));
  return { warning: result.warning, servers: result.catalog.servers.map(s => {
    let installedRevision = null;
    try { installedRevision = synchronizer.readState(dirs(s.id))?.packRevision || null; } catch {}
    return {
      id: s.id, name: s.name, description: s.description, address: s.address, minecraft: s.minecraft, loader: s.loader,
      packRevision: s.packRevision || null,
      installedRevision,
      hasUpdate: !!(installedRevision && s.packRevision && installedRevision !== s.packRevision),
      state: states.get(s.id) || { id: s.id, state: 'idle' },
    };
  }) };
}
async function changelog(id) {
  const server = catalog.get(id);
  const p = dirs(id);
  let installed = null;
  try { installed = synchronizer.readState(p); } catch {}
  const history = serverChangelog.readHistory(p.root);
  const installedRevision = installed?.packRevision || null;
  const remoteRevision = server.packRevision || null;
  let pendingDiff = null;
  if (installed && remoteRevision && installedRevision !== remoteRevision) {
    try {
      const nextFiles = await catalog.index(server, null, path.join(p.root, 'pack-index.json'));
      pendingDiff = serverChangelog.computeDiff(installed.files || [], nextFiles);
    } catch {}
  }
  return {
    id,
    name: server.name,
    installedRevision,
    remoteRevision,
    hasUpdate: !!(installedRevision && remoteRevision && installedRevision !== remoteRevision),
    pendingDiff,
    history,
  };
}
async function status(id) { return serverStatus.status(catalog.get(id)); }
function folder(id) { catalog.get(id); const p = dirs(id); catalog.noLinks(p.game); fs.mkdirSync(p.game, { recursive: true }); return p.game; }
function mods(id) {
  catalog.get(id); const dir = path.join(dirs(id).game, 'mods'); catalog.noLinks(dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && /\.jar(?:\.disabled)?$/i.test(f.name)).map(f => f.name).sort((a, b) => a.localeCompare(b));
}
function runtimeReady(server, s) {
  const id = 'neoforge-' + server.loader.version, d = mc.gameDirs(s);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(d.versionDir(id), '.moss-installed'), 'utf8'));
    const v = JSON.parse(fs.readFileSync(d.versionJson(id), 'utf8'));
    const args = v.arguments?.game || [];
    return !marker.installing && v.id === id && v.inheritsFrom === server.minecraft &&
      args[args.indexOf('--fml.neoForgeVersion') + 1] === server.loader.version && !mc.missingPatchedClient(v, d);
  } catch { return false; }
}
async function run(id, controller) {
  const latest = await catalog.refresh(path.join(PATHS.cacheDir, 'server-catalog.json'));
  controller.signal.throwIfAborted();
  if (latest.warning) throw new Error('Не удалось проверить обновления сборки на GitHub. Нажмите «Повторить». ' + (latest.error || ''));
  const server = catalog.get(id), preferences = settings.getSettings(), p = dirs(id, preferences);
  const s = { ...preferences, gameDir: p.runtime };
  const signal = controller.signal;
  const account = await auth.getSelectedAccount({ fresh: true });
  if (!account) { const e = new Error('Сначала выберите аккаунт на вкладке «Аккаунты»'); e.code = 'account-missing'; throw e; }
  signal.throwIfAborted(); catalog.noLinks(p.root); catalog.noLinks(p.runtime);
  update(id, { state: 'preparing', stage: 'manifest', message: 'Получение списка файлов', done: 0, total: 0, unit: null });
  const files = await catalog.index(server, signal, path.join(p.root, 'pack-index.json'));
  let lastEmit = 0;
  const progress = part => value => {
    if (signal.aborted || value.stage === 'done') return;
    const now = Date.now();
    if (now - lastEmit < 120 && value.done !== value.total && states.get(id)?.stage === value.stage) return;
    lastEmit = now; update(id, { ...value, part, state: 'preparing' });
  };
  update(id, { stage: 'java', part: 'runtime', message: 'Проверка Java 21', done: 0, total: 0 });
  const found = await java.detectJava(server.java, s.javaPath);
  if (!found.found) {
    if (!javaInstall) javaInstall = java.installJava(server.java, progress('java')).finally(() => { javaInstall = null; });
    await javaInstall; s.javaPath = '';
  }
  signal.throwIfAborted();
  update(id, { stage: 'runtime', part: 'runtime', message: 'Подготовка Minecraft и NeoForge', done: 0, total: 0 });
  const versionId = 'neoforge-' + server.loader.version;
  if (!runtimeReady(server, s)) {
    const installedId = await mc.installNeoForge(server.minecraft, s, progress('runtime'), server.loader.version);
    if (installedId !== versionId) throw new Error('Установщик вернул другую версию NeoForge');
  } else await mc.installVersion(versionId, s, progress('runtime'));
  signal.throwIfAborted();
  if (!runtimeReady(server, s)) throw new Error('Установка требуемой версии NeoForge не завершена');
  await synchronizer.sync(server, files, p, { signal, onProgress: progress('pack') });
  signal.throwIfAborted();
  update(id, { state: 'starting', stage: 'launch', done: 0, total: 0, message: 'Запуск Minecraft и подключение к серверу' });
  const address = server.address.host + (server.address.port === 25565 ? '' : ':' + server.address.port);
  const result = await mc.launch(versionId, s, account, line => {
    emit('log', { serverId: id, versionId, line });
    if (line.startsWith('[moss] process started')) update(id, { state: 'running', message: 'Minecraft запущен', done: 0, total: 0 });
  }, { serverId: id, instanceDir: p.game, directConnect: address, signal });
  update(id, { state: result.code === 0 || signal.aborted ? 'idle' : 'error', message: result.code === 0 || signal.aborted ? 'Игра закрыта' : `Игра завершилась с кодом ${result.code}. Подробности на вкладке «Логи».`, done: 0, total: 0 });
  if (result.code !== 0 && !signal.aborted) emit('exit', { id, versionId, code: result.code, instanceDir: p.game });
}
function play(id) {
  catalog.get(id);
  if (tasks.has(id)) return { started: false, state: states.get(id) };
  const controller = new AbortController(); tasks.set(id, controller);
  update(id, { state: 'preparing', stage: 'account', message: 'Проверка аккаунта', done: 0, total: 0, errorCode: null, cancelling: false });
  run(id, controller).catch(e => {
    tasks.delete(id);
    const description = require('./errors').describe(e);
    update(id, { state: controller.signal.aborted ? 'idle' : 'error', message: controller.signal.aborted ? 'Подготовка отменена' : description.message, errorCode: e.code || null, cancelling: false, done: 0, total: 0 });
    if (!controller.signal.aborted) emit('error', { id, ...description });
  }).finally(() => { if (tasks.get(id) === controller) { tasks.delete(id); update(id, { cancelling: false }); } });
  return { started: true };
}
function cancel(id) {
  catalog.get(id); const c = tasks.get(id); if (!c) return false;
  c.abort(); mc.stop('server:' + id);
  update(id, { cancelling: true, message: 'Отмена. Ожидание завершения текущего шага…' }); return true;
}
module.exports = { configure, list, status, play, cancel, folder, mods, changelog, runtimeReady };
