/**
 * settings.js — настройки лаунчера.
 *
 * Все изменения сохраняются сразу через window.moss.settings.set().
 * Включает: память + рекомендации RAM, JVM-пресеты, поведение окна,
 * синхронизацию options.txt между профилями, автообновление EXE и Java.
 */

import { el, formatBytes } from '../ui-utils.js';
import { button, chip, field, panel, selectInput, textInput, toggle } from '../ui/components.js';
import { confirmDialog } from '../ui/dialogs.js';
import { appState } from '../app-state.js';

export function settingsView(container) {
  let disposed = false;
  const s = appState.state.settings || {};
  let javaInfo = null;
  let sysInfo = null;
  let updateInfo = appState.state.launcherUpdate || null;
  let updating = false;

  const javaSlot = el('div');
  const ramHelperSlot = el('div', { className: 'ram-helper' });
  const presetDescEl = el('p', { className: 'muted' });
  const updaterSlot = el('div', { className: 'col' });
  const syncSlot = el('div', { className: 'col' });
  const saveStatus = el('span', { className: 'muted' });

  function patch(p) {
    Object.assign(s, p);
    window.moss.settings.set(p).catch((error) => {
      saveStatus.textContent = 'Ошибка сохранения';
      appState.toast(error.message, 'error');
    });
    appState.update({ settings: { ...s } });
    saveStatus.textContent = 'Сохранено';
    setTimeout(() => { if (!disposed) saveStatus.textContent = ''; }, 1500);
  }

  // ---------- game ----------
  const ramInput = textInput(s.maxRamMb, {
    type: 'number',
    onInput: (e) => patch({ maxRamMb: Math.max(1024, parseInt(e.target.value, 10) || 4096) }),
  });

  const ramField = field(
    'Максимум памяти, МБ',
    el('div', { className: 'col' }, ramInput, ramHelperSlot),
    'Оптимально 4096–6144 МБ. Для тяжёлых сборок на 300+ модов — 8192 МБ.'
  );

  const PRESET_FALLBACK = [
    { id: 'auto', label: 'Авто (рекомендуется)', description: 'Generational ZGC для Java 21+ и 6+ ГБ RAM, иначе сбалансированный G1GC.' },
    { id: 'g1gc', label: 'G1GC (сбалансированный)', description: 'Надёжный сборщик мусора для любых версий Java и объёмов памяти.' },
    { id: 'zgc', label: 'Generational ZGC (Java 21+)', description: 'Минимальные микрофризы на больших сборках (300+ модов).' },
    { id: 'aikar', label: 'Aikar / тяжёлые сборки', description: 'Агрессивная настройка G1GC с крупными регионами 16M для модпаков.' },
    { id: 'custom', label: 'Только свои аргументы', description: 'Лаунчер передаст только -Xmx/-Xms и ваши дополнительные аргументы JVM.' },
  ];

  function updatePresetDesc(presetId) {
    const list = sysInfo?.jvmPresets || PRESET_FALLBACK;
    const found = list.find((p) => p.id === presetId) || list[0];
    presetDescEl.textContent = found ? found.description : '';
  }

  const presetSelect = selectInput(
    PRESET_FALLBACK.map((p) => ({ value: p.id, label: p.label })),
    s.jvmPreset || 'auto',
    (val) => {
      patch({ jvmPreset: val });
      updatePresetDesc(val);
    }
  );
  updatePresetDesc(s.jvmPreset || 'auto');

  const presetField = field(
    'Пресет JVM (сборщик мусора)',
    el('div', { className: 'col' }, presetSelect, presetDescEl)
  );

  const javaField = field(
    'Путь к java.exe',
    el(
      'div',
      { className: 'input-group' },
      textInput(s.javaPath, { placeholder: 'Автоопределение / managed runtime', onInput: (e) => patch({ javaPath: e.target.value.trim() }) }),
      button('Обзор', {
        variant: 'secondary',
        onClick: async () => {
          const p = await window.moss.system.browseFolder('java');
          if (p) patch({ javaPath: p });
        },
      })
    ),
    'Оставьте пустым — лаунчер найдёт Java сам или предложит установить Temurin.'
  );

  const dirField = field(
    'Папка игры',
    el(
      'div',
      { className: 'input-group' },
      textInput(s.gameDir, { onInput: (e) => patch({ gameDir: e.target.value.trim() }) }),
      button('Обзор', {
        variant: 'secondary',
        onClick: async () => {
          const p = await window.moss.system.browseFolder();
          if (p) patch({ gameDir: p });
        },
      }),
      button('Открыть', { variant: 'ghost', iconName: 'folder-open', onClick: () => window.moss.system.openFolder(s.gameDir) })
    )
  );

  const argsField = field(
    'Дополнительные аргументы JVM',
    textInput(s.jvmArgs, { placeholder: '-XX:+UseG1GC', onInput: (e) => patch({ jvmArgs: e.target.value }) }),
    'Перечисляйте через пробел. Добавляются поверх выбранного пресета.'
  );

  // ---------- behavior ----------
  const hideOnLaunch = field(
    'Скрывать окно лаунчера во время игры (экономит RAM)',
    toggle(s.keepLauncherOpen === false, (v) => patch({ keepLauncherOpen: !v })),
    'Окно скроется после запуска Minecraft и автоматически вернётся при закрытии игры.'
  );
  const closeOnLaunch = field(
    'Сворачивать лаунчер в панель задач при запуске',
    toggle(!!s.closeOnLaunch, (v) => patch({ closeOnLaunch: v }))
  );
  const showConsole = field(
    'Открывать вкладку «Логи» при запуске игры',
    toggle(!!s.showConsole, (v) => patch({ showConsole: v }))
  );

  // ---------- integrations ----------
  const cfKeyField = field(
    'CurseForge API-ключ',
    textInput(s.curseforgeApiKey, { placeholder: 'console.curseforge.com → API keys', onInput: (e) => patch({ curseforgeApiKey: e.target.value.trim() }) }),
    'Опционально: нужен только для поиска по CurseForge. Установка модов и сборок по ссылке работает и без ключа.'
  );

  const ghTokenField = field(
    'GitHub Personal Access Token',
    textInput(s.githubToken, { type: 'password', placeholder: 'github.com → Settings → Developer settings', onInput: (e) => patch({ githubToken: e.target.value.trim() }) }),
    'Нужен только для команды «Опубликовать обновление сборки». Токен хранится локально и не передаётся никуда, кроме api.github.com.'
  );

  // ---------- system info & RAM recommendations ----------
  async function loadSystemInfo() {
    try {
      sysInfo = await window.moss.system.info();
      if (disposed) return;
      const rec = sysInfo.recommendedRam;
      const totalGb = (sysInfo.totalMemMb / 1024).toFixed(1).replace('.0', '');
      ramHelperSlot.replaceChildren(
        el('span', { className: 'ram-helper__info' }, `ОЗУ системы: ${totalGb} ГБ · Безопасный лимит: ${rec.maxSafeMb} МБ`),
        button(`Обычная (${rec.standardMb} МБ)`, {
          variant: 'secondary',
          onClick: () => {
            ramInput.value = String(rec.standardMb);
            patch({ maxRamMb: rec.standardMb });
            appState.toast(`Установлено ${rec.standardMb} МБ RAM`, 'success');
          },
        }),
        button(`Тяжёлая сборка (${rec.heavyModpackMb} МБ)`, {
          variant: 'secondary',
          onClick: () => {
            ramInput.value = String(rec.heavyModpackMb);
            patch({ maxRamMb: rec.heavyModpackMb });
            appState.toast(`Установлено ${rec.heavyModpackMb} МБ RAM`, 'success');
          },
        })
      );
      renderUpdater();
    } catch {}
  }

  // ---------- launcher updater ----------
  const updateProgressText = el('p', { className: 'muted' });
  const unsubUpdate = window.moss.events.onUpdateProgress((p) => {
    if (disposed) return;
    if (p.stage === 'download') {
      const pct = p.total > 0 ? Math.floor((100 * p.done) / p.total) : null;
      updateProgressText.textContent = pct !== null
        ? `Загрузка ${p.file}: ${pct}% (${formatBytes(p.done)} / ${formatBytes(p.total)})`
        : `Загрузка ${p.file}: ${formatBytes(p.done)}`;
    } else if (p.stage === 'verify') {
      updateProgressText.textContent = 'Проверка SHA-256 контрольной суммы…';
    } else if (p.stage === 'launching') {
      updateProgressText.textContent = 'Запуск установщика обновления…';
    }
  });

  async function checkUpdates() {
    updateProgressText.textContent = 'Проверяем GitHub Releases…';
    try {
      updateInfo = await window.moss.updater.check();
      appState.update({ launcherUpdate: updateInfo?.updateAvailable ? updateInfo : null });
      if (!disposed) {
        updateProgressText.textContent = '';
        renderUpdater();
        if (updateInfo.updateAvailable) {
          appState.toast(`Найдена новая версия v${updateInfo.latestVersion}`, 'success');
        } else if (updateInfo.message) {
          appState.toast(updateInfo.message, 'info');
        } else {
          appState.toast(`Установлена актуальная версия v${updateInfo.currentVersion}`, 'success');
        }
      }
    } catch (e) {
      if (!disposed) {
        updateProgressText.textContent = '';
        appState.toast(e.message, 'error', 'Ошибка проверки обновлений');
      }
    }
  }

  async function installUpdate() {
    if (updating || !updateInfo?.asset) return;
    const ok = await confirmDialog({
      title: `Установить MossLauncher v${updateInfo.latestVersion}?`,
      message: updateInfo.portable
        ? 'Новая портативная версия будет скачана и открыта в папке.'
        : 'Установщик будет скачан, проверен по SHA-256 и запущен. Лаунчер закроется для обновления.',
      confirmLabel: 'Скачать и установить',
    });
    if (!ok) return;
    updating = true;
    renderUpdater();
    try {
      const res = await window.moss.updater.install(updateInfo);
      if (res.portable) {
        appState.toast('Портативная версия скачана и показана в папке', 'success');
      }
    } catch (e) {
      appState.toast(e.message, 'error', 'Не удалось обновить лаунчер');
    } finally {
      updating = false;
      if (!disposed) renderUpdater();
    }
  }

  function renderUpdater() {
    const ver = sysInfo?.appVersion || updateInfo?.currentVersion || '—';
    const kind = sysInfo?.isPortable ? 'Portable' : 'Установщик';
    const repoField = field(
      'GitHub-репозиторий релизов',
      textInput(s.updateRepo || '', {
        placeholder: 'owner/repo (например, Ujif416/MossLauncher)',
        onInput: (e) => patch({ updateRepo: e.target.value.trim() }),
      })
    );
    const autoToggle = field(
      'Проверять обновления при запуске',
      toggle(s.autoCheckUpdates !== false, (v) => patch({ autoCheckUpdates: v }))
    );

    const statusBox = updateInfo?.updateAvailable
      ? el(
          'div',
          { className: 'updater-box' },
          el('div', { className: 'row' }, chip(`Доступна v${updateInfo.latestVersion}`, 'accent'), el('span', { className: 'muted' }, updateInfo.releaseName || '')),
          updateInfo.notes ? el('div', { className: 'updater-notes' }, updateInfo.notes) : null,
          el(
            'div',
            { className: 'row' },
            updateInfo.asset
              ? button(updating ? 'Загрузка…' : `Скачать и установить (${formatBytes(updateInfo.asset.size)})`, {
                  variant: 'primary',
                  iconName: 'download',
                  disabled: updating,
                  onClick: installUpdate,
                })
              : el('span', { className: 'muted' }, 'EXE-файл не найден в релизе'),
            updateInfo.releaseUrl
              ? button('Открыть релиз', { variant: 'ghost', iconName: 'external-link', onClick: () => window.moss.system.openExternal(updateInfo.releaseUrl) })
              : null
          )
        )
      : updateInfo
        ? el('p', { className: 'muted' }, updateInfo.message || `Актуальная версия v${ver} уже установлена.`)
        : null;

    updaterSlot.replaceChildren(
      el('div', { className: 'row' }, chip(`v${ver}`), chip(kind)),
      repoField,
      autoToggle,
      el('div', { className: 'row' }, button('Проверить обновления', { variant: 'secondary', iconName: 'check-updates', disabled: updating, onClick: checkUpdates })),
      updateProgressText,
      statusBox
    );
  }

  // ---------- options.txt synchronization ----------
  async function loadProfilesSync() {
    syncSlot.replaceChildren(el('p', { className: 'muted' }, 'Поиск игровых профилей…'));
    try {
      const data = await window.moss.profiles.list();
      if (disposed) return;
      const profiles = data.profiles || [];
      const categories = data.categories || [];
      const withOptions = profiles.filter((p) => p.hasOptions);

      if (profiles.length < 2 || !withOptions.length) {
        syncSlot.replaceChildren(
          el('p', { className: 'muted' }, 'Для синхронизации нужно минимум два профиля (например, сервер и обычная версия), и хотя бы один должен иметь файл options.txt.')
        );
        return;
      }

      let sourceId = withOptions[0].id;
      const selectedTargets = new Set(profiles.filter((p) => p.id !== sourceId).map((p) => p.id));
      const selectedCats = new Set(categories.map((c) => c.id));
      const targetsHost = el('div', { className: 'check-list' });
      const syncBtn = button('Синхронизировать настройки', { variant: 'primary', iconName: 'sync' });

      function renderTargets() {
        targetsHost.replaceChildren(
          ...profiles
            .filter((p) => p.id !== sourceId)
            .map((p) => {
              const cb = el('input', {
                type: 'checkbox',
                checked: selectedTargets.has(p.id),
                onChange: (e) => {
                  if (e.target.checked) selectedTargets.add(p.id);
                  else selectedTargets.delete(p.id);
                },
              });
              return el('label', { className: 'check-item' }, cb, el('span', {}, p.label));
            })
        );
      }

      const sourceSel = selectInput(
        withOptions.map((p) => ({ value: p.id, label: p.label })),
        sourceId,
        (val) => {
          sourceId = val;
          selectedTargets.delete(sourceId);
          renderTargets();
        }
      );

      const catsHost = el(
        'div',
        { className: 'check-list' },
        ...categories.map((c) => {
          const cb = el('input', {
            type: 'checkbox',
            checked: true,
            onChange: (e) => {
              if (e.target.checked) selectedCats.add(c.id);
              else selectedCats.delete(c.id);
            },
          });
          return el('label', { className: 'check-item' }, cb, el('span', {}, c.label));
        })
      );

      syncBtn.onclick = async () => {
        const targetIds = [...selectedTargets].filter((id) => id !== sourceId);
        const cats = [...selectedCats];
        if (!targetIds.length) { appState.toast('Выберите хотя бы один целевой профиль', 'info'); return; }
        if (!cats.length) { appState.toast('Выберите хотя бы одну категорию настроек', 'info'); return; }
        syncBtn.disabled = true;
        try {
          const res = await window.moss.profiles.syncOptions({ sourceId, targetIds, categories: cats });
          appState.toast(`Синхронизировано профилей: ${res.updated.length} (параметров: ${res.keysCount}). Созданы резервные копии options.txt.bak.`, 'success', 'options.txt обновлён', 5500);
        } catch (e) {
          appState.toast(e.message, 'error');
        } finally {
          syncBtn.disabled = false;
        }
      };

      renderTargets();
      syncSlot.replaceChildren(
        el('p', { className: 'muted' }, 'Переносит клавиши, графику, звук и язык между профилями без потери модовых настроек. Перед записью создаётся options.txt.bak.'),
        field('Откуда брать настройки', sourceSel),
        field('Куда применить', targetsHost),
        field('Какие категории синхронизировать', catsHost),
        el('div', { className: 'row' }, syncBtn, button('Обновить список', { variant: 'ghost', onClick: loadProfilesSync }))
      );
    } catch (e) {
      if (!disposed) syncSlot.replaceChildren(el('p', { className: 'field__error' }, e.message));
    }
  }

  // ---------- java detect ----------
  async function detectJava() {
    javaSlot.replaceChildren(el('p', { className: 'muted' }, 'Ищем Java…'));
    try {
      const result = await window.moss.java.detect();
      javaInfo = result.found || {};
    } catch (e) {
      javaInfo = { error: e.message };
    }
    if (!disposed) renderJava();
  }

  function renderJava() {
    if (!javaInfo) return;
    const content = javaInfo.error
      ? el('p', { className: 'field__error' }, javaInfo.error)
      : javaInfo.path
        ? el(
            'div',
            { className: 'col' },
            el('p', { className: 'mono' }, javaInfo.path),
            el('p', { className: 'muted' }, `Версия ${javaInfo.major || '?'}`)
          )
        : el('p', { className: 'muted' }, 'Java не найдена.');
    javaSlot.replaceChildren(
      el(
        'div',
        { className: 'col' },
        content,
        javaInfo && !javaInfo.error && !javaInfo.path
          ? button('Установить Temurin JRE 17', { variant: 'primary', iconName: 'download', onClick: () => installJava(17) })
          : button('Проверить снова', { variant: 'secondary', onClick: detectJava })
      )
    );
  }

  async function installJava(major) {
    javaSlot.replaceChildren(el('p', { className: 'muted' }, `Скачиваем Temurin ${major}…`));
    try {
      const res = await window.moss.java.install(major);
      javaInfo = res;
      appState.toast(`Java ${major} установлена`, 'success');
    } catch (e) {
      javaInfo = { error: e.message };
      appState.toast(e.message, 'error');
    }
    if (!disposed) renderJava();
  }

  const left = el(
    'div',
    { className: 'col' },
    panel(el('h3', {}, 'Игра'), ramField, presetField, javaField, dirField, argsField),
    panel(el('h3', {}, 'Поведение'), hideOnLaunch, closeOnLaunch, showConsole),
    panel(el('h3', {}, 'Синхронизация options.txt'), syncSlot),
    panel(el('h3', {}, 'Интеграции'), cfKeyField, ghTokenField)
  );

  const right = el(
    'div',
    { className: 'col' },
    panel(el('h3', {}, 'Обновления лаунчера'), updaterSlot),
    panel(
      el('h3', {}, 'Обнаруженная Java'),
      javaSlot,
      el('div', { className: 'row' }, button('Проверить', { variant: 'secondary', onClick: detectJava }), button('Установить 17', { variant: 'secondary', onClick: () => installJava(17) }), button('Установить 21', { variant: 'secondary', onClick: () => installJava(21) }))
    ),
    panel(
      el('h3', {}, 'Прочее'),
      field('Сбросить настройки', button('Сбросить', {
        variant: 'danger',
        onClick: async () => {
          const ok = await confirmDialog({ title: 'Сбросить настройки?', message: 'Все параметры вернутся к значениям по умолчанию.', confirmLabel: 'Сбросить', danger: true });
          if (!ok) return;
          const next = await window.moss.settings.reset();
          appState.update({ settings: next });
          appState.toast('Настройки сброшены', 'success');
          container.replaceChildren();
          settingsView(container);
        },
      }))
    )
  );

  container.append(
    el(
      'div',
      { className: 'view__inner' },
      el('div', { className: 'page-head' }, el('div', {}, el('h1', { className: 'page-head__title' }, 'Настройки'), el('p', { className: 'page-head__sub' }, 'Память, JVM, обновления, профили и интеграции')), saveStatus),
      el('div', { className: 'settings__grid' }, left, right)
    )
  );

  renderUpdater();
  detectJava();
  loadSystemInfo();
  loadProfilesSync();

  return {
    unmount() {
      disposed = true;
      unsubUpdate();
    },
  };
}
