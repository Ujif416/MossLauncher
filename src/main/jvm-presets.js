'use strict';

/**
 * jvm-presets.js — умные JVM-пресеты для Java 17/21 и рекомендации по RAM.
 */

const os = require('os');

const G1GC_BALANCED = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-Dfile.encoding=UTF-8',
];

const ZGC_GENERATIONAL = [
  '-XX:+UseZGC',
  '-XX:+ZGenerational',
  '-XX:+AlwaysPreTouch',
  '-XX:+DisableExplicitGC',
  '-XX:+PerfDisableSharedMem',
  '-Dfile.encoding=UTF-8',
];

const AIKAR_HEAVY = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=130',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=28',
  '-XX:G1MaxNewSizePercent=50',
  '-XX:G1HeapRegionSize=16M',
  '-XX:G1ReservePercent=15',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=20',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-Dfile.encoding=UTF-8',
];

const JVM_PRESETS = {
  auto: {
    id: 'auto',
    label: 'Авто (рекомендуется)',
    description: 'Generational ZGC для Java 21+ и 6+ ГБ RAM, иначе сбалансированный G1GC.',
  },
  g1gc: {
    id: 'g1gc',
    label: 'G1GC (сбалансированный)',
    description: 'Надёжный сборщик мусора для любых версий Java и объёмов памяти.',
  },
  zgc: {
    id: 'zgc',
    label: 'Generational ZGC (Java 21+)',
    description: 'Минимальные микрофризы на больших сборках (300+ модов). На Java < 21 откатывается к G1GC.',
  },
  aikar: {
    id: 'aikar',
    label: 'Aikar / тяжёлые сборки',
    description: 'Агрессивная настройка G1GC с крупными регионами 16M для модпаков.',
  },
  custom: {
    id: 'custom',
    label: 'Только свои аргументы',
    description: 'Лаунчер передаст только -Xmx/-Xms и ваши дополнительные аргументы JVM.',
  },
};

function recommendRam(totalMemMb = Math.floor(os.totalmem() / (1024 * 1024))) {
  const total = Math.max(2048, Number(totalMemMb) || 8192);
  // Оставляем ОС минимум 2–4 ГБ, чтобы не уходить в своп.
  const reserve = total >= 16384 ? 4096 : total >= 12288 ? 3072 : 2048;
  const maxSafe = Math.max(2048, Math.floor((total - reserve) / 512) * 512);
  const standard = Math.min(maxSafe, total >= 16384 ? 6144 : total >= 8192 ? 4096 : 2048);
  const heavyModpack = Math.min(maxSafe, total >= 16384 ? 8192 : total >= 12288 ? 6144 : maxSafe);
  return {
    totalMemMb: total,
    maxSafeMb: maxSafe,
    standardMb: standard,
    heavyModpackMb: heavyModpack,
  };
}

function resolveJvmFlags(settings = {}, javaMajor = 21) {
  const ram = Math.max(1024, parseInt(settings.maxRamMb, 10) || 4096);
  const minRam = Math.min(ram, Math.max(512, parseInt(settings.minRamMb, 10) || 1024));
  const preset = JVM_PRESETS[settings.jvmPreset] ? settings.jvmPreset : 'auto';
  const major = Number(javaMajor) || 0;

  let gcFlags;
  let effectivePreset = preset;

  if (preset === 'custom') {
    gcFlags = ['-Dfile.encoding=UTF-8'];
  } else if (preset === 'zgc') {
    if (major >= 21) {
      gcFlags = ZGC_GENERATIONAL;
    } else {
      gcFlags = G1GC_BALANCED;
      effectivePreset = 'g1gc';
    }
  } else if (preset === 'aikar') {
    gcFlags = AIKAR_HEAVY;
  } else if (preset === 'auto') {
    if (major >= 21 && ram >= 6144) {
      gcFlags = ZGC_GENERATIONAL;
      effectivePreset = 'zgc';
    } else {
      gcFlags = G1GC_BALANCED;
      effectivePreset = 'g1gc';
    }
  } else {
    gcFlags = G1GC_BALANCED;
  }

  return {
    ram,
    minRam,
    preset,
    effectivePreset,
    flags: [`-Xmx${ram}M`, `-Xms${minRam}M`, ...gcFlags],
  };
}

module.exports = { JVM_PRESETS, recommendRam, resolveJvmFlags };
