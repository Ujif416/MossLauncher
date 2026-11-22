'use strict';
/**
 * game-instance.js — сборка игровой папки перед запуском.
 *
 * У каждой версии своя папка instances/<id>. В неё попадает:
 *  - моды версии из <gameDir>/mods/<id>/*.jar;
 *  - файлы привязанной сборки из <gameDir>/modpacks/<pack>/ (если есть связь).
 *
 * Связь хранится в instances/<id>/.moss-pack-link и создаётся, когда игрок
 * нажимает «Играть» у сборки. Всё скопированное отслеживается, чтобы при
 * следующем запуске удалять только то, что мы сами положили.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./storage');

const MODS_TRACKING = '.moss-managed-mods.json';
const PACK_TRACKING = '.moss-managed-pack.json';
const PACK_LINK = '.moss-pack-link';

/** Рекурсивный обход папки: список относительных путей файлов. */
function walkFiles(dir, prefix = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(path.join(dir, e.name), rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Удаляет ранее скопированные нами файлы, которых больше нет в списке. */
function prune(target, tracked, keep) {
  const keepSet = new Set(keep.map((f) => f.replace(/\//g, path.sep)));
  for (const rel of tracked) {
    if (keepSet.has(rel)) continue;
    const p = path.join(target, rel);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
}

/**
 * @param {string} root   корень игровой папки
 * @param {string} id     id версии
 * @param {{ packName?: string|null }} [options]
 *        packName — привязать сборку; undefined — взять из .moss-pack-link;
 *        null — отвязать.
 */
function prepareInstance(root, id, options = {}) {
  if (!/^[\w.+-]+$/.test(id)) throw new Error('Некорректная версия игры');
  const directory = path.join(root, 'instances', id);
  fs.mkdirSync(directory, { recursive: true });

  // ---- моды версии: <gameDir>/mods/<id>/*.jar → instances/<id>/mods/
  const modsTarget = path.join(directory, 'mods');
  const modsSource = path.join(root, 'mods', id);
  fs.mkdirSync(modsTarget, { recursive: true });
  const previousMods = readJson(path.join(directory, MODS_TRACKING), []);
  const jars = fs.existsSync(modsSource)
    ? fs.readdirSync(modsSource).filter((f) => f.endsWith('.jar'))
    : [];
  for (const file of previousMods) {
    if (path.basename(file) === file && !jars.includes(file)) {
      fs.rmSync(path.join(modsTarget, file), { force: true });
    }
  }
  for (const file of jars) fs.copyFileSync(path.join(modsSource, file), path.join(modsTarget, file));
  writeJson(path.join(directory, MODS_TRACKING), jars);

  // ---- привязка сборки
  const linkPath = path.join(directory, PACK_LINK);
  let packName = options.packName;
  if (packName === undefined) {
    const link = readJson(linkPath, null);
    packName = (link && link.pack) || null;
  } else if (packName === null) {
    fs.rmSync(linkPath, { force: true });
    packName = null;
  } else {
    writeJson(linkPath, { pack: packName, linkedAt: Date.now() });
  }

  const packTarget = directory;
  const previousPackFiles = readJson(path.join(directory, PACK_TRACKING), []);
  if (!packName) {
    prune(packTarget, previousPackFiles, []);
    writeJson(path.join(directory, PACK_TRACKING), []);
    return directory;
  }

  // ---- файлы сборки: <gameDir>/modpacks/<pack>/** → instances/<id>/**
  const packDir = path.join(root, 'modpacks', packName);
  const copied = [];
  if (fs.existsSync(packDir)) {
    for (const rel of walkFiles(packDir)) {
      // Манифесты самого лаунчера в инстанс не копируем.
      if (path.basename(rel).startsWith('.moss-')) continue;
      const src = path.join(packDir, rel);
      const dest = path.join(packTarget, rel.replace(/\//g, path.sep));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied.push(rel);
    }
  }
  prune(packTarget, previousPackFiles, copied.concat(jars.map((j) => `mods/${j}`)));
  writeJson(path.join(directory, PACK_TRACKING), copied);
  return directory;
}

function linkedPack(root, id) {
  const link = readJson(path.join(root, 'instances', id, PACK_LINK), null);
  return (link && link.pack) || null;
}

function splitJvmArgs(value = '') {
  const tokens = String(value).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.map(s => s.replace(/"([^"]*)"|'([^']*)'/g, (_m, a, b) => a ?? b));
}

module.exports = { prepareInstance, splitJvmArgs, linkedPack };
