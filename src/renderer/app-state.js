/**
 * app-state.js — единый источник состояния UI.
 *
 * Простой контейнер «объект + подписчики»: вью читают appState.state,
 * изменяют данные через update(), навигация — через navigateTo().
 * Асинхронные загрузки собраны в refresh*-функциях ниже, чтобы вью
 * не дублировали одни и те же вызовы IPC.
 */

class AppState {
  constructor() {
    this.state = {
      loading: true,
      currentView: 'home',

      settings: {},
      accounts: [],
      selectedAccount: null,
      selectedVersionId: '',

      installedVersions: [],
      runningVersions: [],

      mods: [],
      packs: [],
      modUpdates: [],

      downloads: [],
      syncProgress: null,
      gameLog: [],
      gameState: null,
      crashReport: null,
      lastLogUrl: null,
      launcherUpdate: null,
      sessionErrors: [],

      msLogin: null,

      toasts: [],
    };

    this.subscribers = new Set();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  update(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (this.state[key] !== value) {
        this.state[key] = value;
        changed = true;
      }
    }
    if (!changed && Object.keys(patch).length) return;
    for (const fn of [...this.subscribers]) {
      try {
        fn(this.state);
      } catch (e) {
        console.error('subscriber failed', e);
      }
    }
  }

  navigateTo(view) {
    if (this.state.currentView === view) return;
    this.update({ currentView: view });
  }

  /** Тост живёт `duration` мс; 0 — до ручного закрытия. */
  toast(message, level = 'info', title = null, duration = 4200) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.update({ toasts: [...this.state.toasts, { id, message, level, title, leaving: false }] });
    if (duration > 0) setTimeout(() => this.dismissToast(id), duration);
    return id;
  }

  dismissToast(id) {
    this.update({
      toasts: this.state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    });
    setTimeout(() => {
      this.update({ toasts: this.state.toasts.filter((t) => t.id !== id) });
    }, 200);
  }
}

export const appState = new AppState();

/** Полная перезагрузка окружения: настройки, аккаунты, версии, моды, сборки. */
export async function refreshEnvironment() {
  const state = await window.moss.system.state();
  appState.update({
    settings: state.settings,
    accounts: state.accounts,
    selectedAccount: state.selected,
    installedVersions: state.installed,
    runningVersions: state.running,
  });
  if (!appState.state.selectedVersionId) {
    appState.update({ selectedVersionId: state.settings.lastVersionId || state.installed[0] || '' });
  }
  await Promise.all([refreshMods(), refreshPacks()]);
  return state;
}

/** Установленные моды текущей версии. */
export async function refreshMods() {
  const id = appState.state.selectedVersionId;
  if (!id) {
    appState.update({ mods: [] });
    return [];
  }
  const list = await window.moss.mods.list(id);
  if (appState.state.selectedVersionId === id) appState.update({ mods: list });
  return list;
}

export async function refreshPacks() {
  const packs = await window.moss.packs.list();
  appState.update({ packs });
  return packs;
}

/** Журнал ошибок сессии (из main-процесса). */
export async function refreshErrors() {
  const errs = await window.moss.errors.list();
  appState.update({ sessionErrors: errs });
  return errs;
}

/** Сменить активную версию и подтянуть её моды. */
export async function selectVersion(id) {
  appState.update({ selectedVersionId: id, mods: [], modUpdates: [] });
  await window.moss.settings.set({ lastVersionId: id });
  appState.update({ settings: { ...appState.state.settings, lastVersionId: id } });
  await refreshMods();
}
