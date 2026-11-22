'use strict';

const path = require('path');
const os = require('os');
const { app } = require('electron');

/**
 * Shared constants: paths, API endpoints, defaults.
 * Everything launcher-related lives here so modules never hardcode strings.
 */

const USER_DATA = app ? app.getPath('userData') : path.join(os.homedir(), '.mosslauncher');

const PATHS = {
  userData: USER_DATA,
  config: path.join(USER_DATA, 'config.json'),
  accounts: path.join(USER_DATA, 'accounts.json'),
  logsDir: path.join(USER_DATA, 'logs'),
  cacheDir: path.join(USER_DATA, 'cache'),
  defaultGameDir: path.join(USER_DATA, 'minecraft'),
  runtimesDir: path.join(USER_DATA, 'runtimes'),
};

const API = {
  versionManifest:
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  pistonMeta: 'https://piston-meta.mojang.com',
  pistonData: 'https://piston-data.mojang.com',
  resources: 'https://resources.download.minecraft.net',
  libraries: 'https://libraries.minecraft.net',
  modrinth: 'https://api.modrinth.com/v2',
  curseforge: 'https://api.curseforge.com/v1',
  cfwidget: 'https://api.cfwidget.com',
  githubApi: 'https://api.github.com',
  githubRaw: 'https://raw.githubusercontent.com',
  githubCodeload: 'https://codeload.github.com',
  adoptium: 'https://api.adoptium.net/v3',
  mojangAuth: 'https://api.mojang.com',
  xboxAuth: 'https://user.auth.xboxlive.com/user/authenticate',
  xstsAuth: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcServices: 'https://api.minecraftservices.com',
  sessionServer: 'https://sessionserver.mojang.com',
  msDeviceCode: 'https://login.live.com/oauth20_connect.srf',
  msToken: 'https://login.live.com/oauth20_token.srf',
  fabricMeta: 'https://meta.fabricmc.net/v2',
  quiltMeta: 'https://meta.quiltmc.org/v3',
};

// Mojang's launcher OAuth app — used by official Minecraft launcher & most
// third-party launchers for device code flow (public client, no secret).
const MS_CLIENT_ID = '00000000402b5328';
const MS_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';

const DEFAULTS = {
  minRamMb: 1024,
  maxRamMb: 4096,
  javaPath: '', // empty = auto-detect / managed runtime
  gameDir: PATHS.defaultGameDir,
  windowWidth: 854,
  windowHeight: 480,
  fullscreen: false,
  keepLauncherOpen: true,
  showConsole: false,
  curseforgeApiKey: '',
  githubToken: '',
  language: 'ru',
  theme: 'dark',
  closeOnLaunch: false,
  lastVersionId: '',
  gameArgs: '',
  jvmArgs: '',
  jvmPreset: 'auto',
  updateRepo: 'Ujif416/MossLauncher',
  autoCheckUpdates: true,
};

const GAME = {
  assetIndexCacheTTL: 24 * 60 * 60 * 1000, // 24h
  downloadConcurrency: 8,
  downloadRetries: 3,
  downloadTimeoutMs: 30000,
};

const IPC = {
  // settings
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  RESET_SETTINGS: 'settings:reset',
  // accounts
  LIST_ACCOUNTS: 'accounts:list',
  ADD_OFFLINE_ACCOUNT: 'accounts:add-offline',
  REMOVE_ACCOUNT: 'accounts:remove',
  SELECT_ACCOUNT: 'accounts:select',
  START_MS_LOGIN: 'accounts:ms-login-start',
  CANCEL_MS_LOGIN: 'accounts:ms-login-cancel',
  REFRESH_ACCOUNT: 'accounts:refresh',
  ACCOUNT_AVATAR: 'accounts:avatar',
  PICK_SKIN: 'accounts:pick-skin',
  UPLOAD_SKIN: 'accounts:upload-skin',
  REFRESH_SKIN: 'accounts:refresh-skin',
  // versions
  LIST_VERSIONS: 'versions:list',
  LIST_LOADERS: 'versions:loaders',
  LIST_INSTALLED: 'versions:installed',
  INSTALL_VERSION: 'versions:install',
  REMOVE_VERSION: 'versions:remove',
  // game
  LAUNCH_GAME: 'game:launch',
  STOP_GAME: 'game:stop',
  GAME_STATUS: 'game:status',
  // java
  DETECT_JAVA: 'java:detect',
  INSTALL_JAVA: 'java:install',
  // mods
  SEARCH_MODS: 'mods:search',
  GET_MOD_VERSIONS: 'mods:get-versions',
  INSTALL_MOD: 'mods:install',
  INSTALL_MOD_FILE: 'mods:install-file',
  CHECK_MOD_UPDATES: 'mods:check-updates',
  LIST_MODS: 'mods:list',
  REMOVE_MOD: 'mods:remove',
  TOGGLE_MOD: 'mods:toggle',
  RESOLVE_CF_MOD: 'mods:resolve-cf',
  // modpack sync (github/curseforge/modrinth)
  SYNC_PACK: 'pack:sync',
  PACK_STATUS: 'pack:status',
  LIST_PACKS: 'pack:list',
  LIST_PACK_MODS: 'pack:mods',
  REMOVE_PACK: 'pack:remove',
  LIST_PACK_VERSIONS: 'pack:versions',
  PLAY_PACK: 'pack:play',
  PUBLISH_PACK: 'pack:publish',
  LIST_SERVERS: 'servers:list',
  SERVER_STATUS: 'servers:status',
  PLAY_SERVER: 'servers:play',
  CANCEL_SERVER: 'servers:cancel',
  SERVER_FOLDER: 'servers:folder',
  SERVER_MODS: 'servers:mods',
  SERVER_CHANGELOG: 'servers:changelog',
  // legacy aliases (совместимость)
  SYNC_GITHUB: 'github:sync',
  SYNC_STATUS: 'github:status',
  REMOVE_GITHUB_PACK: 'github:remove',
  // diagnostics & logs
  ANALYZE_LOGS: 'logs:analyze',
  UPLOAD_LOG: 'logs:upload',
  // updater
  CHECK_LAUNCHER_UPDATE: 'updater:check',
  INSTALL_LAUNCHER_UPDATE: 'updater:install',
  // profiles (options.txt sync & screenshots)
  LIST_PROFILES: 'profiles:list',
  SYNC_OPTIONS: 'profiles:sync-options',
  LIST_SCREENSHOTS: 'screenshots:list',
  COPY_SCREENSHOT: 'screenshots:copy',
  DELETE_SCREENSHOT: 'screenshots:delete',
  // system
  OPEN_FOLDER: 'system:open-folder',
  BROWSE_FOLDER: 'system:browse-folder',
  GET_STATE: 'system:state',
  GET_SYSTEM_INFO: 'system:info',
  WINDOW_ACTION: 'system:window-action',
  OPEN_EXTERNAL: 'system:open-external',
  LIST_ERRORS: 'errors:list',
  CLEAR_ERRORS: 'errors:clear',
};

// IPC events pushed from main -> renderer
const EVENTS = {
  DOWNLOAD_PROGRESS: 'event:download-progress',
  GAME_LOG: 'event:game-log',
  GAME_STATE: 'event:game-state',
  MS_LOGIN_CODE: 'event:ms-login-code',
  MS_LOGIN_STATE: 'event:ms-login-state',
  TOAST: 'event:toast',
  SYNC_PROGRESS: 'event:sync-progress',
  SERVER_STATE: 'event:server-state',
  CRASH_REPORT: 'event:crash-report',
  UPDATE_PROGRESS: 'event:update-progress',
};

module.exports = { PATHS, API, DEFAULTS, GAME, IPC, EVENTS, MS_CLIENT_ID, MS_SCOPE };
