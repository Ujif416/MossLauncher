/**
 * home.js — главный экран.
 *
 * Hero-панель с лесным фоном, крупной кнопкой запуска и выбором версии,
 * справа — быстрые переходы к модам и сборкам, сверху — активный аккаунт.
 */

import { el, icon, asset } from '../ui-utils.js';
import { button, progressBar, spinner, statusDot } from '../ui/components.js';
import { appState, selectVersion } from '../app-state.js';
import { accountHead } from '../account-head.js';
import { greetingService } from '../greetings.js';

const STAGE_LABELS = {
  loader: 'Установка загрузчика',
  manifest: 'Получение манифеста',
  libraries: 'Библиотеки',
  natives: 'Распаковка natives',
  assetindex: 'Индекс ассетов',
  assets: 'Ресурсы игры',
  done: 'Готово',
  download: 'Скачивание',
  extract: 'Распаковка',
};

export function homeView(container) {
  const keys = {};
  let disposePicker = () => {};
  function changed(name, value) {
    const key = JSON.stringify(value);
    if (keys[name] === key) return false;
    keys[name] = key;
    return true;
  }

  const art = el('div', { className: 'home__art' }, el('img', { src: asset('backgrounds', 'forest-mist.png'), alt: '' }));
  const eyebrow = el('div', { className: 'home__eyebrow' }, 'MossLauncher');
  const title = el('h1', { className: 'home__title home__greeting-title' });
  const subtitle = el('p', { className: 'home__subtitle home__greeting-description' });
  const unsubscribeGreeting = greetingService.subscribe(g => {
    title.textContent = g.title;
    subtitle.textContent = g.description;
  });

  const playSlot = el('div', { className: 'home__play' });
  const versionSlot = el('div', { className: 'home__version' });
  const progressSlot = el('div', { className: 'home__progress-wrap' });

  const side = el('div', { className: 'home__side' });
  const topline = el('div', { className: 'home__topline' });

  container.append(
    el(
      'div',
      { className: 'home' },
      art,
      el('div', { className: 'home__lead' }, eyebrow, el('div', { className: 'home__greeting' }, title, subtitle), el('div', { className: 'home__actions' }, playSlot, versionSlot, progressSlot)),
      side,
      topline
    )
  );

  function render() {
    const s = appState.state;
    if (changed('account', [s.accounts, s.selectedAccount])) renderAccount(topline, s);
    if (changed('play', [s.selectedVersionId, s.runningVersions, s.selectedAccount, s.installedVersions, s.downloads.some(d => d.scope === 'version' && d.stage !== 'done'), s.gameState])) renderPlay(playSlot, s);
    if (changed('picker', [s.selectedVersionId, s.installedVersions])) {
      disposePicker();
      disposePicker = renderVersionPicker(versionSlot, s);
    }
    renderProgress(progressSlot, s);
    if (changed('side', [s.selectedVersionId, s.mods.length, s.packs.length, s.settings.maxRamMb])) renderSide(side, s);
  }

  render();
  const unsubscribe = appState.subscribe(render);

  return {
    unmount() {
      unsubscribe();
      unsubscribeGreeting();
      disposePicker();
    },
  };
}

function renderAccount(host, s) {
  const account = s.accounts.find((a) => a.uuid === s.selectedAccount);
  if (!account) {
    host.replaceChildren(
      button('Войти в аккаунт', {
        variant: 'secondary',
        iconName: 'login',
        className: 'btn--sm',
        onClick: () => appState.navigateTo('accounts'),
      })
    );
    return;
  }

  const avatar = accountHead(account);

  host.replaceChildren(
    el(
      'button',
      { className: 'account-chip', type: 'button', onClick: () => appState.navigateTo('accounts') },
      el('span', { className: 'account-chip__avatar' }, avatar),
      el(
        'span',
        { className: 'account-chip__body' },
        el('span', { className: 'account-chip__name' }, account.username),
        el('span', { className: 'account-chip__type' }, account.type === 'microsoft' ? 'Microsoft' : 'Офлайн')
      ),
      statusDot('online')
    )
  );
}

function renderPlay(host, s) {
  const versionId = s.selectedVersionId;
  const running = s.runningVersions.includes(versionId);
  const hasAccount = Boolean(s.selectedAccount);
  const installed = s.installedVersions.includes(versionId);
  const busy = s.downloads.some((d) => d.scope === 'version' && d.stage !== 'done');

  if (running) {
    host.replaceChildren(
      el(
        'button',
        {
          className: 'play play--stop',
          type: 'button',
          onClick: () => window.moss.game.stop(versionId).then(() => appState.toast('Игра остановлена')),
        },
        icon('stop'),
        el('span', { className: 'play__label' }, 'Остановить игру'),
        el('span', { className: 'play__meta' }, versionId)
      )
    );
    return;
  }

  const disabled = !versionId || busy;
  let label = 'Играть';
  let meta = versionId || 'Выберите версию';

  if (!hasAccount) {
    label = 'Нужен аккаунт';
    meta = 'Добавьте его на вкладке «Аккаунты»';
  } else if (!versionId) {
    label = 'Выберите версию';
    meta = 'Список версий — слева';
  } else if (!installed) {
    label = 'Установить и играть';
    meta = 'Файлы версии будут скачаны';
  }

  host.replaceChildren(
    el(
      'button',
      {
        className: 'play',
        type: 'button',
        disabled: busy,
        onClick: async (e) => {
          if (!hasAccount) {
            appState.navigateTo('accounts');
            return;
          }
          if (!versionId) { appState.navigateTo('versions'); return; }
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.replaceChildren(spinner(), el('span', { className: 'play__label' }, 'Запуск…'));
          try {
            if (!s.installedVersions.includes(versionId)) {
              appState.toast('Сначала установим версию…', 'info');
              await window.moss.versions.install({ id: versionId });
            }
            await window.moss.game.launch({ versionId });
          } catch (err) {
            appState.toast(err.message, 'error', 'Не удалось запустить');
            appState.update({ downloads: [] });
          } finally {
            await refreshInstalled().catch(() => {});
            if (host.isConnected) renderPlay(host, appState.state);
          }
        },
      },
      icon('play'),
      el('span', { className: 'play__label' }, label),
      el('span', { className: 'play__meta' }, meta)
    )
  );
}

function renderVersionPicker(host, s) {
  const installed = s.installedVersions;
  const current = s.selectedVersionId;

  let cleanup = () => {};
  const open = (e) => {
    cleanup();
    const btn = e.currentTarget;
    const menu = buildVersionMenu(host, s, installed);
    const rect = btn.getBoundingClientRect();
    menu.classList.add('version-menu');
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const down = below >= Math.min(300, above);
    Object.assign(menu.style, { position: 'fixed', left: `${rect.left}px`, width: `${rect.width}px`,
      top: down ? `${rect.bottom + 6}px` : 'auto', bottom: down ? 'auto' : `${window.innerHeight - rect.top + 6}px`,
      maxHeight: `${Math.max(80, Math.min(360, down ? below : above))}px` });
    const close = (ev) => {
      if (menu.contains(ev.target) || btn.contains(ev.target)) return;
      cleanup();
    };
    const onKey = ev => { if (ev.key === 'Escape') { cleanup(); btn.focus(); } };
    const onScroll = ev => { if (!menu.contains(ev.target)) cleanup(); };
    cleanup = () => {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', cleanup);
    };
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', cleanup);
    menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => cleanup()));
    document.body.append(menu);
  };

  host.replaceChildren(
    el(
      'button',
      { className: 'version-pick', type: 'button', onClick: open, title: 'Выбрать версию' },
      el('span', { className: 'version-pick__icon' }, icon('instances')),
      el(
        'span',
        { className: 'version-pick__body' },
        el('span', { className: 'version-pick__name' }, current || 'Версия не выбрана'),
        el('span', { className: 'version-pick__meta' }, installed.length ? `Установлено: ${installed.length}` : 'Нет установленных версий')
      ),
      el('span', { className: 'version-pick__chev' }, icon('chevron-down'))
    )
  );
  return () => cleanup();
}

function buildVersionMenu(host, s, installed) {
  const menu = el('div', { className: 'popmenu popmenu--up' });

  if (!installed.length) {
    menu.append(
      el('div', { className: 'popmenu__empty' }, 'Пока ничего не установлено'),
      el(
        'button',
        {
          className: 'popmenu__item popmenu__item--action',
          type: 'button',
          onClick: () => appState.navigateTo('versions'),
        },
        icon('download'),
        'Установить версию'
      )
    );
    return menu;
  }

  const sorted = installed.slice().sort(compareVersions).reverse();
  sorted.forEach((id) => {
    menu.append(
      el(
        'button',
        {
          className: `popmenu__item${id === s.selectedVersionId ? ' is-active' : ''}`,
          type: 'button',
          onClick: async () => {
            await selectVersion(id);
          },
        },
        icon('instances'),
        el('span', { className: 'grow ellipsis' }, id),
        id === s.selectedVersionId ? icon('check') : null
      )
    );
  });

  menu.append(
    el('div', { className: 'popmenu__sep' }),
    el(
      'button',
      { className: 'popmenu__item popmenu__item--action', type: 'button', onClick: () => appState.navigateTo('versions') },
      icon('plus'),
      'Другие версии'
    )
  );
  return menu;
}

function renderProgress(host, s) {
  const job = s.downloads.find((d) => d.stage !== 'done');
  if (!job) {
    host.replaceChildren();
    return;
  }

  const label = STAGE_LABELS[job.stage] || job.stage;
  const total = job.total || 0;
  const done = job.done || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  if (!host.firstChild) host.append(el('div', { className: 'home__progress' },
    el('div', { className: 'home__progress-label' }, el('span'), el('span')), progressBar(0)));
  const labels = host.querySelectorAll('.home__progress-label span');
  labels[0].textContent = label;
  labels[1].textContent = total ? `${done} / ${total}` : '…';
  host.querySelector('.progress').classList.toggle('progress--indeterminate', total === 0);
  host.querySelector('.progress__fill').style.width = `${percent}%`;
}

function renderSide(host, s) {
  const versionId = s.selectedVersionId;
  const modCount = s.mods.length;
  const packCount = s.packs.length;

  host.replaceChildren(
    quickCard('mods', 'Моды', versionId ? `${modCount} установлено · ${versionId}` : 'Выберите версию', () => appState.navigateTo('mods')),
    quickCard('archive', 'Сборки из GitHub', packCount ? `${packCount} синхронизировано` : 'Ещё не настроены', () => appState.navigateTo('modpacks')),
    quickCard('java', 'Java и память', describeRam(s.settings), () => appState.navigateTo('settings'))
  );
}

function quickCard(iconName, title, meta, onClick) {
  return el(
    'button',
    { className: 'home__card', type: 'button', onClick },
    el('span', { className: 'home__card__icon' }, icon(iconName)),
    el(
      'span',
      { className: 'home__card__body' },
      el('span', { className: 'home__card__title' }, title),
      el('span', { className: 'home__card__meta' }, meta)
    ),
    el('span', { className: 'home__card__chev' }, icon('chevron-right'))
  );
}

export function describeRam(settings) {
  const max = Number(settings.maxRamMb) || 4096;
  return `${Math.round(max / 1024 * 10) / 10} ГБ памяти`;
}

async function refreshInstalled() {
  const installed = await window.moss.versions.installed();
  appState.update({ installedVersions: installed, downloads: [] });
}

/** Сравнение версий вида 1.21.4 / 1.21 / 24w14a. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = String(pa[i] || '').localeCompare(String(pb[i] || ''));
      if (c) return c;
    } else if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}
