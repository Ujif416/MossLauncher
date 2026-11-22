/**
 * app.js — точка входа renderer-процесса.
 *
 * Отвечает только за каркас: загрузка состояния, rail-навигация, монтирование
 * активного вью и глобальные подписки. Логика экранов живёт во views/*.
 */

import { el, asset, icon } from './ui-utils.js';
import { appState, refreshEnvironment } from './app-state.js';
import { mountToasts } from './ui/toasts.js';
import { homeView } from './views/home.js';
import { versionsView } from './views/versions.js';
import { modsView } from './views/mods.js';
import { modpacksView } from './views/modpacks.js';
import { serversView } from './views/servers.js';
import { startGreetings } from './greetings.js';
import { accountsView } from './views/accounts.js';
import { settingsView } from './views/settings.js';
import { logsView } from './views/logs.js';
import { screenshotsView } from './views/screenshots.js';

const VIEWS = {
  home: homeView,
  versions: versionsView,
  mods: modsView,
  modpacks: modpacksView,
  servers: serversView,
  screenshots: screenshotsView,
  accounts: accountsView,
  settings: settingsView,
  logs: logsView,
};

const NAV = [
  { id: 'home', icon: 'home', title: 'Главная' },
  { id: 'versions', icon: 'instances', title: 'Версии' },
  { id: 'mods', icon: 'mods', title: 'Моды' },
  { id: 'modpacks', icon: 'archive', title: 'Сборки' },
  { id: 'servers', icon: 'servers', title: 'Серверы' },
  { id: 'screenshots', icon: 'screenshot', title: 'Скриншоты' },
  { id: 'logs', icon: 'terminal', title: 'Логи' },
];

let contentEl = null;
let activeView = null;
let mountedId = null;

async function boot() {
  mountToasts();

  const state = await window.moss.system.state();
  startGreetings(state.settings.lastGreetingId);
  appState.update({
    loading: false,
    settings: state.settings,
    accounts: state.accounts,
    selectedAccount: state.selected,
    installedVersions: state.installed,
    runningVersions: state.running,
    selectedVersionId: state.settings.lastVersionId || state.installed[0] || '',
  });

  const root = document.getElementById('app');
  root.replaceChildren();
  contentEl = el('div', { className: 'content' });
  root.append(el('div', { className: 'shell' }, buildRail(), contentEl));

  appState.subscribe((s) => {
    if (s.currentView !== mountedId) renderView(s.currentView);
  });

  renderView(appState.state.currentView || 'home');
  subscribeToMain();
  wireTitlebar();

  // Моды и сборки подтягиваем после первой отрисовки, чтобы UI появился сразу.
  refreshEnvironment().catch((e) => appState.toast(e.message, 'error', 'Не удалось загрузить данные'));

  // Тихая фоновая проверка обновлений лаунчера
  if (state.settings.autoCheckUpdates !== false && state.settings.updateRepo) {
    window.moss.updater.check().then((info) => {
      if (info?.updateAvailable) {
        appState.update({ launcherUpdate: info });
        appState.toast(`Доступна версия v${info.latestVersion}. Откройте «Настройки → Обновления».`, 'info', 'Обновление MossLauncher', 7000);
      }
    }).catch(() => {});
  }
}

function buildRail() {
  const nav = el('div', { className: 'rail__nav' }, ...NAV.map(railItem));
  const logo = el(
    'button',
    { className: 'rail__logo', title: 'Главная', type: 'button', onClick: () => appState.navigateTo('home') },
    el('img', { src: asset('branding', 'mark-sage@2x.png'), alt: '' }),
    el('span', {}, 'MossLauncher')
  );
  const foot = el('div', { className: 'rail__foot' }, railItem({ id: 'accounts', icon: 'account', title: 'Аккаунты' }), railItem({ id: 'settings', icon: 'settings', title: 'Настройки' }));
  return el('div', { className: 'rail' }, logo, nav, foot);
}

function railItem(item) {
  const node = el(
    'button',
    {
      className: `rail__item${appState.state.currentView === item.id ? ' is-active' : ''}`,
      'data-view': item.id,
      title: item.title,
      type: 'button',
      onClick: () => appState.navigateTo(item.id),
    },
    icon(item.icon),
    el('span', { className: 'rail__item__tip' }, item.title)
  );
  appState.subscribe((s) => node.classList.toggle('is-active', s.currentView === item.id));
  return node;
}

function renderView(id) {
  if (!contentEl) return;
  if (activeView && typeof activeView.unmount === 'function') {
    try {
      activeView.unmount();
    } catch (e) {
      console.error('unmount failed', e);
    }
  }

  const viewEl = el('div', { className: `view${VIEWS[id] && VIEWS[id].flush ? ' view--flush' : ''}` });
  contentEl.replaceChildren(viewEl);
  mountedId = id;

  activeView = VIEWS[id](viewEl) || null;
}

function subscribeToMain() {
  window.moss.events.onToast((e) => appState.toast(e.message, e.type === 'online' ? 'success' : e.type));

  window.moss.events.onGameLog((e) => {
    const log = appState.state.gameLog.concat(e.line.replace(/\s+$/, ''));
    appState.update({ gameLog: log.length > 2000 ? log.slice(-2000) : log });
  });

  window.moss.events.onGameState(async (e) => {
    const running = appState.state.runningVersions.filter((v) => v !== e.versionId);
    if (e.state === 'starting') running.push(e.versionId);
    if (e.state === 'starting' && appState.state.settings.showConsole) appState.navigateTo('logs');
    appState.update({ runningVersions: running, gameState: e });
    if (e.state === 'exited' || e.state === 'error') refreshEnvironment().catch(() => {});
  });

  window.moss.events.onMsLoginCode((code) => {
    appState.update({ msLogin: code });
    appState.navigateTo('accounts');
  });

  window.moss.events.onMsLoginState(async (e) => {
    appState.update({ msLogin: null });
    if (!e.ok) {
      appState.toast(e.error, 'error', 'Ошибка входа');
      return;
    }
    const list = await window.moss.accounts.list();
    appState.update({ accounts: list.accounts, selectedAccount: list.selected });
    appState.toast(`Вход выполнен: ${e.account.username}`, 'success');
  });

  window.moss.events.onDownloadProgress((p) => {
    const key = `${p.scope}:${p.versionId || p.major || ''}`;
    const rest = appState.state.downloads.filter((d) => d.key !== key);
    appState.update({ downloads: rest.concat({ ...p, key }) });
  });

  window.moss.events.onSyncProgress((p) => appState.update({ syncProgress: p }));

  window.moss.events.onCrashReport((report) => {
    appState.update({ crashReport: report });
    if (report?.detected) {
      appState.toast(report.title, 'error', 'Диагностика краша', 7000);
    }
  });
}

function wireTitlebar() {
  document.querySelectorAll('.titlebar__btn').forEach((btn) => {
    btn.addEventListener('click', () => window.moss.system.windowAction(btn.dataset.action));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    console.error('boot failed', e);
    const root = document.getElementById('app');
    if (!root) return;
    root.replaceChildren(
      el(
        'div',
        { className: 'boot-error' },
        el('h2', {}, 'Не удалось загрузить лаунчер'),
        el('p', { className: 'muted' }, e.message)
      )
    );
  });
});
