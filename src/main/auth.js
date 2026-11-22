'use strict';

/**
 * auth.js — Microsoft OAuth (device code flow) → Xbox Live → XSTS →
 * Minecraft services → profile. Plus offline accounts.
 *
 * Token chain:
 *   device_code → MS access/refresh tokens
 *   MS access token → Xbox Live user token → XSTS token
 *   XSTS token → Minecraft access token → MC profile (uuid, name)
 */

const crypto = require('crypto');
const { JsonStore } = require('./storage');
const { PATHS, API, MS_CLIENT_ID, MS_SCOPE } = require('../shared/constants');
const { request, fetchJson } = require('./net');

const store = new JsonStore(PATHS.accounts, { accounts: [], selected: null });

// ---------- helpers ----------
function postForm(url, fields) {
  const body = new URLSearchParams(fields).toString();
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function postJson(url, obj, headers = {}) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(obj),
  });
  const text = res.body.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status; err.body = json || text;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function offlineUuid(name) {
  // Same algorithm vanilla uses for offline players:
  // UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8)) — MD5, v3
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- Microsoft device code flow ----------
let pendingLogin = null; // { cancelled, deviceCode, interval, expiresAt }

async function startDeviceLogin() {
  cancelDeviceLogin();
  const res = await postForm(API.msDeviceCode, {
    client_id: MS_CLIENT_ID,
    scope: MS_SCOPE,
    response_type: 'device_code',
  });
  const data = JSON.parse(res.body.toString('utf8'));
  if (res.status !== 200) throw new Error(data.error_description || 'Device code request failed');
  pendingLogin = {
    deviceCode: data.device_code,
    interval: (data.interval || 5) * 1000,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    cancelled: false,
  };
  return { userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: data.expires_in };
}

function cancelDeviceLogin() {
  if (pendingLogin) pendingLogin.cancelled = true;
}

/**
 * Polls Microsoft for the token until user completes sign-in.
 * Emits stage updates via onStage(stage).
 */
async function waitForMsToken(onStage) {
  if (!pendingLogin) throw new Error('No pending login');
  const session = pendingLogin;
  const { deviceCode, expiresAt } = session;
  let interval = session.interval;
  while (Date.now() < expiresAt) {
    await sleep(interval);
    if (session.cancelled) throw Object.assign(new Error('Login cancelled'), { code: 'cancelled' });
    const res = await postForm(API.msToken, {
      client_id: MS_CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    });
    const data = JSON.parse(res.body.toString('utf8'));
    if (session.cancelled) throw Object.assign(new Error('Login cancelled'), { code: 'cancelled' });
    if (res.status === 200) { if (pendingLogin === session) pendingLogin = null; return data; }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5000; continue; }
    if (data.error === 'expired_token') throw new Error('Code expired — try again');
    if (data.error === 'authorization_declined') throw new Error('Sign-in declined');
    throw new Error(data.error_description || data.error || 'Token error');
  }
  throw new Error('Device code expired');
}

async function refreshMsToken(refreshToken) {
  const res = await postForm(API.msToken, {
    client_id: MS_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MS_SCOPE,
  });
  const data = JSON.parse(res.body.toString('utf8'));
  if (res.status !== 200) { const e = new Error('Refresh failed'); e.body = data; throw e; }
  return data;
}

// ---------- Xbox Live / XSTS / Minecraft ----------
async function xboxAuth(msAccessToken) {
  return postJson(API.xboxAuth, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: 'd=' + msAccessToken,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
}

async function xstsAuth(xblToken) {
  const res = await postJson(API.xstsAuth, {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xblToken],
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  return res;
}

async function minecraftLogin(xstsToken, uhs) {
  return postJson(`${API.mcServices}/authentication/login_with_xbox`, {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
  });
}

async function minecraftProfile(mcAccessToken) {
  try {
    return await fetchJson(`${API.mcServices}/minecraft/profile`, {
      headers: { Authorization: `Bearer ${mcAccessToken}` },
    });
  } catch (e) {
    if (e.status === 404) return null; // owns no Minecraft
    throw e;
  }
}

/** Run the full chain from an MS token pair to a complete account record. */
async function mcChain(msTokens, onStage = () => {}) {
  onStage('xbox');
  const xbl = await xboxAuth(msTokens.access_token);
  onStage('xsts');
  let xsts;
  try {
    xsts = await xstsAuth(xbl.Token);
  } catch (e) {
    const code = e.body && e.body.XErr;
    const msgs = {
      2148916233: 'Нет аккаунта Xbox — создайте его на xbox.com',
      2148916238: 'Аккаунт несовершеннолетний — добавьте его в семью на account.microsoft.com',
    };
    throw new Error(msgs[code] || `XSTS error ${code || e.message}`);
  }
  const uhs = xsts.DisplayClaims.xui[0].uhs;
  onStage('minecraft');
  const mc = await minecraftLogin(xsts.Token, uhs);
  onStage('profile');
  const profile = await minecraftProfile(mc.access_token);
  if (!profile) throw new Error('На этом аккаунте Microsoft нет Minecraft Java Edition');
  return {
    type: 'microsoft',
    uuid: profile.id,
    username: profile.name,
    mcAccessToken: mc.access_token,
    mcExpiresAt: Date.now() + mc.expires_in * 1000,
    refreshToken: msTokens.refresh_token,
    skins: profile.skins || [],
    capes: profile.capes || [],
    avatar: (profile.skins || []).find((s) => s.state === 'ACTIVE')?.url || null,
  };
}

/**
 * Refresh a Microsoft account's Minecraft token if needed.
 * Mutates and saves the account record.
 */
async function ensureFreshToken(acc) {
  if (acc.type !== 'microsoft') return acc;
  if (acc.mcAccessToken && acc.mcExpiresAt && Date.now() < acc.mcExpiresAt - 60000) return acc;
  const ms = await refreshMsToken(acc.refreshToken);
  const fresh = await mcChain(ms);
  Object.assign(acc, fresh);
  saveStore();
  return acc;
}

// ---------- store operations ----------
function saveStore() { store.save(); }

function listAccounts() {
  return store.data.accounts.map((a) => ({ ...a, mcAccessToken: undefined, refreshToken: undefined }));
}

function getAccount(uuid) {
  const acc = store.data.accounts.find(a => a.uuid === uuid);
  if (!acc) throw new Error('Аккаунт не найден.');
  return acc;
}
function microsoftAccount(uuid) {
  const acc = getAccount(uuid);
  if (acc.type !== 'microsoft') throw new Error('Выберите официальный Microsoft-аккаунт.');
  return acc;
}

async function accountAvatar(uuid) {
  const acc = getAccount(uuid);
  if (acc.type === 'offline') return acc.offlineSkin?.head || null;
  const url = acc.skins?.find(s => s.state === 'ACTIVE')?.url || acc.avatar;
  if (!url) return null;
  return require('./skins').avatar(url);
}

async function refreshSkin(uuid) {
  const acc = await ensureFreshToken(microsoftAccount(uuid));
  const profile = await minecraftProfile(acc.mcAccessToken);
  if (!profile) throw new Error('Профиль Minecraft не найден.');
  acc.skins = profile.skins || [];
  acc.avatar = acc.skins.find(s => s.state === 'ACTIVE')?.url || null;
  saveStore();
  return listAccounts();
}

async function changeSkin(uuid, buffer, variant, apiKey) {
  const target = getAccount(uuid);
  if (target.type === 'offline') {
    const skin = await require('./skins').publishOfflineSkin(buffer, variant, apiKey);
    if (store.data.accounts.find(a => a.uuid === uuid) !== target) throw new Error('Аккаунт удалён во время загрузки.');
    target.offlineSkin = skin;
    saveStore();
    return { accounts:listAccounts(), serverCommand:true };
  }
  const acc = await ensureFreshToken(microsoftAccount(uuid));
  const profile = await require('./skins').uploadSkin(acc.mcAccessToken, buffer, variant);
  if (Array.isArray(profile?.skins)) {
    acc.skins = profile.skins;
    acc.avatar = acc.skins.find(s => s.state === 'ACTIVE')?.url || null;
    saveStore();
    return { accounts: listAccounts() };
  }
  // The upload may succeed even if a later profile read is unavailable.
  try { return { accounts: await refreshSkin(uuid) }; }
  catch { return { accounts: listAccounts(), warning: 'Скин отправлен, но профиль пока не обновился. Нажмите «Обновить скин» позже.' }; }
}

function addOffline(username) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Ник: 3–16 символов, только латиница, цифры и _');
  }
  const acc = {
    type: 'offline',
    uuid: offlineUuid(username),
    username,
    mcAccessToken: '0',
    createdAt: Date.now(),
  };
  const existing = store.data.accounts.find(a => a.uuid === acc.uuid);
  if (existing?.offlineSkin) acc.offlineSkin = existing.offlineSkin;
  store.data.accounts = store.data.accounts.filter(a => a.uuid !== acc.uuid);
  store.data.accounts.push(acc);
  store.data.selected = acc.uuid;
  saveStore();
  return acc;
}

function removeAccount(uuid) {
  store.data.accounts = store.data.accounts.filter((a) => a.uuid !== uuid);
  if (store.data.selected === uuid) store.data.selected = store.data.accounts[0]?.uuid || null;
  saveStore();
}

function selectAccount(uuid) {
  if (store.data.accounts.some((a) => a.uuid === uuid)) {
    store.data.selected = uuid;
    saveStore();
  }
}

function getSelectedAccount({ fresh = false } = {}) {
  const acc = store.data.accounts.find((a) => a.uuid === store.data.selected) || null;
  if (!acc) return Promise.resolve(null);
  if (!fresh) return Promise.resolve(acc);
  return ensureFreshToken(acc);
}

/**
 * Full login flow entry point for IPC.
 * 1) request device code → return it to renderer
 * 2) in background: poll + chain → save account → report via callback
 */
async function beginMicrosoftLogin() {
  const code = await startDeviceLogin();
  const complete = (async () => {
    const msTokens = await waitForMsToken();
    const acc = await mcChain(msTokens);
    acc.createdAt = Date.now();
    const existing = store.data.accounts.findIndex((a) => a.uuid === acc.uuid);
    if (existing >= 0) store.data.accounts[existing] = { ...store.data.accounts[existing], ...acc };
    else store.data.accounts.push(acc);
    store.data.selected = acc.uuid;
    saveStore();
    return acc;
  })();
  return { code, complete };
}

module.exports = {
  accountAvatar, changeSkin, refreshSkin, microsoftAccount, getAccount,
  listAccounts,
  addOffline,
  removeAccount,
  selectAccount,
  getSelectedAccount,
  beginMicrosoftLogin,
  cancelDeviceLogin,
  ensureFreshToken,
};
