'use strict';

/**
 * server-changelog.js — сравнение ревизий серверной сборки (добавленные,
 * обновлённые и удалённые моды и конфиги) и хранение истории обновлений.
 */

const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 12;

/**
 * Нормализует имя JAR-мода для сопоставления старой и новой версий одного мода:
 * например `balm-neoforge-1.21.1-21.0.63.jar` → `balm-neoforge`
 */
function modKey(relPath) {
  const base = path.basename(relPath).replace(/\.jar(?:\.disabled)?$/i, '');
  // Убираем типичные суффиксы версий (-1.21.1, +mc1.21, _v2.3.4 и т.п.)
  const cleaned = base
    .replace(/[-_+](?:mc|neoforge|forge|fabric|quilt)?[-_+]?v?\d+(?:\.\d+)+.*$/i, '')
    .replace(/[-_+]v?\d+.*$/i, '')
    .toLowerCase()
    .trim();
  return cleaned || base.toLowerCase();
}

function isModFile(relPath) {
  return /^mods\/.+\.jar(?:\.disabled)?$/i.test(String(relPath || ''));
}

function isConfigFile(relPath) {
  return /^(config|defaultconfigs)\//i.test(String(relPath || ''));
}

function computeDiff(previousFiles = [], nextFiles = []) {
  const prevMap = new Map(previousFiles.map((f) => [f.path.toLowerCase(), f]));
  const nextMap = new Map(nextFiles.map((f) => [f.path.toLowerCase(), f]));

  const rawAddedMods = [];
  const rawRemovedMods = [];
  const modsUpdated = [];
  const configsChanged = [];
  const otherChanged = [];

  for (const [k, nf] of nextMap) {
    const pf = prevMap.get(k);
    if (!pf) {
      if (isModFile(nf.path)) rawAddedMods.push(nf);
      else if (isConfigFile(nf.path)) configsChanged.push({ path: nf.path, type: 'added' });
      else otherChanged.push({ path: nf.path, type: 'added' });
    } else if (pf.sha256 !== nf.sha256) {
      if (isModFile(nf.path)) {
        modsUpdated.push({ from: path.basename(pf.path), to: path.basename(nf.path), path: nf.path });
      } else if (isConfigFile(nf.path)) {
        configsChanged.push({ path: nf.path, type: 'updated' });
      } else {
        otherChanged.push({ path: nf.path, type: 'updated' });
      }
    }
  }

  for (const [k, pf] of prevMap) {
    if (!nextMap.has(k)) {
      if (isModFile(pf.path)) rawRemovedMods.push(pf);
      else if (isConfigFile(pf.path)) configsChanged.push({ path: pf.path, type: 'removed' });
      else otherChanged.push({ path: pf.path, type: 'removed' });
    }
  }

  // Сопоставляем удалённые и добавленные моды с общим ключом как «обновлённые»
  const removedByKey = new Map();
  for (const r of rawRemovedMods) {
    const key = modKey(r.path);
    if (!removedByKey.has(key)) removedByKey.set(key, []);
    removedByKey.get(key).push(r);
  }

  const modsAdded = [];
  for (const a of rawAddedMods) {
    const key = modKey(a.path);
    const bucket = removedByKey.get(key);
    if (bucket && bucket.length > 0) {
      const old = bucket.shift();
      modsUpdated.push({ from: path.basename(old.path), to: path.basename(a.path), path: a.path });
    } else {
      modsAdded.push(path.basename(a.path));
    }
  }

  const modsRemoved = [];
  for (const bucket of removedByKey.values()) {
    for (const r of bucket) modsRemoved.push(path.basename(r.path));
  }

  modsAdded.sort((a, b) => a.localeCompare(b));
  modsRemoved.sort((a, b) => a.localeCompare(b));
  modsUpdated.sort((a, b) => a.to.localeCompare(b.to));

  const parts = [];
  if (modsAdded.length) parts.push(`+${modsAdded.length} модов`);
  if (modsUpdated.length) parts.push(`~${modsUpdated.length} обновлено`);
  if (modsRemoved.length) parts.push(`-${modsRemoved.length} удалено`);
  if (configsChanged.length) parts.push(`конфиги: ${configsChanged.length}`);
  if (!parts.length && otherChanged.length) parts.push(`файлов: ${otherChanged.length}`);

  return {
    modsAdded,
    modsUpdated,
    modsRemoved,
    configsChanged: configsChanged.slice(0, 50),
    configsCount: configsChanged.length,
    otherCount: otherChanged.length,
    totalChanges: modsAdded.length + modsUpdated.length + modsRemoved.length + configsChanged.length + otherChanged.length,
    summary: parts.length ? parts.join(' · ') : 'Без изменений',
  };
}

function historyPath(rootDir) {
  return path.join(rootDir, 'changelog.json');
}

function readHistory(rootDir) {
  try {
    const file = historyPath(rootDir);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recordEntry(rootDir, entry) {
  const list = readHistory(rootDir);
  const next = [entry, ...list.filter((e) => e.toRevision !== entry.toRevision)].slice(0, MAX_HISTORY);
  fs.mkdirSync(rootDir, { recursive: true });
  const file = historyPath(rootDir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

module.exports = { computeDiff, readHistory, recordEntry, modKey };
