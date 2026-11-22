'use strict';

/**
 * preload.js — the only bridge between renderer and main.
 * Exposes a namespaced, promise-based API on window.moss.
 * Renderer never touches Node or ipcRenderer directly.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { IPC, EVENTS } = require('../shared/constants');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function on(event, handler) {
  const wrapped = (_e, data) => handler(data);
  ipcRenderer.on(event, wrapped);
  return () => ipcRenderer.removeListener(event, wrapped);
}

const moss = {
  settings: {
    get: () => invoke(IPC.GET_SETTINGS),
    set: (patch) => invoke(IPC.SET_SETTINGS, patch),
    reset: () => invoke(IPC.RESET_SETTINGS),
  },
  accounts: {
    list: () => invoke(IPC.LIST_ACCOUNTS),
    addOffline: (username) => invoke(IPC.ADD_OFFLINE_ACCOUNT, username),
    remove: (uuid) => invoke(IPC.REMOVE_ACCOUNT, uuid),
    select: (uuid) => invoke(IPC.SELECT_ACCOUNT, uuid),
    loginMicrosoft: () => invoke(IPC.START_MS_LOGIN),
    cancelLogin: () => invoke(IPC.CANCEL_MS_LOGIN),
    refresh: () => invoke(IPC.REFRESH_ACCOUNT),
    avatar: uuid => invoke(IPC.ACCOUNT_AVATAR, uuid),
    pickSkin: uuid => invoke(IPC.PICK_SKIN, uuid),
    uploadSkin: opts => invoke(IPC.UPLOAD_SKIN, opts),
    refreshSkin: uuid => invoke(IPC.REFRESH_SKIN, uuid),
  },
  versions: {
    loaders: (loader, mcVersion) => invoke(IPC.LIST_LOADERS, { loader, mcVersion }),
    list: (opts) => invoke(IPC.LIST_VERSIONS, opts),
    installed: () => invoke(IPC.LIST_INSTALLED),
    install: (opts) => invoke(IPC.INSTALL_VERSION, opts),
    remove: (id) => invoke(IPC.REMOVE_VERSION, id),
  },
  game: {
    launch: (opts) => invoke(IPC.LAUNCH_GAME, opts),
    stop: (id) => invoke(IPC.STOP_GAME, id),
    status: () => invoke(IPC.GAME_STATUS),
  },
  java: {
    detect: () => invoke(IPC.DETECT_JAVA),
    install: (major) => invoke(IPC.INSTALL_JAVA, major),
  },
  mods: {
    search: (params) => invoke(IPC.SEARCH_MODS, params),
    install: (opts) => invoke(IPC.INSTALL_MOD, opts),
    installFile: (opts) => invoke(IPC.INSTALL_MOD_FILE, opts),
    getVersions: (source, projectId, opts) => invoke(IPC.GET_MOD_VERSIONS, { source, projectId, ...opts }),
    checkUpdates: (versionId) => invoke(IPC.CHECK_MOD_UPDATES, versionId),
    list: (versionId) => invoke(IPC.LIST_MODS, versionId),
    remove: (opts) => invoke(IPC.REMOVE_MOD, opts),
    toggle: (opts) => invoke(IPC.TOGGLE_MOD, opts),
    resolveCf: (input) => invoke(IPC.RESOLVE_CF_MOD, input),
  },
  packs: {
    sync: (opts) => invoke(IPC.SYNC_PACK, opts),
    status: (name) => invoke(IPC.PACK_STATUS, name),
    list: () => invoke(IPC.LIST_PACKS),
    mods: (name) => invoke(IPC.LIST_PACK_MODS, name),
    remove: (name) => invoke(IPC.REMOVE_PACK, name),
    versions: (source, slug, opts) => invoke(IPC.LIST_PACK_VERSIONS, { source, slug, ...opts }),
    play: (name) => invoke(IPC.PLAY_PACK, name),
    publish: (opts) => invoke(IPC.PUBLISH_PACK, opts),
  },
  servers: {
    list: () => invoke(IPC.LIST_SERVERS),
    status: id => invoke(IPC.SERVER_STATUS, id),
    play: id => invoke(IPC.PLAY_SERVER, id),
    cancel: id => invoke(IPC.CANCEL_SERVER, id),
    folder: id => invoke(IPC.SERVER_FOLDER, id),
    mods: id => invoke(IPC.SERVER_MODS, id),
    changelog: id => invoke(IPC.SERVER_CHANGELOG, id),
  },
  // старый алиас — теперь тоже указывает на packs
  github: {
    sync: (opts) => invoke(IPC.SYNC_PACK, opts),
    status: (name) => invoke(IPC.PACK_STATUS, name),
    list: () => invoke(IPC.LIST_PACKS),
    remove: (name) => invoke(IPC.REMOVE_PACK, name),
  },
  errors: {
    list: () => invoke(IPC.LIST_ERRORS),
    clear: () => invoke(IPC.CLEAR_ERRORS),
  },
  logs: {
    analyze: (opts) => invoke(IPC.ANALYZE_LOGS, opts),
    upload: (text) => invoke(IPC.UPLOAD_LOG, text),
  },
  updater: {
    check: () => invoke(IPC.CHECK_LAUNCHER_UPDATE),
    install: (info) => invoke(IPC.INSTALL_LAUNCHER_UPDATE, info),
  },
  profiles: {
    list: () => invoke(IPC.LIST_PROFILES),
    syncOptions: (opts) => invoke(IPC.SYNC_OPTIONS, opts),
  },
  screenshots: {
    list: (profileId) => invoke(IPC.LIST_SCREENSHOTS, profileId),
    copy: (relPath) => invoke(IPC.COPY_SCREENSHOT, relPath),
    remove: (relPath) => invoke(IPC.DELETE_SCREENSHOT, relPath),
  },
  system: {
    openFolder: (p) => invoke(IPC.OPEN_FOLDER, p),
    browseFolder: (kind) => invoke(IPC.BROWSE_FOLDER, kind),
    state: () => invoke(IPC.GET_STATE),
    info: () => invoke(IPC.GET_SYSTEM_INFO),
    windowAction: (action) => invoke(IPC.WINDOW_ACTION, action),
    openExternal: (url) => invoke(IPC.OPEN_EXTERNAL, url),
  },
  events: {
    onDownloadProgress: (h) => on(EVENTS.DOWNLOAD_PROGRESS, h),
    onGameLog: (h) => on(EVENTS.GAME_LOG, h),
    onGameState: (h) => on(EVENTS.GAME_STATE, h),
    onMsLoginCode: (h) => on(EVENTS.MS_LOGIN_CODE, h),
    onMsLoginState: (h) => on(EVENTS.MS_LOGIN_STATE, h),
    onToast: (h) => on(EVENTS.TOAST, h),
    onSyncProgress: (h) => on(EVENTS.SYNC_PROGRESS, h),
    onServerState: h => on(EVENTS.SERVER_STATE, h),
    onCrashReport: h => on(EVENTS.CRASH_REPORT, h),
    onUpdateProgress: h => on(EVENTS.UPDATE_PROGRESS, h),
  },
};

contextBridge.exposeInMainWorld('moss', moss);
