/**
 * mods.js — поиск и управление модами.
 *
 * Левая колонка — поиск (Modrinth + CurseForge), правая — установленные
 * моды текущей версии с переключением и удалением.
 */

import { el, icon, formatNumber, parseVersionId, shortDate, formatBytes } from '../ui-utils.js';
import { button, chip, emptyState, selectInput, searchBox, spinner, toggle, modal, panel } from '../ui/components.js';
import { confirmDialog } from '../ui/dialogs.js';
import { appState, refreshMods, selectVersion } from '../app-state.js';

const SEARCH_LOADERS = [
  { value: '', label: 'Любой загрузчик' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'neoforge', label: 'NeoForge' },
];

let searching = false;
let searchError = null;
let results = [];

export function modsView(container) {
  const state = appState.state;
  const versionId = state.selectedVersionId;

  const searchSlot = el('div');
  const installedSlot = el('div');
  const targetSlot = el('div', { className: 'mods__target panel' });

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
          el('h1', { className: 'page-head__title' }, 'Моды'),
          el('p', { className: 'page-head__sub' }, 'Моды устанавливаются только в выбранную ниже версию')
        ),
        el(
          'div',
          { className: 'page-head__actions' },
          button('Обновить список', { variant: 'secondary', iconName: 'check-updates', onClick: () => refreshMods().then(() => appState.update({})) })
        )
      ),
      targetSlot,
      el('div', { className: 'mods__split' }, el('div', {}, searchSlot), el('div', {}, installedSlot))
    )
  );

  let disposeSearch = () => {};
  let searchVersion = null;
  let targetKey = '';
  const render = () => {
    const s = appState.state;
    const key = JSON.stringify([s.selectedVersionId, s.installedVersions, s.settings.gameDir]);
    if (key !== targetKey) {
      targetKey = key;
      const id = s.selectedVersionId;
      const options = s.installedVersions.map(value => ({ value, label: value }));
      if (!options.some(o => o.value === id)) options.unshift({ value: id || '', label: id ? `${id} — не установлена` : 'Выберите установленную версию' });
      targetSlot.replaceChildren(
        el('label', {}, 'Устанавливать моды в:', selectInput(id || '', options, { onChange: e => selectVersion(e.target.value) })),
        el('p', { className: 'muted mods__target-path' }, id ? `Папка модов: ${s.settings.gameDir}\\mods\\${id}` : 'Сначала установите версию с загрузчиком модов.'),
        el('p', { className: 'muted' }, id && parseVersionId(id).loader === 'vanilla' ? 'Обычный Minecraft не поддерживает моды. Выберите Fabric, Forge, Quilt или NeoForge.' : 'При запуске эти моды копируются в отдельную игровую папку выбранной версии.')
      );
    }
    if (searchVersion !== appState.state.selectedVersionId) {
      disposeSearch();
      const pane = searchPane();
      disposeSearch = pane.dispose;
      searchSlot.replaceChildren(pane);
      searchVersion = appState.state.selectedVersionId;
    }
    installedSlot.replaceChildren(installedPane());
  };

  render();
  const unsubscribe = appState.subscribe(render);
  return { unmount() { unsubscribe(); disposeSearch(); } };
}

// ------------------------------------------------------------------ search

function searchPane() {
  const state = appState.state;
  const versionId = state.selectedVersionId;
  const { mcVersion } = parseVersionId(versionId);

  const filters = { loader: parseVersionId(versionId).loader === 'vanilla' ? '' : parseVersionId(versionId).loader };
  let page = 0, total = 0, query = '', source = 'modrinth', serial = 0, disposed = false, timer;
  const limit = 20;
  let hits = [];
  let cfNeedsKey = false;
  const resultsHost = el('div', { className: 'mods__results' });
  const pager = el('div', { className: 'row row--between', style: { marginTop: '16px' } });
  const notice = el('p', { className: 'muted' });
  const cfLinkHost = el('div', { className: 'panel', style: { display: 'none' } });

  async function run() {
    const ticket = ++serial;
    resultsHost.replaceChildren(spinnerRow());
    pager.replaceChildren();
    try {
      const res = await window.moss.mods.search({ source, query, version: mcVersion, loader: filters.loader, limit, offset: page * limit });
      if (disposed || ticket !== serial) return;
      const data = res[source];
      if (data.error) throw new Error(data.error);
      hits = data.hits || []; total = data.total || 0;
      cfNeedsKey = !!data.needsKey;
      notice.textContent = cfNeedsKey
        ? 'Поиск на CurseForge требует API-ключ (или вставьте ссылку на мод ниже).'
        : `${mcVersion || 'Все версии Minecraft'} · найдено ${total}`;
      cfLinkHost.style.display = cfNeedsKey ? '' : 'none';
      resultsHost.replaceChildren(...resultRows());
      pager.replaceChildren(
        button('Назад', { disabled: page === 0, onClick: () => { page--; run(); } }),
        el('span', {}, `Страница ${page + 1} из ${Math.max(1, Math.ceil(total / limit))}`),
        button('Далее', { disabled: (page + 1) * limit >= total, onClick: () => { page++; run(); } })
      );
    } catch (error) {
      if (disposed || ticket !== serial) return;
      resultsHost.replaceChildren(el('p', { className: 'field__error' }, error.message), button('Повторить', { onClick: run }));
    }
  }

  const reset = () => { page = 0; clearTimeout(timer); run(); };
  const queryBox = searchBox('', 'Название мода…', (event) => {
    query = event.target.value.trim(); page = 0; serial++;
    clearTimeout(timer); timer = setTimeout(run, 350);
  });
  const loaderSel = selectInput(filters.loader, SEARCH_LOADERS, { onChange: event => { filters.loader = event.target.value; reset(); } });
  const sourceSel = selectInput(source, [{ value: 'modrinth', label: 'Modrinth' }, { value: 'curseforge', label: 'CurseForge' }], { onChange: event => { source = event.target.value; reset(); } });

  // Панель вставки ссылки CurseForge (без ключа)
  const cfInput = searchBox('', 'curseforge.com/minecraft/mc-mods/<slug> или slug', () => {});
  const cfBtn = button('Найти', { variant: 'primary', iconName: 'search' });
  const cfResult = el('div');
  cfLinkHost.append(
    el('p', { className: 'muted', style: { marginTop: 0 } }, 'Вставьте ссылку на мод с CurseForge — установим без API-ключа.'),
    el('div', { className: 'row' }, cfInput, cfBtn),
    cfResult
  );
  async function resolveCf() {
    const v = cfInput.querySelector('input').value.trim();
    if (!v) return;
    cfResult.replaceChildren(spinnerRow());
    try {
      const project = await window.moss.mods.resolveCf(v);
      cfResult.replaceChildren(projectCard(project));
    } catch (e) {
      cfResult.replaceChildren(el('p', { className: 'field__error' }, e.message));
    }
  }
  cfBtn.addEventListener('click', resolveCf);
  cfInput.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveCf(); });

  const pane = el('div', { className: 'col' }, queryBox, el('div', { className: 'row' }, sourceSel, loaderSel), notice, cfLinkHost, resultsHost, pager);
  pane.dispose = () => { disposed = true; serial++; clearTimeout(timer); };

  function resultRows() {
    if (!hits.length) return [emptyState('no-results', 'Ничего не найдено', 'Попробуйте другое название или снимите фильтр загрузчика.')];
    return hits.map(hit => projectCard(hit));
  }

  /** Карточка проекта: иконка, название, описание, автор, загрузки, статус установки, действия. */
  function projectCard(p) {
    const installed = state.mods.find(m => (m.source === p.source && String(m.id) === String(p.id)));
    const canInstall = state.installedVersions.includes(versionId) && parseVersionId(versionId).loader !== 'vanilla';
    return el('div', { className: 'mod-card' },
      el('div', { className: 'mod-card__head' },
        el('div', { className: 'mod-card__icon' },
          p.icon ? el('img', { src: p.icon, alt: '' }) : icon('mods')
        ),
        el('div', { className: 'mod-card__info' },
          el('div', { className: 'mod-card__title' },
            el('span', {}, p.name),
            installed ? chip('Установлен', 'success') : null
          ),
          el('div', { className: 'mod-card__meta' },
            icon('download'), el('span', {}, formatNumber(p.downloads)),
            icon('account'), el('span', {}, p.author || '—')
          )
        )
      ),
      el('p', { className: 'mod-card__desc' }, (p.description || '').split('\n')[0].slice(0, 220)),
      el('div', { className: 'mod-card__actions' },
        el('div', { className: 'mod-card__source' }, chip(p.source === 'modrinth' ? 'Modrinth' : 'CurseForge', 'neutral')),
        el('div', { className: 'mod-card__buttons' },
          button('Версии', {
            variant: 'secondary', iconName: 'list',
            disabled: !canInstall,
            onClick: () => openVersionPicker(p, filters.loader, mcVersion, versionId),
          }),
          button(installed ? 'Обновить' : 'Установить', {
            variant: installed ? 'secondary' : 'primary', iconName: installed ? 'update' : 'download',
            disabled: !canInstall,
            onClick: async () => {
              try {
                await window.moss.mods.install({ source: p.source, projectId: p.id, loader: filters.loader, mcVersion, versionId });
                await refreshMods();
                appState.toast(`Установлен ${p.name}`, 'success');
              } catch (err) {
                appState.toast(err.message, 'error', 'Не удалось установить мод');
              }
            },
          })
        )
      )
    );
  }

  run();
  return pane;
}

/** Диалог выбора конкретной версии файла перед установкой. */
function openVersionPicker(project, loader, mcVersion, versionId) {
  const state = appState.state;
  let files = project.files || [];
  let filterVersion = mcVersion;
  let filterType = 'release';
  let loading = false;

  const content = el('div', { className: 'version-picker' });
  const scrim = modal({
    title: `Версии файлов — ${project.name}`,
    body: content,
    footer: button('Закрыть', { variant: 'ghost', onClick: () => scrim.close() }),
    onClose: () => document.body.removeChild(scrim),
  });

  async function load() {
    if (project.source === 'modrinth') {
      loading = true;
      render();
      try {
        const versions = await window.moss.mods.getVersions(project.source, project.id, { loader, version: mcVersion });
        files = versions.flatMap(v => v.files.map(f => ({
          id: f.id, name: f.filename, size: f.size, sha1: f.hashes && f.hashes.sha1,
          versionId: v.id, versionNumber: v.version_number, gameVersions: v.game_versions,
          loaders: v.loaders, type: v.version_type, datePublished: v.date_published,
          primary: f.primary, url: f.url,
        })));
      } catch (err) {
        content.replaceChildren(el('p', { className: 'field__error' }, err.message));
        return;
      } finally {
        loading = false;
      }
    }
    // CurseForge files уже в project.files
    render();
  }

  function render() {
    if (loading) {
      content.replaceChildren(spinner(), el('p', { className: 'muted' }, 'Загрузка версий…'));
      return;
    }
    const filtered = files.filter(f => {
      const okV = !filterVersion || (f.gameVersions || f.versions || []).includes(filterVersion);
      const okT = !filterType || (f.type || 'release') === filterType;
      return okV && okT;
    });
    if (!filtered.length) {
      content.replaceChildren(emptyState('no-results', 'Нет подходящих файлов', 'Попробуйте изменить фильтры.'));
      return;
    }
    content.replaceChildren(
      el('div', { className: 'row', style: { marginBottom: '12px' } },
        selectInput(filterVersion, [{ value: '', label: 'Все версии MC' }, { value: mcVersion, label: mcVersion }], {
          onChange: e => { filterVersion = e.target.value; render(); },
        }),
        selectInput(filterType, [{ value: '', label: 'Все типы' }, { value: 'release', label: 'Release' }, { value: 'beta', label: 'Beta' }, { value: 'alpha', label: 'Alpha' }], {
          onChange: e => { filterType = e.target.value; render(); },
        })
      ),
      el('div', { className: 'version-picker__list' },
        ...filtered.slice(0, 50).map(f => el('div', { className: 'version-picker__item' },
          el('div', { className: 'version-picker__item-info' },
            el('div', { className: 'version-picker__item-name' }, f.name),
            el('div', { className: 'version-picker__item-meta' },
              f.versionNumber || f.display || '',
              ' · ',
              formatBytes(f.size || f.filesize || 0),
              f.type ? ` · ${f.type}` : '',
              f.datePublished || f.uploaded_at ? ` · ${shortDate(f.datePublished || f.uploaded_at)}` : ''
            )
          ),
          button('Установить', {
            variant: 'primary', iconName: 'download',
            onClick: async () => {
              scrim.close();
              try {
                // Установка напрямую через конкретный файл (нужна поддержка в main)
                await window.moss.mods.installFile({ source: project.source, projectId: project.id, file: f, loader, mcVersion, versionId });
                await refreshMods();
                appState.toast(`Установлен ${project.name}`, 'success');
              } catch (err) {
                appState.toast(err.message, 'error', 'Не удалось установить мод');
              }
            },
          })
        ))
      )
    );
  }

  load();
  document.body.append(scrim);
}

function spinnerRow() {
  return el('div', { className: 'center-block' }, spinner(), el('p', { className: 'muted' }, 'Ищем моды…'));
}

// ------------------------------------------------------------------ installed

function installedPane() {
  const state = appState.state;
  const versionId = state.selectedVersionId;
  const mods = state.mods || [];

  if (!versionId) {
    return el('div', { className: 'panel' }, el('p', { className: 'muted' }, 'Сначала выберите версию.'));
  }

  const head = el(
    'div',
    { className: 'row row--between' },
    el('h3', {}, 'Установленные'),
    el('div', { className: 'row', style: { gap: 'var(--s-3)', alignItems: 'center' } },
      el('span', { className: 'muted' }, `${mods.filter((m) => m.enabled).length} активных`),
      button('', {
        variant: 'ghost',
        iconName: 'check-updates',
        title: 'Проверить обновления',
        onClick: async () => {
          try {
            const updates = await window.moss.mods.checkUpdates(versionId);
            if (!updates || updates.length === 0) {
              appState.toast('Все моды актуальны', 'success');
            } else {
              appState.toast(`${updates.length} обновлений доступно`, 'info');
              appState.update({ modUpdates: updates });
            }
          } catch (err) {
            appState.toast(err.message, 'error', 'Ошибка проверки обновлений');
          }
        },
      })
    )
  );

  if (mods.length === 0) {
    return el('div', {}, head, emptyState('no-downloads', 'Пока пусто', 'Найденные моды появятся здесь после установки.'));
  }

  const updates = state.modUpdates || [];
  const list = el(
    'div',
    { className: 'col' },
    ...mods.map((m) => {
      const hasUpdate = updates.find(u => u.file === m.file);
      return el(
        'div',
        { className: `row-line${m.enabled ? '' : ' is-off'}` },
        el('span', { className: 'row-line__icon' }, icon('mods')),
        el(
          'div',
          { className: 'row-line__body' },
          el('div', { className: 'row-line__title' },
            el('span', {}, m.name || m.file),
            hasUpdate ? chip('Обновление', 'warning') : null
          ),
          el('div', { className: 'row-line__meta' }, `${m.source === 'local' ? 'Локальный' : m.source} · ${m.versionNumber || m.versionId || ''}`)
        ),
        el(
          'div',
          { className: 'row-line__actions' },
          toggle(m.enabled, async (enabled) => {
            try {
              const next = await window.moss.mods.toggle({ versionId, file: m.file, enabled });
              appState.update({ mods: next });
            } catch (err) {
              appState.toast(err.message, 'error');
            }
          }),
          button('', {
            variant: 'ghost',
            iconName: 'delete',
            title: 'Удалить',
            onClick: async () => {
              const ok = await confirmDialog({ title: 'Удалить мод?', message: m.name || m.file, confirmLabel: 'Удалить', danger: true });
              if (!ok) return;
              const next = await window.moss.mods.remove({ versionId, file: m.file });
              appState.update({ mods: next });
            },
          })
        )
      );
    })
  );

  return el('div', {}, head, list);
}
