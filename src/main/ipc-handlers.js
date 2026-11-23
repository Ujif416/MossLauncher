'use strict';

/**
 * ipc-handlers.js — one place where every renderer request lands.
 * Handlers stay thin: validate → call domain module → return result.
 * Long operations push progress via EVENTS.* instead of returning streams.
 */

const { ipcMain, shell, dialog, BrowserWindow, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { IPC, EVENTS, PATHS } = require('../shared/constants');
const { ensureDir } = require('./storage');
const settingsMod = require('./settings');
const auth = require('./auth');
const mc = require('./minecraft');
const javaMod = require('./java');
const mods = require('./mods');
const gh = require('./github-sync');
const packSync = require('./modpack-sync');
const errors = require('./errors');
const jvmPresets = require('./jvm-presets');
const crashAnalyzer = require('./crash-analyzer');
const updater = require('./updater');
const profileTools = require('./profile-tools');
const horizon = require('./horizon');

let lastWindow = null;
let recentGameLines = [];
let lastInstanceDir = null;

function pushGameLine(line) {
  recentGameLines.push(String(line || '').replace(/\s+$/, ''));
  if (recentGameLines.length > 2000) recentGameLines = recentGameLines.slice(-2000);
}

function restoreMainWindow() {
  if (!lastWindow || lastWindow.isDestroyed()) return;
  if (!lastWindow.isVisible()) lastWindow.show();
  if (lastWindow.isMinimized()) lastWindow.restore();
  lastWindow.focus();
}

function send(event, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) if (!w.isDestroyed()) w.webContents.send(event, payload);
}

function toast(type, message) { send(EVENTS.TOAST, { type, message }); }

/**
 * Общий запуск игры для кнопки «Играть» на главной и для сборок.
 * packName привязывает сборку к инстансу версии (см. game-instance.js).
 */
async function launchVersion(opts = {}) {
  const s = settingsMod.getSettings();
  const versionId = opts.versionId;
  const account = await auth.getSelectedAccount({ fresh: true });
  if (!account) throw new Error('Сначала выберите аккаунт');
  if (!versionId) throw new Error('Не выбрана версия');

  send(EVENTS.GAME_STATE, { state: 'starting', versionId, packName: opts.packName || null });
  if (s.lastVersionId !== versionId) settingsMod.setSettings({ lastVersionId: versionId });
  recentGameLines = [];
  lastInstanceDir = path.join(s.gameDir || PATHS.defaultGameDir, 'instances', versionId);
  // fire and forget — resolve immediately so UI isn't blocked until exit
  mc.launch(versionId, s, account, (line) => {
    pushGameLine(line);
    send(EVENTS.GAME_LOG, { versionId, line });
    if (line.startsWith('[moss] process started')) {
      if (s.keepLauncherOpen === false) lastWindow?.hide();
      else if (s.closeOnLaunch) lastWindow?.minimize();
    }
  }, { packName: opts.packName })
    .then(({ code }) => {
      restoreMainWindow();
      send(EVENTS.GAME_STATE, { state: 'exited', versionId, code });
      if (code !== 0) {
        const report = crashAnalyzer.analyzeLogs(recentGameLines, { exitCode: code, instanceDir: lastInstanceDir });
        send(EVENTS.CRASH_REPORT, { ...report, versionId });
      }
      toast(code === 0 ? 'info' : 'error', `Игра завершилась (код ${code})`);
    })
    .catch((e) => {
      restoreMainWindow();
      send(EVENTS.GAME_STATE, { state: 'error', versionId, error: e.message, code: e.code });
      toast('error', e.message);
    });
  return { launched: true, versionId, packName: opts.packName || null };
}

/**
 * Оборачивает handle-функцию: ловит любое исключение, пишет его в журнал
 * ошибок сессии и пробрасывает дальше — renderer получит .message как раньше.
 */
function wrap(channel, fn, scope) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      errors.push({ scope: scope || channel, message: err.message, detail: err.stack });
      throw err;
    }
  });
}

function register(window) {
  const settings = settingsMod.getSettings();
  ensureDir(settings.gameDir || PATHS.defaultGameDir);
  lastWindow = window;

  // Server preparation uses its own state stream and isolated game directories.
  const servers = require('./servers');
  servers.configure((type, data) => {
    if (type === 'log') {
      pushGameLine(data.line);
      send(EVENTS.GAME_LOG, data);
    }
    if (type === 'error') errors.push({ scope: 'server:' + data.id, message: data.message, detail: data.detail });
    if (type === 'exit') {
      lastInstanceDir = data.instanceDir || lastInstanceDir;
      const report = crashAnalyzer.analyzeLogs(recentGameLines, { exitCode: data.code, instanceDir: data.instanceDir });
      send(EVENTS.CRASH_REPORT, { ...report, serverId: data.id, versionId: data.versionId });
    }
    if (type === 'state') {
      send(EVENTS.SERVER_STATE, data);
      if (data.state === 'starting') {
        recentGameLines = [];
        try { lastInstanceDir = servers.folder(data.id); } catch {}
      }
      if (data.state === 'running') {
        const s = settingsMod.getSettings();
        if (s.keepLauncherOpen === false) lastWindow?.hide();
        else if (s.closeOnLaunch) lastWindow?.minimize();
      } else if (data.state === 'idle' || data.state === 'error') {
        restoreMainWindow();
      }
    }
  });
  wrap(IPC.LIST_SERVERS, () => servers.list(), 'servers');
  wrap(IPC.SERVER_STATUS, (_e, id) => servers.status(id), 'servers');
  wrap(IPC.PLAY_SERVER, (_e, id) => servers.play(id), 'servers');
  wrap(IPC.CANCEL_SERVER, (_e, id) => servers.cancel(id), 'servers');
  wrap(IPC.SERVER_MODS, (_e, id) => servers.mods(id), 'servers');
  wrap(IPC.SERVER_CHANGELOG, (_e, id) => servers.changelog(id), 'servers');
  wrap(IPC.SERVER_FOLDER, async (_e, id) => { await shell.openPath(servers.folder(id)); return true; }, 'servers');

  // ---------- settings ----------
  ipcMain.handle(IPC.GET_SETTINGS, () => settingsMod.getSettings());
  ipcMain.handle(IPC.SET_SETTINGS, (_e, patch) => {
    const next = settingsMod.setSettings(patch || {});
    ensureDir(next.gameDir || PATHS.defaultGameDir);
    return next;
  });
  ipcMain.handle(IPC.RESET_SETTINGS, () => settingsMod.resetSettings());

  // ---------- accounts ----------
  let skinDraft = null;
  let skinUploading = false;
  ipcMain.handle(IPC.ACCOUNT_AVATAR, (_e, uuid) => auth.accountAvatar(uuid).catch(() => null));
  ipcMain.handle(IPC.REFRESH_SKIN, (_e, uuid) => auth.refreshSkin(uuid));
  ipcMain.handle(IPC.PICK_SKIN, async (_e, uuid) => {
    auth.getAccount(uuid);
    const picked = await dialog.showOpenDialog(window, { title: 'Выберите PNG-скин', properties: ['openFile'], filters: [{ name: 'Minecraft skin', extensions: ['png'] }] });
    if (picked.canceled || !picked.filePaths.length) return null;
    const file = picked.filePaths[0];
    if ((await fs.promises.stat(file)).size > 1024 * 1024) throw new Error('Скин должен быть меньше 1 МБ.');
    const data = await fs.promises.readFile(file);
    const skins = require('./skins');
    skins.validateSkin(data);
    skinDraft = { uuid, data, id: require('crypto').randomUUID(), expires: Date.now() + 15 * 60 * 1000 };
    return { id: skinDraft.id, name: path.basename(file), preview: skins.headImage(data), texture: 'data:image/png;base64,' + data.toString('base64') };
  });
  ipcMain.handle(IPC.UPLOAD_SKIN, async (_e, { uuid, id, variant, apiKey } = {}) => {
    if (skinUploading) throw new Error('Дождитесь завершения загрузки скина.');
    const draft = skinDraft;
    if (!draft || draft.uuid !== uuid || draft.id !== id || draft.expires < Date.now()) throw new Error('Выберите PNG-файл заново.');
    skinUploading = true;
    try {
      const result = await auth.changeSkin(uuid, draft.data, variant, apiKey);
      if (skinDraft === draft) skinDraft = null;
      return result;
    } finally { skinUploading = false; }
  });
  ipcMain.handle(IPC.LIST_ACCOUNTS, async () => {
    const selected = await auth.getSelectedAccount();
    return { accounts: auth.listAccounts(), selected: selected ? selected.uuid : null };
  });

  ipcMain.handle(IPC.ADD_OFFLINE_ACCOUNT, async (_e, username) => {
    const acc = auth.addOffline(username);
    return { account: { ...acc, mcAccessToken: undefined } };
  });

  ipcMain.handle(IPC.REMOVE_ACCOUNT, (_e, uuid) => {
    auth.removeAccount(uuid);
    return auth.listAccounts();
  });

  ipcMain.handle(IPC.SELECT_ACCOUNT, (_e, uuid) => {
    auth.selectAccount(uuid);
    return true;
  });

  ipcMain.handle(IPC.REFRESH_ACCOUNT, async () => {
    const acc = await auth.getSelectedAccount({ fresh: true });
    return acc ? { ...acc, mcAccessToken: undefined, refreshToken: undefined } : null;
  });

  ipcMain.handle(IPC.START_MS_LOGIN, async () => {
    const { code, complete } = await auth.beginMicrosoftLogin();
    send(EVENTS.MS_LOGIN_CODE, code);
    complete
      .then((acc) => {
        send(EVENTS.MS_LOGIN_STATE, { ok: true, account: { ...acc, mcAccessToken: undefined, refreshToken: undefined } });
        toast('online', `Вход выполнен: ${acc.username}`);
      })
      .catch((e) => {
        send(EVENTS.MS_LOGIN_STATE, { ok: false, error: e.message });
      });
    return { started: true, code };
  });

  ipcMain.handle(IPC.CANCEL_MS_LOGIN, () => { auth.cancelDeviceLogin(); return true; });

  // ---------- versions ----------
  wrap(IPC.LIST_VERSIONS, async (_e, opts) => mc.listVersions(opts || {}), 'versions');
  wrap(IPC.LIST_LOADERS, (_e, { loader, mcVersion }) => require('./loaders').listLoaderVersions(loader, mcVersion), 'loaders');
  wrap(IPC.LIST_INSTALLED, () => mc.listInstalled(settingsMod.getSettings()), 'versions');

  ipcMain.handle(IPC.INSTALL_VERSION, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    const emit = (p) => send(EVENTS.DOWNLOAD_PROGRESS, { scope: 'version', versionId: opts.id, loader: opts.loader || 'vanilla', ...p });
    const onProgress = p => { if (p.stage !== 'done') emit(p); };
    const loader = opts.loader || 'vanilla';
    let finalId = opts.id;
    onProgress({ stage: 'manifest', done: 0, total: 0 });
    try {
    if (loader === 'fabric') finalId = await mc.installFabric(opts.id, s, onProgress, opts.loaderVersion);
    else if (loader === 'quilt') finalId = await mc.installQuilt(opts.id, s, onProgress, opts.loaderVersion);
    else if (loader === 'forge') finalId = await mc.installForge(opts.id, s, onProgress, opts.loaderVersion);
    else if (loader === 'neoforge') finalId = await mc.installNeoForge(opts.id, s, onProgress, opts.loaderVersion);
    else await mc.installVersion(opts.id, s, onProgress);
    toast('success', `Установлено: ${finalId}`);
    return { id: finalId };
    } finally {
      emit({ stage: 'done', done: 1, total: 1 });
    }
  });

  ipcMain.handle(IPC.REMOVE_VERSION, async (_e, id) => {
    await mc.removeVersion(id, settingsMod.getSettings());
    return true;
  });

  // ---------- java ----------
  ipcMain.handle(IPC.DETECT_JAVA, async () => {
    const s = settingsMod.getSettings();
    return javaMod.detectJava(null, s.javaPath);
  });

  ipcMain.handle(IPC.INSTALL_JAVA, async (_e, major) => {
    send(EVENTS.DOWNLOAD_PROGRESS, { scope: 'java', stage: 'download', done: 0, total: 1, major });
    const res = await javaMod.installJava(major, (p) => {
      send(EVENTS.DOWNLOAD_PROGRESS, { scope: 'java', major, ...p });
    });
    toast('success', `Java ${major} установлена`);
    return res;
  });

  // ---------- launch ----------
  ipcMain.handle(IPC.GAME_STATUS, () => ({ running: mc.runningVersions() }));

  ipcMain.handle(IPC.LAUNCH_GAME, async (_e, opts = {}) => launchVersion(opts));

  ipcMain.handle(IPC.STOP_GAME, (_e, id) => ({ stopped: mc.stop(id) }));

  // ---------- mods ----------
  wrap(IPC.SEARCH_MODS, async (_e, params = {}) => {
    const s = settingsMod.getSettings();
    return mods.searchAll(params, s);
  }, 'mods');

  wrap(IPC.INSTALL_MOD, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    const res = await mods.install(opts.source, opts.projectId, {
      loader: opts.loader, mcVersion: opts.mcVersion, versionId: opts.versionId, settings: s,
    });
    toast('success', 'Мод установлен: ' + path.basename(res.file));
    return res;
  }, 'mods');

  wrap(IPC.GET_MOD_VERSIONS, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    return mods.getVersions(opts.source, opts.projectId, { loader: opts.loader, version: opts.version, settings: s });
  }, 'mods');

  wrap(IPC.INSTALL_MOD_FILE, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    const res = await mods.installFile(opts.source, opts.projectId, opts.file, {
      loader: opts.loader, mcVersion: opts.mcVersion, versionId: opts.versionId, settings: s,
    });
    toast('success', 'Мод установлен: ' + path.basename(res.file));
    return res;
  }, 'mods');

  wrap(IPC.CHECK_MOD_UPDATES, async (_e, versionId) => {
    const s = settingsMod.getSettings();
    return mods.checkUpdates(s, versionId);
  }, 'mods');

  wrap(IPC.RESOLVE_CF_MOD, async (_e, input) => mods.cfResolve(input), 'mods');

  ipcMain.handle(IPC.LIST_MODS, (_e, versionId) => mods.listMods(settingsMod.getSettings(), versionId));

  ipcMain.handle(IPC.TOGGLE_MOD, (_e, { versionId, file, enabled }) => {
    mods.toggleMod(settingsMod.getSettings(), versionId, file, enabled);
    return mods.listMods(settingsMod.getSettings(), versionId);
  });

  ipcMain.handle(IPC.REMOVE_MOD, (_e, { versionId, file }) => {
    mods.removeMod(settingsMod.getSettings(), versionId, file);
    return mods.listMods(settingsMod.getSettings(), versionId);
  });

  // ---------- modpack sync (github / curseforge / modrinth) ----------
  wrap(IPC.SYNC_PACK, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    return packSync.syncModpack(opts.input || opts.repo, {
      branch: opts.branch, subdir: opts.subdir,
      targetName: opts.name, settings: s,
      onProgress: (p) => send(EVENTS.SYNC_PROGRESS, p),
    });
  }, 'modpacks');

  ipcMain.handle(IPC.PACK_STATUS, (_e, name) => packSync.packStatus(settingsMod.getSettings(), name));
  ipcMain.handle(IPC.LIST_PACKS, () => packSync.listPacks(settingsMod.getSettings()));
  wrap(IPC.LIST_PACK_MODS, (_e, name) => packSync.listPackMods(settingsMod.getSettings(), name), 'modpacks');
  ipcMain.handle(IPC.REMOVE_PACK, (_e, name) => {
    packSync.removePack(settingsMod.getSettings(), name);
    return packSync.listPacks(settingsMod.getSettings());
  });

  wrap(IPC.LIST_PACK_VERSIONS, async (_e, opts = {}) => {
    if (!opts.source || !opts.slug) throw new Error('Укажите источник и сборку');
    return packSync.listPackVersions(opts.source, opts.slug, { limit: opts.limit || 50 });
  }, 'modpacks');

  /**
   * «Играть» у сборки: находим установленную версию игры с нужным лоадером,
   * привязываем к ней сборку и запускаем. Если версии нет — сообщаем, какую
   * сборка требует, чтобы UI предложил её установить.
   */
  ipcMain.handle(IPC.PLAY_PACK, async (_e, name) => {
    const s = settingsMod.getSettings();
    const pack = packSync.packStatus(s, name);
    if (!pack) throw new Error('Сборка не найдена');
    const versionId = packSync.matchInstalledVersion(s, pack);
    if (!versionId) {
      const need = [pack.gameVersion, pack.loader].filter(Boolean).join(' ');
      throw new Error(need
        ? `Для этой сборки нужна версия ${need}. Установите её на вкладке «Версии».`
        : 'Не найдено подходящей версии игры. Сначала установите её на вкладке «Версии».');
    }
    return launchVersion({ versionId, packName: name });
  });

  /** Публикация клиентской сборки из папки сервера в GitHub. */
  wrap(IPC.PUBLISH_PACK, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    const result = await require('./pack-publish').publish({
      token: opts.token || s.githubToken,
      repo: opts.repo, branch: opts.branch, revision: opts.revision,
      sourceDir: opts.sourceDir, gameDir: s.gameDir,
      onProgress: (p) => send(EVENTS.SYNC_PROGRESS, { scope: 'publish', ...p }),
    });
    toast('success', result.unchanged ? `Ревизия ${result.revision} уже актуальна` : `Опубликована ревизия ${result.revision}`);
    return result;
  }, 'modpacks');

  // legacy совместимость для старого рендерера
  ipcMain.handle(IPC.SYNC_GITHUB, async (_e, opts = {}) => {
    const s = settingsMod.getSettings();
    return packSync.syncModpack(opts.input || opts.repo, {
      branch: opts.branch, subdir: opts.subdir,
      targetName: opts.name, settings: s,
      onProgress: (p) => send(EVENTS.SYNC_PROGRESS, p),
    });
  });
  ipcMain.handle(IPC.SYNC_STATUS, (_e, name) => packSync.packStatus(settingsMod.getSettings(), name));
  ipcMain.handle(IPC.REMOVE_GITHUB_PACK, (_e, name) => {
    packSync.removePack(settingsMod.getSettings(), name);
    return packSync.listPacks(settingsMod.getSettings());
  });

  // ---------- errors ----------
  ipcMain.handle(IPC.LIST_ERRORS, () => errors.list());
  ipcMain.handle(IPC.CLEAR_ERRORS, () => { errors.clear(); return true; });

  // ---------- diagnostics & logs ----------
  wrap(IPC.ANALYZE_LOGS, (_e, opts = {}) => {
    const lines = Array.isArray(opts.lines) && opts.lines.length ? opts.lines : recentGameLines;
    return crashAnalyzer.analyzeLogs(lines, {
      exitCode: opts.exitCode ?? null,
      instanceDir: opts.instanceDir || lastInstanceDir,
    });
  }, 'logs');

  wrap(IPC.UPLOAD_LOG, async (_e, text) => {
    const content = typeof text === 'string' && text.trim() ? text : recentGameLines.join('\n');
    return crashAnalyzer.uploadToMclogs(content);
  }, 'logs');

  // ---------- updater ----------
  wrap(IPC.CHECK_LAUNCHER_UPDATE, () => updater.checkForUpdates(settingsMod.getSettings()), 'updater');
  wrap(IPC.INSTALL_LAUNCHER_UPDATE, (_e, info) => updater.downloadAndInstall(info, (p) => {
    send(EVENTS.UPDATE_PROGRESS, p);
  }), 'updater');

  // ---------- profiles (options.txt sync & screenshots) ----------
  wrap(IPC.LIST_PROFILES, () => ({
    profiles: profileTools.listProfiles(settingsMod.getSettings()),
    categories: Object.values(profileTools.OPTION_CATEGORIES).map((c) => ({ id: c.id, label: c.label })),
  }), 'profiles');

  wrap(IPC.SYNC_OPTIONS, (_e, opts = {}) => profileTools.syncOptions(settingsMod.getSettings(), opts), 'profiles');

  wrap(IPC.LIST_SCREENSHOTS, (_e, profileId) => profileTools.listScreenshots(settingsMod.getSettings(), profileId), 'screenshots');

  wrap(IPC.COPY_SCREENSHOT, (_e, relPath) => {
    const full = profileTools.resolveSafeScreenshot(settingsMod.getSettings(), relPath);
    if (!fs.existsSync(full)) throw new Error('Файл скриншота не найден.');
    const img = nativeImage.createFromPath(full);
    if (img.isEmpty()) throw new Error('Не удалось прочитать изображение.');
    clipboard.writeImage(img);
    return true;
  }, 'screenshots');

  wrap(IPC.DELETE_SCREENSHOT, async (_e, relPath) => {
    const full = profileTools.resolveSafeScreenshot(settingsMod.getSettings(), relPath);
    if (!fs.existsSync(full)) return false;
    await shell.trashItem(full);
    return true;
  }, 'screenshots');

  // ---------- horizon (Rust Minecraft client) ----------
  wrap(IPC.HORIZON_LIST, () => horizon.listReleases(settingsMod.getSettings()), 'horizon');
  wrap(IPC.HORIZON_INSTALL, (_e, tag) => horizon.installVersion(tag, settingsMod.getSettings(), (p) => {
    send(EVENTS.HORIZON_STATE, p);
  }), 'horizon');
  wrap(IPC.HORIZON_PREPARE, (_e, tag) => horizon.prepareAssets(
    tag,
    settingsMod.getSettings(),
    (line) => { pushGameLine(line); send(EVENTS.GAME_LOG, { versionId: 'horizon:' + tag, line }); },
    (p) => send(EVENTS.HORIZON_STATE, p)
  ), 'horizon');
  wrap(IPC.HORIZON_LAUNCH, async (_e, input) => {
    const tag = typeof input === 'string' ? input : input?.tag;
    const server = typeof input === 'object' && input ? input.server : null;
    const s = settingsMod.getSettings();
    const account = await auth.getSelectedAccount({ fresh: true }).catch(() => null);
    recentGameLines = [];
    lastInstanceDir = horizon.horizonDirs(s).game;
    horizon.launch(
      tag,
      s,
      account,
      (line) => { pushGameLine(line); send(EVENTS.GAME_LOG, { versionId: 'horizon:' + (tag || 'nightly'), line }); },
      (st) => {
        send(EVENTS.HORIZON_STATE, st);
        if (st.state === 'running') {
          if (s.keepLauncherOpen === false) lastWindow?.hide();
          else if (s.closeOnLaunch) lastWindow?.minimize();
        } else if (st.state === 'idle' || st.state === 'error') {
          restoreMainWindow();
        }
      },
      { server }
    ).then(({ code, instanceDir }) => {
      if (code !== 0) {
        const report = crashAnalyzer.analyzeLogs(recentGameLines, { exitCode: code, instanceDir });
        send(EVENTS.CRASH_REPORT, { ...report, versionId: 'horizon:' + (tag || 'nightly') });
      }
      toast(code === 0 ? 'info' : 'error', `Horizon завершился (код ${code})`);
    }).catch((e) => {
      restoreMainWindow();
      send(EVENTS.HORIZON_STATE, { state: 'error', tag: tag || 'nightly', message: e.message });
      toast('error', e.message);
    });
    return { launched: true, tag: tag || 'nightly' };
  }, 'horizon');
  wrap(IPC.HORIZON_STOP, (_e, tag) => ({ stopped: horizon.stop(tag) }), 'horizon');
  wrap(IPC.HORIZON_REMOVE, (_e, tag) => horizon.removeVersion(tag, settingsMod.getSettings()), 'horizon');
  wrap(IPC.HORIZON_FOLDER, async () => {
    const dir = horizon.horizonDirs(settingsMod.getSettings()).root;
    ensureDir(dir);
    await shell.openPath(dir);
    return true;
  }, 'horizon');

  // ---------- system ----------
  ipcMain.handle(IPC.GET_SYSTEM_INFO, () => {
    const totalMemMb = Math.floor(os.totalmem() / (1024 * 1024));
    const freeMemMb = Math.floor(os.freemem() / (1024 * 1024));
    return {
      totalMemMb,
      freeMemMb,
      recommendedRam: jvmPresets.recommendRam(totalMemMb),
      jvmPresets: Object.values(jvmPresets.JVM_PRESETS),
      appVersion: updater.currentAppVersion(),
      isPortable: updater.isPortableBuild(),
    };
  });
  ipcMain.handle(IPC.OPEN_FOLDER, async (_e, p) => {
    if (!p) return false;
    if (!fs.existsSync(p)) ensureDir(p);
    await shell.openPath(p);
    return true;
  });

  ipcMain.handle(IPC.BROWSE_FOLDER, async (_event, kind) => {
    const res = await dialog.showOpenDialog(lastWindow, kind === 'java' ? { properties: ['openFile'], filters: [{ name: 'Java', extensions: ['exe'] }] } : { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle(IPC.GET_STATE, async () => ({
    settings: settingsMod.getSettings(),
    accounts: auth.listAccounts(),
    selected: await auth.getSelectedAccount().then((a) => (a ? a.uuid : null)),
    installed: mc.listInstalled(settingsMod.getSettings()),
    running: mc.runningVersions(),
    platform: process.platform,
    version: process.versions.electron,
  }));

  ipcMain.handle(IPC.WINDOW_ACTION, (e, action) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
    return win.isMaximized();
  });

  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_e, url) => {
    if (!/^https?:/.test(String(url))) return false;
    await shell.openExternal(url);
    return true;
  });
}

module.exports = { register, send, toast };
