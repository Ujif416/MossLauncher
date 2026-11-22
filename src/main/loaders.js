'use strict';

/**
 * loaders.js — список доступных версий загрузчиков для Minecraft.
 *
 * Forge/NeoForge берутся с их Maven-репозиториев, Fabric/Quilt — с meta API.
 * Ошибки оборачиваются в понятные сообщения, чтобы в UI не прилетал голый
 * AggregateError без указания причины.
 */

const { fetchJson, request } = require('./net');
const errors = require('./errors');

async function listLoaderVersions(loader, mcVersion) {
  if (!/^\d[\w.+-]*$/.test(mcVersion || '')) {
    throw new Error('Некорректная версия Minecraft');
  }
  try {
    if (loader === 'fabric' || loader === 'quilt') {
      const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
      const arr = await fetchJson(`${base}/versions/loader/${mcVersion}`);
      return uniqueSorted(arr.map((v) => v.loader.version));
    }
    if (loader === 'neoforge') {
      const match = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?$/);
      if (!match) return [];
      const prefix = `${match[1]}.${match[2] || 0}.`;
      const arr = await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
      return uniqueSorted(arr.versions.filter((v) => v.startsWith(prefix)));
    }
    if (loader === 'forge') {
      const res = await request('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
      if (res.status !== 200) {
        throw new Error(`Forge maven ответил HTTP ${res.status}`);
      }
      const versions = [...res.body.toString().matchAll(/<version>([^<]+)<\/version>/g)]
        .map((m) => m[1])
        .filter((v) => v.startsWith(mcVersion + '-'))
        .map((v) => v.slice(mcVersion.length + 1));
      return uniqueSorted(versions);
    }
    return [];
  } catch (err) {
    // Нормализуем AggregateError от Node (несколько DNS-сокетов подряд упали)
    const described = errors.describe(err);
    throw new Error(`Не удалось получить список версий ${loader}: ${described.message}`);
  }
}

async function chooseLoaderVersion(loader, mcVersion, selected) {
  const versions = await listLoaderVersions(loader, mcVersion);
  if (!versions.length) throw new Error(`${loader} недоступен для ${mcVersion}`);
  if (selected && !versions.includes(selected)) {
    throw new Error('Версия загрузчика не подходит к выбранному Minecraft');
  }
  return selected || versions[0];
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

module.exports = { listLoaderVersions, chooseLoaderVersion };
