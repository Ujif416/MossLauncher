'use strict';

/**
 * crash-analyzer.js — диагностика крашей Minecraft и выгрузка логов на mclo.gs.
 */

const fs = require('fs');
const path = require('path');
const net = require('./net');

const MCLOGS_API = 'https://api.mclo.gs/1/log';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

function readLatestCrashReport(instanceDir) {
  if (!instanceDir) return null;
  const dir = path.join(instanceDir, 'crash-reports');
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter((f) => /^crash-.*\.(txt|log)$/i.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        return { name: f, full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!files.length) return null;
    // Берём только свежие краш-репорты (за последние 10 минут)
    if (Date.now() - files[0].mtimeMs > 10 * 60 * 1000) return null;
    return {
      file: files[0].name,
      text: fs.readFileSync(files[0].full, 'utf8').slice(0, 200000),
    };
  } catch {
    return null;
  }
}

function readLatestLogTail(instanceDir) {
  if (!instanceDir) return '';
  const file = path.join(instanceDir, 'logs', 'latest.log');
  try {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    const len = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, stat.size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function extractModNames(text) {
  const found = [];
  const patterns = [
    /Mod\s+['"`]?([a-zA-Z0-9_.-]{2,40})['"`]?\s+requires/gi,
    /Missing or unsupported mandatory dependencies:[\s\S]{0,400}?Mod ID:\s*['"`]?([a-zA-Z0-9_.-]+)/gi,
    /from mod\s+([a-zA-Z0-9_.-]{2,40})/gi,
    /in\s+([a-zA-Z0-9_.-]{2,40}\.mixins\.json)/gi,
    /([a-zA-Z0-9_.-]{2,60}\.jar)/gi,
  ];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) && found.length < 8) {
      const val = m[1];
      if (!/^(minecraft|java|neoforge|forge|fabric-loader|client)\.jar$/i.test(val)) {
        found.push(val);
      }
    }
  }
  return unique(found).slice(0, 6);
}

function analyzeLogs(input, { exitCode = null, instanceDir = null } = {}) {
  const liveText = Array.isArray(input) ? input.join('\n') : String(input || '');
  const crashReport = readLatestCrashReport(instanceDir);
  const fileLog = !liveText.trim() && instanceDir ? readLatestLogTail(instanceDir) : '';
  const combined = [crashReport?.text || '', liveText, fileLog].filter(Boolean).join('\n');

  if (!combined.trim() && (exitCode === null || exitCode === 0)) {
    return {
      detected: false,
      severity: 'info',
      title: 'Проблем не обнаружено',
      summary: 'Лог пуст или игра завершилась штатно.',
      hints: [],
      culprits: [],
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 1. Out of Memory
  if (/java\.lang\.OutOfMemoryError|GC overhead limit exceeded|Java heap space/i.test(combined) || exitCode === -805306369) {
    return {
      detected: true,
      severity: 'error',
      title: 'Нехватка оперативной памяти (OutOfMemoryError)',
      summary: 'Игре не хватило выделенной RAM. Для сборок на 300–400 модов обычно требуется 6–8 ГБ.',
      hints: [
        'Откройте «Настройки → Игра» и увеличьте максимум памяти (RAM) до 6144–8192 МБ.',
        'Выберите JVM-пресет «Авто» или «Generational ZGC (Java 21+)».',
        'Закройте браузер и другие тяжёлые программы перед запуском.',
      ],
      culprits: [],
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 2. Wrong Java version
  if (/UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/i.test(combined)) {
    const classVerMatch = combined.match(/class file version\s+(\d+)/i);
    const neededJava = classVerMatch ? Math.max(8, parseInt(classVerMatch[1], 10) - 44) : 21;
    return {
      detected: true,
      severity: 'error',
      title: `Неподходящая версия Java (нужна Java ${neededJava}+)`,
      summary: `Выбранная Java слишком старая для этой версии Minecraft или модов.`,
      hints: [
        `Установите Java ${neededJava} в разделе «Настройки → Обнаруженная Java».`,
        'Очистите поле «Путь к java.exe», чтобы лаунчер автоматически выбирал нужную версию.',
      ],
      culprits: [],
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 3. Missing mod dependency / mod resolution error
  if (/Missing or unsupported mandatory dependencies|ModResolutionException|Could not find required mod|Mod .+ requires /i.test(combined)) {
    const culprits = extractModNames(combined);
    return {
      detected: true,
      severity: 'error',
      title: 'Отсутствует зависимость или конфликт версий модов',
      summary: 'Загрузчик не смог запустить сборку: одному из модов не хватает библиотеки или не совпадает версия.',
      hints: [
        culprits.length ? `Проверьте моды: ${culprits.join(', ')}.` : 'Проверьте список модов в логе ниже.',
        'Если это серверная сборка — нажмите «Играть» ещё раз для пересинхронизации файлов.',
      ],
      culprits,
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 4. Mixin conflict
  if (/MixinApplyError|MixinTransformerError|InvalidMixinException|Critical injection failure/i.test(combined)) {
    const culprits = extractModNames(combined);
    return {
      detected: true,
      severity: 'error',
      title: 'Конфликт Mixin между модами',
      summary: 'Один из модов не смог пропатчить код игры — чаще всего это конфликт двух модов или неподходящая версия загрузчика.',
      hints: [
        culprits.length ? `Вероятные участники конфликта: ${culprits.join(', ')}.` : 'Посмотрите строку «Caused by:» в логе.',
        'Выгрузите лог на mclo.gs и отправьте ссылку администратору сборки.',
      ],
      culprits,
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 5. GPU / OpenGL / GLFW driver crash
  if (/GLFW error|Pixel format not accelerated|nvoglv64\.dll|atio6axx\.dll|ig75icd64\.dll|igxelpicd64\.dll|OpenGL/i.test(combined) && /EXCEPTION_ACCESS_VIOLATION|GLFW error|Pixel format/i.test(combined)) {
    return {
      detected: true,
      severity: 'error',
      title: 'Сбой графического драйвера (OpenGL / GLFW)',
      summary: 'Игра упала внутри драйвера видеокарты при инициализации графики.',
      hints: [
        'Обновите драйвер видеокарты (NVIDIA / AMD / Intel).',
        'Попробуйте временно отключить шейдеры или проверить выбор дискретной видеокарты в Windows.',
      ],
      culprits: [],
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 6. Corrupted JAR / Zip
  if (/java\.util\.zip\.ZipException|Invalid CEN header|zip file is empty|error in opening zip file/i.test(combined)) {
    const culprits = extractModNames(combined);
    return {
      detected: true,
      severity: 'error',
      title: 'Повреждённый архив или JAR-файл',
      summary: 'Один из файлов модов или библиотек недокачался или повреждён.',
      hints: [
        culprits.length ? `Подозрительные файлы: ${culprits.join(', ')}.` : 'Проверьте файлы модов в папке профиля.',
        'Для серверной сборки перезапустите подготовку — лаунчер перепроверит SHA-256 и докачает битый файл.',
      ],
      culprits,
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  // 7. Generic non-zero exit or fatal error lines
  const errorLines = combined
    .split(/\r?\n/)
    .filter((l) => /Caused by:|FATAL|Exception:|Error:|\[ERROR\]/i.test(l))
    .slice(-3);

  if ((exitCode !== null && exitCode !== 0) || errorLines.length > 0 || crashReport) {
    return {
      detected: true,
      severity: exitCode && exitCode !== 0 ? 'error' : 'warning',
      title: exitCode && exitCode !== 0 ? `Игра завершилась с ошибкой (код ${exitCode})` : 'В логе обнаружены ошибки',
      summary: errorLines.length
        ? errorLines[errorLines.length - 1].trim().slice(0, 220)
        : 'Явная причина не определена автоматически — загрузите лог на mclo.gs для разбора.',
      hints: [
        'Нажмите «На mclo.gs», чтобы получить короткую ссылку на очищенный лог для отправки в Discord.',
        crashReport ? `Найден файл краша: crash-reports/${crashReport.file}` : 'Проверьте строки, выделенные красным в консоли ниже.',
      ],
      culprits: extractModNames(errorLines.join('\n')),
      exitCode,
      crashFile: crashReport?.file || null,
    };
  }

  return {
    detected: false,
    severity: 'info',
    title: 'Ошибок не найдено',
    summary: 'Критичных ошибок в текущем логе не обнаружено.',
    hints: [],
    culprits: [],
    exitCode,
    crashFile: null,
  };
}

function sanitizeLog(rawText) {
  let text = String(rawText || '');
  // Скрываем имя пользователя Windows/Unix в путях
  text = text.replace(/([A-Za-z]:\\Users\\)([^\\/\r\n]+)/g, '$1<USER>');
  text = text.replace(/(\/home\/|\/Users\/)([^\\/\r\n]+)/g, '$1<USER>');
  // Скрываем токены доступа
  text = text.replace(/(--accessToken\s+)(\S+)/gi, '$1<REDACTED>');
  text = text.replace(/(ghp_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, '<REDACTED_TOKEN>');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1<REDACTED>');
  return text;
}

async function uploadToMclogs(rawText) {
  const sanitized = sanitizeLog(rawText).trim();
  if (!sanitized) throw new Error('Лог пуст — нечего выгружать.');
  const content = sanitized.length > MAX_UPLOAD_BYTES
    ? sanitized.slice(-MAX_UPLOAD_BYTES)
    : sanitized;
  const body = 'content=' + encodeURIComponent(content);
  const res = await net.request(MCLOGS_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
    timeout: 20000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`mclo.gs вернул HTTP ${res.status}`);
  }
  const data = JSON.parse(res.body.toString('utf8'));
  if (!data.success || !data.url) {
    throw new Error(data.error || 'mclo.gs не смог сохранить лог');
  }
  return { id: data.id, url: data.url, raw: data.raw };
}

module.exports = { analyzeLogs, sanitizeLog, uploadToMclogs, readLatestCrashReport };
