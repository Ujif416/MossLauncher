/**
 * versions.js — каталог версий Minecraft.
 *
 * Две вкладки: «Установленные» (управление) и «Каталог» (поиск по манифесту
 * Mojang с фильтром по типу и загрузчику). Установка идёт с прогрессом,
 * который прилетает событием appState.downloads.
 */

import { el, icon, parseVersionId, LOADER_LABELS, compareVersions, debounce } from '../ui-utils.js';
import { button, chip, emptyState, progressBar, searchBox, segmented, selectInput, spinner, modal } from '../ui/components.js';
import { confirmDialog } from '../ui/dialogs.js';
import { appState, refreshEnvironment, selectVersion } from '../app-state.js';

const LOADERS = [
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
];

const TYPES = [
  { value: 'release', label: 'Релизы' },
  { value: 'snapshot', label: 'Снапшоты' },
];

let cache = { all: [], at: 0 };
let tab = 'installed';
let filters = { type: 'type:release', loader: 'vanilla', query: '' };

export function versionsView(container) {
  const tabsSlot = el('div', { className: 'tabs' });
  const body = el('div', { className: 'versions__body' });

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
          el('h1', { className: 'page-head__title' }, 'Версии'),
          el('p', { className: 'page-head__sub' }, 'Устанавливайте релизы, снапшоты и сборки с загрузчиками модов')
        ),
        el('div', { className: 'page-head__actions' }, button('Обновить каталог', { variant: 'secondary', iconName: 'check-updates', onClick: () => loadCatalog(true) }))
      ),
      tabsSlot,
      body
    )
  );

  let currentTab = null;
  let downloadsWereActive = false;

  const render = () => {
    const state = appState.state;

    // Обновляем подпись вкладки при изменении числа установленных версий.
    tabsSlot.replaceChildren(
      segmented(
        [
          { value: 'installed', label: `Установленные (${state.installedVersions.length})` },
          { value: 'catalog', label: 'Каталог' },
        ],
        tab,
        (value) => {
          if (tab !== value) {
            tab = value;
            render();
          }
        }
      )
    );

    const pane = tab === 'installed' ? installedPane(state) : catalogPane();
    body.replaceChildren(pane);

    // Первая инициализация: перерисовываем, когда установка завершилась.
    const downloading = state.downloads.some((d) => d.scope === 'version' && d.stage !== 'done');
    if (downloading) downloadsWereActive = true;
    else if (downloadsWereActive) {
      downloadsWereActive = false;
      if (tab === 'catalog' && catalogPane.render) catalogPane.render();
    }
  };

  render();
  const unsubscribe = appState.subscribe(render);
  loadCatalog(); // подгреваем кэш в фоне
  return { unmount: unsubscribe };
}

// ------------------------------------------------------------------ installed

function installedPane(state) {
  const ids = state.installedVersions.slice().sort((a, b) => {
    const pa = parseVersionId(a);
    const pb = parseVersionId(b);
    return compareVersions(pb.mcVersion, pa.mcVersion) || pa.loader.localeCompare(pb.loader);
  });

  if (ids.length === 0) {
    return emptyState(
      'no-instances',
      'Ни одной версии не установлено',
      'Откройте вкладку «Каталог» и установите нужный релиз или сборку с загрузчиком.',
      button('Перейти в каталог', {
        variant: 'primary',
        onClick: () => {
          tab = 'catalog';
          appState.update({});
        },
      })
    );
  }

  return el('div', { className: 'grid-cards' }, ...ids.map(installedCard));
}

function installedCard(id) {
  const state = appState.state;
  const { loader, mcVersion } = parseVersionId(id);
  const selected = state.selectedVersionId === id;
  const running = state.runningVersions.includes(id);
  const job = state.downloads.find((d) => d.scope === 'version' && d.versionId === id && d.stage !== 'done');

  const actions = el('div', { className: 'card__actions' });

  if (job) {
    const total = job.total || 0;
    const percent = total ? Math.round(((job.done || 0) / total) * 100) : 0;
    actions.append(progressBar(percent, !total));
  } else if (running) {
    actions.append(
      button('Остановить', {
        variant: 'danger',
        iconName: 'stop',
        onClick: () => window.moss.game.stop(id).then(() => appState.toast('Игра остановлена')),
      })
    );
  } else {
    actions.append(
      button(selected ? 'Играть' : 'Выбрать', {
        variant: selected ? 'primary' : 'secondary',
        iconName: selected ? 'play' : 'check',
        onClick: async () => {
          if (!selected) return selectVersion(id).then(() => appState.toast(`Активная версия: ${id}`, 'success'));
          try {
            await window.moss.game.launch({ versionId: id });
          } catch (e) {
            appState.toast(e.message, 'error', 'Не удалось запустить');
          }
        },
      }),
      button('Папка', { variant: 'ghost', iconName: 'folder-open', onClick: () => window.moss.system.openFolder(`${state.settings.gameDir}/instances/${id}`) }),
      button('Удалить', {
        variant: 'ghost',
        iconName: 'delete',
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Удалить версию?',
            message: `Файлы версии ${id} будут удалены с диска. Моды этой версии останутся в папке mods.`,
            confirmLabel: 'Удалить',
            danger: true,
          });
          if (!ok) return;
          await window.moss.versions.remove(id);
          await refreshEnvironment();
          appState.toast(`Версия ${id} удалена`, 'success');
        },
      })
    );
  }

  return el(
    'div',
    { className: `card card--hover version-card${selected ? ' is-active' : ''}` },
    el(
      'div',
      { className: 'version-card__head' },
      el('span', { className: 'version-card__badge' }, icon('instances')),
      el(
        'div',
        { className: 'grow' },
        el('div', { className: 'version-card__title' }, mcVersion || id),
        el('div', { className: 'version-card__meta' }, id)
      ),
      selected ? chip('активная') : null,
      running ? chip('запущена', 'danger') : null
    ),
    el('div', { className: 'chips' }, chip(LOADER_LABELS[loader] || loader, 'neutral')),
    actions
  );
}

// ------------------------------------------------------------------ catalog

function catalogPane() {
  const listHost = el('div', { className: 'grid-cards' });

  const typeBar = el('div');
  const loaderHost = el('div');
  const searchHost = el('div', { className: 'versions__search' });
  const search = searchBox(filters.query, 'Поиск по номеру версии, например 1.21', debounce((e) => {
    filters.query = e.target.value.trim().toLowerCase();
    renderList();
  }, 200));

  function renderToolbar() {
    typeBar.replaceChildren(
      segmented(TYPES, filters.type, (value) => {
        filters.type = value;
        renderToolbar();
        renderList();
      })
    );
    loaderHost.replaceChildren(
      selectInput(filters.loader, LOADERS, {
        onChange: (e) => {
          filters.loader = e.target.value;
          renderList();
        },
      })
    );
  }

  function renderList() {
    if (cache.all.length === 0) {
      listHost.replaceChildren(el('div', { className: 'center-block' }, spinner(), el('p', { className: 'muted' }, 'Загружаем каталог Mojang…')));
      return;
    }

    const type = filters.type.replace('type:', '');
    let items = cache.all.filter((v) => v.type === type);
    if (filters.query) items = items.filter((v) => v.id.toLowerCase().includes(filters.query));

    if (items.length === 0) {
      listHost.replaceChildren(emptyState('no-results', 'Ничего не найдено', 'Измените тип версии или строку поиска.'));
      return;
    }

    const installed = new Set(appState.state.installedVersions);
    listHost.replaceChildren(...items.slice(0, 60).map((v) => catalogCard(v, installed)));
  }

  searchHost.append(search);
  renderToolbar();

  const pane = el(
    'div',
    {},
    el('div', { className: 'row row--between versions__toolbar' }, typeBar, el('div', { className: 'row' }, loaderHost, searchHost)),
    listHost
  );

  catalogPane.render = renderList;
  renderList();
  return pane;
}

function catalogCard(version, installed) {
  const loader = filters.loader;
  const isInstalled = loader === 'vanilla' && installed.has(version.id);
  const job = appState.state.downloads.find((d) => d.scope === 'version' && d.versionId === version.id && d.stage !== 'done');

  const action = el('div', { className: 'card__actions' });
  if (job) {
    const total = job.total || 0;
    action.append(progressBar(total ? Math.round(((job.done || 0) / total) * 100) : 0, !total));
  } else if (isInstalled) {
    action.append(chip('установлено'), button('Выбрать', { variant: 'secondary', onClick: () => selectVersion(version.id).then(() => appState.toast(`Активная версия: ${version.id}`, 'success')) }));
  } else {
    action.append(
      button('Установить', {
        variant: 'primary',
        iconName: 'download',
        title: loader === 'vanilla' ? '' : `Сборка ${LOADER_LABELS[loader]}`,
        onClick: () => install(version.id, loader),
      })
    );
  }

  return el(
    'div',
    { className: 'card card--hover version-card' },
    el(
      'div',
      { className: 'version-card__head' },
      el(
        'div',
        { className: 'grow' },
        el('div', { className: 'version-card__title' }, version.id),
        el('div', { className: 'version-card__meta' }, new Date(version.releaseTime).toLocaleDateString('ru-RU'))
      ),
      version.type === 'snapshot' ? chip('снапшот', 'neutral') : chip('релиз')
    ),
    loader !== 'vanilla' ? el('div', { className: 'chips' }, chip(LOADER_LABELS[loader], 'neutral')) : null,
    action
  );
}

async function install(id, loader) {
  try {
    let loaderVersion;
    if (loader !== 'vanilla') {
      const versions = await window.moss.versions.loaders(loader, id);
      if (!versions.length) throw new Error('Нет совместимых версий загрузчика');
      loaderVersion = await new Promise(resolve => {
        const select = selectInput(versions[0], versions.map(v => ({ value: v, label: v })));
        const dialog = modal({ title: `${LOADER_LABELS[loader]} · Minecraft ${id}`, subtitle: 'Выберите версию загрузчика', body: select,
          onClose: () => resolve(null), footer: button('Установить', { variant: 'primary', onClick: () => { resolve(select.value); dialog.close(); } }) });
        document.body.append(dialog);
      });
      if (!loaderVersion) return;
    }
    const installed = await window.moss.versions.install({ id, loader, loaderVersion });
    await refreshEnvironment();
    await selectVersion(installed.id);
  } catch (e) {
    appState.toast(e.message, 'error', 'Ошибка установки');
  } finally {
    appState.update({ downloads: appState.state.downloads.filter(d => d.versionId !== id) });
  }
}

/** Каталог кэшируется на 10 минут, чтобы вкладки переключались мгновенно. */
export async function loadCatalog(force = false) {
  if (!force && cache.all.length && Date.now() - cache.at < 600000) return cache.all;
  try {
    const versions = await window.moss.versions.list({ releasesOnly: false });
    cache = { all: versions, at: Date.now() };
  } catch (e) {
    appState.toast(e.message, 'error', 'Не удалось получить список версий');
  }
  appState.update({});
  return cache.all;
}
