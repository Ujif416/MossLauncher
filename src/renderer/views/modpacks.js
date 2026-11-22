/**
 * modpacks.js — синхронизация сборок из GitHub, CurseForge и Modrinth.
 *
 * Пользователь вставляет ссылку или slug:
 *  - github.com/owner/repo (или owner/repo)
 *  - curseforge.com/minecraft/modpacks/<slug> (или cf:<slug>)
 *  - modrinth.com/modpack/<slug> (или mr:<slug>)
 *
 * Лаунчер сам определяет источник, скачивает архив, распаковывает и
 * синхронизирует файлы в <gameDir>/modpacks/<name>. Манифест
 * .moss-pack.json хранит sha256 — обновления пишут только разницу.
 */

import { el, icon, formatBytes, shortDate } from '../ui-utils.js';
import { button, chip, emptyState, field, modal, progressBar, textInput, selectInput, spinner } from '../ui/components.js';
import { confirmDialog } from '../ui/dialogs.js';
import { appState, refreshPacks } from '../app-state.js';

const SOURCES = [
  { value: 'auto', label: 'Определить автоматически' },
  { value: 'github', label: 'GitHub' },
  { value: 'curseforge', label: 'CurseForge' },
  { value: 'modrinth', label: 'Modrinth' },
];

const SOURCE_LABELS = { github: 'GitHub', curseforge: 'CurseForge', modrinth: 'Modrinth' };

export function modpacksView(container) {
  const listHost = el('div', { className: 'col' });
  const progressHost = el('div');
  const progressMessage = el('span', { className: 'pack-progress__message' });
  const progressCount = el('span', { className: 'pack-progress__count muted' });
  const bar = progressBar(0);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Прогресс текущего этапа загрузки сборки');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const progressPanel = el('div', { className: 'pack-progress' },
    el('div', { className: 'row row--between' }, progressMessage, progressCount), bar);
  progressHost.append(progressPanel);
  let renderedPacks = null;
  const dialogs = new Set();

  container.append(
    el(
      'div',
      { className: 'view__inner' },
      el(
        'div',
        { className: 'page-head' },
        el(
          'div',
          {},
          el('h1', { className: 'page-head__title' }, 'Сборки'),
          el('p', { className: 'page-head__sub' }, 'GitHub, CurseForge и Modrinth — синхронизация файлов с игрой')
        ),
        el('div', { className: 'page-head__actions' }, button('Добавить сборку', { variant: 'primary', iconName: 'plus', onClick: addPack }))
      ),
      progressHost,
      listHost
    )
  );

  function updateProgress() {
    const p = appState.state.syncProgress;
    progressHost.hidden = !p;
    if (!p) return;
    const complete = p.stage === 'done';
    const total = Number(p.total) || 0;
    const done = Math.max(0, Number(p.done) || 0);
    const known = total > 0;
    const percent = complete ? 100 : Math.min(100, Math.floor(done / total * 100));
    progressPanel.classList.toggle('is-done', complete);
    progressMessage.textContent = p.message || 'Синхронизация…';
    progressMessage.title = progressMessage.textContent;
    if (complete || known) {
      bar.setValue(percent);
      bar.setAttribute('aria-valuenow', String(percent));
    } else {
      bar.classList.add('progress--indeterminate');
      bar.removeAttribute('aria-valuenow');
    }
    const count = p.unit === 'bytes'
      ? `${formatBytes(done)}${known ? ' / ' + formatBytes(total) : ' загружено'}`
      : known ? `${done} / ${total} файлов` : '';
    progressCount.textContent = complete ? 'Готово' : `${known ? percent + '% · ' : ''}${count || 'Выполняется…'}`;
    bar.setAttribute('aria-valuetext', `${progressMessage.textContent} ${progressCount.textContent}`);
  }

  function render() {
    const packs = appState.state.packs || [];
    updateProgress();
    // Progress and unrelated state events must never recreate cards or buttons.
    if (packs === renderedPacks) return;
    renderedPacks = packs;
    if (packs.length === 0) {
      listHost.replaceChildren(
        emptyState(
          'no-downloads',
          'Сборок пока нет',
          'Добавьте ссылку на сборку — GitHub-репозиторий, CurseForge или Modrinth — и лаунчер будет держать её файлы актуальными.',
          button('Добавить сборку', { variant: 'primary', onClick: addPack })
        )
      );
      return;
    }
    listHost.replaceChildren(...packs.map(packCard));
  }

  function packCard(pack) {
    const src = pack.source || 'github';
    const ref = src === 'github' ? pack.repo : (pack.slug || pack.id || pack.name);
    const installed = pack.installedVersion || null;

    return el(
      'div',
      { className: 'card pack-card' },
      el(
        'div',
        { className: 'pack-card__head' },
        el('span', { className: 'pack-card__icon' }, icon('archive')),
        el(
          'div',
          { className: 'pack-card__body' },
          el('div', { className: 'pack-card__title' },
            el('span', {}, pack.name),
            installed ? chip('Установлено', 'success') : null
          ),
          el('div', { className: 'pack-card__repo' }, `${SOURCE_LABELS[src] || src} · ${ref}${(pack.version || pack.branch) ? ' · ' + (pack.version || pack.branch) : ''}${pack.subdir ? ' · ' + pack.subdir : ''}`)
        ),
        chip(`${pack.files} файлов`, 'neutral')
      ),
      el(
        'div',
        { className: 'pack-card__foot' },
        el('span', { className: 'muted' }, `Обновлено ${shortDate(pack.syncedAt)}`),
        el('span', { className: 'grow' }),
        button('Моды', { variant: 'secondary', onClick: () => showPackMods(pack) }),
        button('Выбрать версию', { variant: 'secondary', iconName: 'download', onClick: () => showVersionPicker(pack) }),
        button('Играть', {
          variant: 'primary',
          iconName: 'play',
          disabled: !installed,
          onClick: () => playPack(pack),
        }),
        button('Обновить', { variant: 'ghost', iconName: 'sync', onClick: () => sync(pack) }),
        button('Папка', { variant: 'ghost', iconName: 'folder-open', onClick: () => window.moss.system.openFolder(pack.dir) }),
        button('Удалить', { variant: 'ghost', iconName: 'delete', onClick: () => remove(pack) })
      )
    );
  }

  async function showPackMods(pack) {
    const results = el('div', { className: 'pack-mods__list' }, spinner());
    const count = el('p', { className: 'muted pack-mods__count' });
    const search = textInput('', { placeholder: 'Поиск по имени файла мода', onInput: renderMods });
    search.setAttribute('aria-label', 'Поиск модов сборки');
    let mods = [];
    const scrim = modal({
      title: `Моды: ${pack.name}`, wide: true,
      subtitle: 'Файлы из папки mods этой сборки',
      body: el('div', { className: 'col pack-mods' }, search, count, results),
      footer: [button('Закрыть', { variant: 'ghost', onClick: () => scrim.close() })],
      onClose: () => dialogs.delete(scrim),
    });
    dialogs.add(scrim);
    document.body.append(scrim);
    function renderMods() {
      const query = search.value.trim().toLocaleLowerCase();
      const visible = mods.filter(mod => mod.file.toLocaleLowerCase().includes(query));
      count.textContent = `Показано ${visible.length} из ${mods.length} · Включено ${mods.filter(mod => mod.enabled).length}`;
      results.replaceChildren(...(visible.length ? visible.map(mod => el('div', { className: 'pack-mods__item' },
        el('div', { className: 'pack-mods__info' },
          el('div', { className: 'pack-mods__name' }, mod.name),
          el('div', { className: 'muted pack-mods__file' }, mod.file)),
        el('span', { className: 'muted pack-mods__size' }, formatBytes(mod.size)),
        chip(mod.enabled ? 'Включён' : 'Отключён', mod.enabled ? 'success' : 'neutral')))
        : [el('p', { className: 'version-picker__empty' }, mods.length ? 'Моды не найдены по запросу.' : 'В папке сборки нет модов (.jar).')]));
    }
    try {
      mods = await window.moss.packs.mods(pack.name);
      if (!scrim.isConnected || scrim.classList.contains('scrim--leaving')) return;
      renderMods();
      search.focus();
    } catch (error) {
      if (!scrim.isConnected) return;
      results.replaceChildren(el('p', { className: 'field__error' }, `Не удалось прочитать моды: ${error.message}`));
    }
  }

  async function showVersionPicker(pack) {
    const scrim = modal({
      title: `Версии: ${pack.name}`,
      body: el('div', { className: 'version-picker' }, spinner()),
      footer: [button('Закрыть', { variant: 'ghost', onClick: () => scrim.close() })],
      onClose: () => {},
    });
    document.body.append(scrim);

    const source = pack.source || 'github';
    const slug = source === 'github' ? pack.repo : (pack.slug || pack.id || pack.name);

    try {
      const versions = await window.moss.packs.versions(source, slug, { limit: 50 });
      const body = scrim.querySelector('.version-picker');
      if (!versions || versions.length === 0) {
        body.replaceChildren(el('div', { className: 'version-picker__empty' }, 'Версии не найдены.'));
        return;
      }

      const isCurrent = (v) => {
        if (source === 'github') return v.id === (pack.version || 'main');
        if (source === 'curseforge') return String(v.id) === String(pack.fileId);
        return String(v.id) === String(pack.versionId);
      };

      const list = el(
        'div',
        { className: 'version-picker__list' },
        ...versions.map((v) => {
          const meta = [
            ...(v.gameVersions || []).slice(0, 4),
            ...(v.loaders || []).slice(0, 3),
            v.type || null,
            v.uploadedAt ? shortDate(v.uploadedAt) : null,
          ].filter(Boolean).join(' · ');
          const current = isCurrent(v);
          return el(
            'div',
            { className: `version-picker__item${current ? ' is-current' : ''}` },
            el(
              'div',
              { className: 'version-picker__item-info' },
              el('div', { className: 'version-picker__item-name' }, v.name || v.id),
              meta ? el('div', { className: 'version-picker__item-meta' }, meta) : null,
              v.size ? el('div', { className: 'version-picker__item-meta' }, formatBytes(v.size)) : null
            ),
            current
              ? chip('Текущая', 'success')
              : button('Установить', {
                  variant: 'primary',
                  onClick: async () => {
                    scrim.close();
                    await installVersion(pack, v);
                  },
                })
          );
        })
      );

      body.replaceChildren(list);
    } catch (err) {
      const body = scrim.querySelector('.version-picker');
      body.replaceChildren(el('div', { className: 'version-picker__empty' }, `Ошибка: ${err.message}`));
    }
  }

  async function installVersion(pack, version) {
    appState.update({ syncProgress: { stage: 'start', message: `Устанавливаем ${version.name || version.id}…` } });
    const source = pack.source || 'github';
    let input;
    if (source === 'curseforge') {
      input = `cf:${pack.slug || pack.id}/${version.id}`;
    } else if (source === 'modrinth') {
      input = `mr:${pack.slug}/${version.id}`;
    } else {
      input = pack.repo;
    }
    try {
      await window.moss.packs.sync({
        input,
        name: pack.name,
        branch: source === 'github' ? version.id : undefined,
        subdir: pack.subdir || undefined,
      });
      await refreshPacks();
      appState.toast(`Версия ${version.name || version.id} установлена`, 'success');
    } catch (e) {
      appState.toast(e.message, 'error', 'Не удалось установить версию');
    } finally {
      appState.update({ syncProgress: null });
    }
  }

  async function playPack(pack) {
    try {
      await window.moss.packs.play(pack.name);
      appState.toast(`Запуск ${pack.name}…`, 'success');
    } catch (err) {
      appState.toast(err.message, 'error', 'Не удалось запустить');
    }
  }

  async function sync(pack) {
    appState.update({ syncProgress: { stage: 'start', message: `Обновляем ${pack.name}…` } });
    const input = pack.source === 'curseforge' ? `cf:${pack.slug || pack.id}` :
                  pack.source === 'modrinth' ? `mr:${pack.slug}` : pack.repo;
    try {
      await window.moss.packs.sync({ input, name: pack.name });
      await refreshPacks();
      appState.toast(`${pack.name} обновлена`, 'success');
    } catch (e) {
      appState.toast(e.message, 'error', 'Ошибка синхронизации');
    } finally {
      appState.update({ syncProgress: null });
    }
  }

  async function remove(pack) {
    const ok = await confirmDialog({
      title: 'Удалить сборку?',
      message: `Папка modpacks/${pack.name} и все её файлы будут удалены.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await window.moss.packs.remove(pack.name);
    await refreshPacks();
    appState.toast(`${pack.name} удалена`, 'success');
  }

  async function addPack() {
    const sourceSel = selectInput('auto', SOURCES, {});
    const inputField = textInput('', { placeholder: 'Ссылка на сборку или slug' });
    const branchInput = textInput('main', { placeholder: 'main' });
    const subdirInput = textInput('', { placeholder: 'папка внутри репо (только GitHub)' });
    const nameInput = textInput('', { placeholder: 'имя сборки (по умолчанию — из источника)' });
    const error = el('p', { className: 'field__error' });

    const ghExtra = el('div', { className: 'row' }, field('Ветка', branchInput), field('Подпапка', subdirInput));
    const body = el(
      'div',
      { className: 'col' },
      field('Источник', sourceSel),
      field('Ссылка или slug', inputField, 'Примеры: owner/repo · github.com/a/b · curseforge.com/minecraft/modpacks/all-the-mods-10 · modrinth.com/modpack/fabulously-optimized · cf:all-the-mods-10 · mr:fabulously-optimized'),
      ghExtra,
      field('Имя сборки', nameInput),
      error
    );

    sourceSel.addEventListener('change', () => {
      ghExtra.style.display = sourceSel.value === 'github' ? '' : 'none';
    });

    const scrim = modal({
      title: 'Новая сборка',
      body,
      footer: [
        button('Отмена', { variant: 'ghost', onClick: () => scrim.close() }),
        button('Синхронизировать', {
          variant: 'primary',
          iconName: 'sync',
          onClick: async () => {
            const raw = inputField.value.trim();
            if (!raw) { error.textContent = 'Укажите ссылку или slug.'; inputField.focus(); return; }
            const name = nameInput.value.trim();
            scrim.close();
            appState.update({ syncProgress: { stage: 'start', message: `Загружаем ${name || raw}…` } });
            try {
              const res = await window.moss.packs.sync({
                input: raw,
                branch: branchInput.value.trim() || 'main',
                subdir: subdirInput.value.trim(),
                name: name || undefined,
              });
              await refreshPacks();
              appState.toast(`Сборка ${res.packName || name || raw} добавлена`, 'success');
            } catch (e) {
              appState.toast(e.message, 'error', 'Не удалось синхронизировать');
            } finally {
              appState.update({ syncProgress: null });
            }
          },
        }),
      ],
      onClose: () => {},
    });
    document.body.append(scrim);
    setTimeout(() => inputField.focus(), 40);
  }

  render();
  const unsubscribe = appState.subscribe(render);
  return { unmount() {
    unsubscribe();
    for (const dialog of dialogs) dialog.remove();
    dialogs.clear();
  } };
}
