'use strict';

/**
 * profile-tools.js — обнаружение игровых профилей, синхронизация options.txt
 * между профилями (с резервной копией) и галерея скриншотов.
 */

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../shared/constants');

const OPTION_CATEGORIES = {
  controls: {
    id: 'controls',
    label: 'Управление (клавиши и мышь)',
    match: (k) => k.startsWith('key_') || ['mouseSensitivity', 'invertYMouse', 'rawMouseInput', 'autoJump', 'toggleCrouch', 'toggleSprint', 'discrete_mouse_scroll', 'mouseWheelSensitivity'].includes(k),
  },
  video: {
    id: 'video',
    label: 'Графика, FOV и экран',
    match: (k) => ['fov', 'gamma', 'renderDistance', 'simulationDistance', 'guiScale', 'maxFps', 'fullscreen', 'enableVsync', 'particles', 'graphicsMode', 'ao', 'mipmapLevels', 'entityShadows', 'bobView', 'fovEffectScale', 'screenEffectScale', 'darknessEffectScale', 'biomeBlendRadius', 'renderClouds', 'cloudHeight'].includes(k),
  },
  audio: {
    id: 'audio',
    label: 'Звук и музыка',
    match: (k) => k.startsWith('soundCategory_') || ['soundDevice', 'showSubtitles', 'directionalAudio'].includes(k),
  },
  language: {
    id: 'language',
    label: 'Язык и чат',
    match: (k) => ['lang', 'forceUnicodeFont', 'chatOpacity', 'chatScale', 'chatWidth', 'chatHeightFocused', 'chatHeightUnfocused', 'chatVisibility', 'chatColors', 'chatLinks', 'narrator'].includes(k),
  },
};

function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function countScreenshots(dir) {
  const sdir = path.join(dir, 'screenshots');
  try {
    if (!fs.existsSync(sdir)) return 0;
    return fs.readdirSync(sdir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
  } catch {
    return 0;
  }
}

function listProfiles(settings = {}) {
  const root = path.resolve(settings.gameDir || PATHS.defaultGameDir);
  const profiles = [];

  // 1. Основная папка игры
  if (fs.existsSync(root)) {
    const hasOptions = fs.existsSync(path.join(root, 'options.txt'));
    const screenshotCount = countScreenshots(root);
    if (hasOptions || screenshotCount > 0) {
      profiles.push({
        id: 'main',
        label: 'Основной профиль',
        kind: 'main',
        dir: root,
        hasOptions,
        screenshotCount,
      });
    }
  }

  // 2. Серверные профили: <gameDir>/servers/<id>/game
  const serversDir = path.join(root, 'servers');
  if (fs.existsSync(serversDir)) {
    try {
      for (const entry of fs.readdirSync(serversDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const gameDir = path.join(serversDir, entry.name, 'game');
        if (!fs.existsSync(gameDir)) continue;
        profiles.push({
          id: `server:${entry.name}`,
          label: `Сервер: ${entry.name}`,
          kind: 'server',
          dir: gameDir,
          hasOptions: fs.existsSync(path.join(gameDir, 'options.txt')),
          screenshotCount: countScreenshots(gameDir),
        });
      }
    } catch {}
  }

  // 3. Инстансы версий: <gameDir>/instances/<id>
  const instancesDir = path.join(root, 'instances');
  if (fs.existsSync(instancesDir)) {
    try {
      for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(instancesDir, entry.name);
        profiles.push({
          id: `instance:${entry.name}`,
          label: `Версия: ${entry.name}`,
          kind: 'instance',
          dir,
          hasOptions: fs.existsSync(path.join(dir, 'options.txt')),
          screenshotCount: countScreenshots(dir),
        });
      }
    } catch {}
  }

  return profiles;
}

function parseOptions(text) {
  const entries = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    entries.set(key, value);
  }
  return entries;
}

function serializeOptions(entries) {
  const out = [];
  for (const [k, v] of entries) out.push(`${k}:${v}`);
  return out.join('\n') + '\n';
}

function matchesCategories(key, categories) {
  if (!categories || !categories.length || categories.includes('all')) return true;
  for (const catId of categories) {
    const cat = OPTION_CATEGORIES[catId];
    if (cat && cat.match(key)) return true;
  }
  return false;
}

function syncOptions(settings, { sourceId, targetIds = [], categories = ['controls', 'video', 'audio', 'language'] } = {}) {
  const root = path.resolve(settings.gameDir || PATHS.defaultGameDir);
  const profiles = listProfiles(settings);
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const source = byId.get(sourceId);
  if (!source) throw new Error('Исходный профиль не найден.');
  const sourceFile = path.join(source.dir, 'options.txt');
  if (!fs.existsSync(sourceFile)) throw new Error(`В профиле «${source.label}» нет файла options.txt.`);

  const sourceMap = parseOptions(fs.readFileSync(sourceFile, 'utf8'));
  const keysToSync = [...sourceMap.entries()].filter(([k]) => matchesCategories(k, categories));
  if (!keysToSync.length) throw new Error('В выбранных категориях не найдено параметров для синхронизации.');

  const updated = [];
  const skipped = [];

  for (const tid of targetIds) {
    if (tid === sourceId) continue;
    const target = byId.get(tid);
    if (!target || !isInside(root, target.dir)) {
      skipped.push({ id: tid, reason: 'Профиль не найден' });
      continue;
    }
    const targetFile = path.join(target.dir, 'options.txt');
    let targetMap = new Map();
    if (fs.existsSync(targetFile)) {
      // Резервная копия перед перезаписью
      fs.copyFileSync(targetFile, path.join(target.dir, 'options.txt.bak'));
      targetMap = parseOptions(fs.readFileSync(targetFile, 'utf8'));
    }
    let changedCount = 0;
    for (const [k, v] of keysToSync) {
      if (targetMap.get(k) !== v) {
        targetMap.set(k, v);
        changedCount += 1;
      }
    }
    fs.mkdirSync(target.dir, { recursive: true });
    const tmp = targetFile + '.tmp';
    fs.writeFileSync(tmp, serializeOptions(targetMap), 'utf8');
    fs.renameSync(tmp, targetFile);
    updated.push({ id: target.id, label: target.label, changedCount });
  }

  return { source: source.label, keysCount: keysToSync.length, updated, skipped };
}

function listScreenshots(settings, profileId = 'all') {
  const root = path.resolve(settings.gameDir || PATHS.defaultGameDir);
  const profiles = listProfiles(settings);
  const items = [];

  for (const p of profiles) {
    if (profileId && profileId !== 'all' && p.id !== profileId) continue;
    const sdir = path.join(p.dir, 'screenshots');
    if (!fs.existsSync(sdir)) continue;
    let entries;
    try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !/\.(png|jpe?g|webp)$/i.test(e.name)) continue;
      const full = path.join(sdir, e.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const relFromRoot = path.relative(root, full).replace(/\\/g, '/');
      items.push({
        id: relFromRoot,
        name: e.name,
        filePath: full,
        relPath: relFromRoot,
        url: `app://launcher/screenshots/${encodeURIComponent(relFromRoot)}`,
        profileId: p.id,
        profileLabel: p.label,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

function resolveSafeScreenshot(settings, relPath) {
  const root = path.resolve(settings.gameDir || PATHS.defaultGameDir);
  const cleanRel = String(relPath || '').replace(/^\/+/, '');
  const full = path.resolve(root, cleanRel);
  if (!isInside(root, full)) throw new Error('Недопустимый путь к скриншоту.');
  if (!/\.(png|jpe?g|webp)$/i.test(full)) throw new Error('Недопустимый формат файла.');
  if (path.basename(path.dirname(full)).toLowerCase() !== 'screenshots') {
    throw new Error('Файл должен находиться в папке screenshots.');
  }
  return full;
}

module.exports = {
  OPTION_CATEGORIES,
  listProfiles,
  parseOptions,
  serializeOptions,
  syncOptions,
  listScreenshots,
  resolveSafeScreenshot,
};
