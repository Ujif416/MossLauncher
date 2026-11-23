/**
 * horizon.js — вкладка прямого запуска Minecraft на Rust (проект Horizon: horizon-rust/horizon).
 *
 * Кнопка «Играть (Rust)» работает в 1 клик:
 * сама скачивает выбранную сборку Horizon (Windows x64 + SHA256SUMS),
 * при необходимости доустанавливает Java и Minecraft 26.3 + server.jar,
 * подготавливает ресурсы через horizon-prepare (--complete --progress json)
 * и запускает horizon-client.exe напрямую из MossLauncher.
 */

import { el, formatBytes, shortDate } from '../ui-utils.js';
import { button, chip, emptyState, field, panel, progressBar, selectInput, textInput } from '../ui/components.js';
import { confirmDialog } from '../ui/dialogs.js';
import { appState } from '../app-state.js';

export function horizonView(container) {
  let disposed = false;
  let data = null;
  let selectedTag = '';
  let serverAddress = '';
  let busy = false;
  let liveState = { state: 'idle', message: '' };

  const controlsSlot = el('div', { className: 'col' });
  const statusSlot = el('div', { className: 'col' });
  const installedSlot = el('div', { className: 'col' });

  const unsub = window.moss.events.onHorizonState((st) => {
    if (disposed) return;
    liveState = st || { state: 'idle', message: '' };
    if (st.state === 'installing' || st.state === 'preparing' || st.state === 'starting') {
      busy = true;
    } else if (st.state === 'running') {
      busy = false;
    } else if (st.state === 'idle' || st.state === 'error') {
      busy = false;
      load().catch(() => {});
    }
    renderControls();
    renderStatus();
  });

  async function load() {
    if (!data) controlsSlot.replaceChildren(el('p', { className: 'muted' }, 'Загрузка списка сборок Horizon…'));
    try {
      data = await window.moss.horizon.list();
      if (disposed) return;
      if (!selectedTag) {
        selectedTag = (data.installed[0]?.tag) || (data.releases[0]?.tag) || 'nightly';
      }
      renderAll();
    } catch (e) {
      if (!disposed) {
        controlsSlot.replaceChildren(el('p', { className: 'field__error' }, `Не удалось загрузить релизы Horizon: ${e.message}`));
      }
    }
  }

  function isInstalled(tag) {
    return (data?.installed || []).some((i) => i.tag === tag);
  }

  function isRunning(tag) {
    return (data?.running || []).includes(tag) || (liveState.state === 'running' && (!liveState.tag || liveState.tag === tag));
  }

  async function doInstall() {
    if (busy || !selectedTag) return;
    busy = true;
    liveState = { state: 'installing', tag: selectedTag, message: `Установка ${selectedTag}…` };
    renderAll();
    try {
      await window.moss.horizon.install(selectedTag);
      appState.toast(`Horizon ${selectedTag} установлен`, 'success');
      await load();
    } catch (e) {
      appState.toast(e.message, 'error', 'Ошибка установки Horizon');
    } finally {
      busy = false;
      if (!disposed) renderAll();
    }
  }

  async function doPrepare() {
    if (busy || !selectedTag) return;
    busy = true;
    liveState = { state: 'preparing', tag: selectedTag, message: 'Подготовка Java, Minecraft и ресурсов Horizon…' };
    renderAll();
    try {
      await window.moss.horizon.prepare(selectedTag);
      appState.toast('Ресурсы Horizon успешно подготовлены', 'success');
      await load();
    } catch (e) {
      appState.toast(e.message, 'error', 'Ошибка подготовки ресурсов');
    } finally {
      busy = false;
      if (!disposed) renderAll();
    }
  }

  async function doLaunch() {
    if (busy || !selectedTag) return;
    busy = true;
    liveState = {
      state: 'preparing',
      tag: selectedTag,
      message: isInstalled(selectedTag)
        ? 'Проверка ресурсов и запуск Horizon (Rust)…'
        : `Автоустановка Horizon (${selectedTag}), подготовка ресурсов и запуск…`,
    };
    renderAll();
    try {
      await window.moss.horizon.launch({
        tag: selectedTag,
        server: serverAddress.trim() || undefined,
      });
    } catch (e) {
      busy = false;
      liveState = { state: 'error', tag: selectedTag, message: e.message };
      appState.toast(e.message, 'error', 'Не удалось запустить Horizon');
      if (!disposed) renderAll();
    }
  }

  async function doStop() {
    try {
      await window.moss.horizon.stop(selectedTag);
      appState.toast('Процесс Horizon остановлен', 'info');
      await load();
    } catch (e) {
      appState.toast(e.message, 'error');
    }
  }

  async function doRemove(tag) {
    const ok = await confirmDialog({
      title: `Удалить Horizon ${tag}?`,
      message: 'Файлы этой сборки будут удалены. Миры и подготовленные ресурсы сохранятся.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.moss.horizon.remove(tag);
      appState.toast(`Сборка ${tag} удалена`, 'info');
      await load();
    } catch (e) {
      appState.toast(e.message, 'error');
    }
  }

  function renderControls() {
    if (!data) return;
    const opts = [];
    const seen = new Set();
    for (const r of data.releases || []) {
      seen.add(r.tag);
      const sizeStr = r.asset?.size ? ` (${formatBytes(r.asset.size)})` : '';
      const suffix = isInstalled(r.tag) ? ' · установлено' : '';
      opts.push({ value: r.tag, label: `${r.tag}${sizeStr}${suffix}` });
    }
    for (const i of data.installed || []) {
      if (!seen.has(i.tag)) opts.push({ value: i.tag, label: `${i.tag} · локально` });
    }

    const sel = opts.length
      ? selectInput(selectedTag, opts, {
          onChange: (e) => {
            selectedTag = e.target.value;
            renderAll();
          },
        })
      : el('p', { className: 'muted' }, 'Релизы для Windows x64 не найдены.');

    const serverField = field(
      'Прямое подключение к серверу (необязательно)',
      textInput(serverAddress, {
        placeholder: 'host:25565 — оставить пустым для главного меню',
        onInput: (e) => { serverAddress = e.target.value; },
      })
    );

    const installed = isInstalled(selectedTag);
    const running = isRunning(selectedTag);

    controlsSlot.replaceChildren(
      field('Сборка Horizon (Windows x64)', sel, 'Нажмите «Играть (Rust)» — лаунчер сам скачает сборку, подготовит ресурсы Minecraft и запустит клиент.'),
      serverField,
      el(
        'div',
        { className: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
        running
          ? button('Остановить', { variant: 'danger', iconName: 'stop', onClick: doStop })
          : button(installed ? 'Играть (Rust)' : 'Установить и играть (Rust)', {
              variant: 'primary',
              iconName: 'play',
              disabled: busy || !selectedTag,
              onClick: doLaunch,
            }),
        button(installed ? 'Переустановить' : 'Только скачать', {
          variant: 'secondary',
          iconName: 'download',
          disabled: busy || !selectedTag,
          onClick: doInstall,
        }),
        button('Подготовить ресурсы', {
          variant: 'secondary',
          iconName: 'sync',
          disabled: busy || !installed,
          onClick: doPrepare,
        }),
        button('Папка', { variant: 'ghost', iconName: 'folder-open', onClick: () => window.moss.horizon.folder() }),
        button('Логи', { variant: 'ghost', iconName: 'terminal', onClick: () => appState.navigateTo('logs') })
      )
    );
  }

  function renderStatus() {
    const nodes = [];
    const acc = (appState.state.accounts || []).find((a) => a.uuid === appState.state.selectedAccount);
    const hasMs = acc && acc.type === 'microsoft';

    nodes.push(
      el(
        'div',
        { className: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
        chip(data?.resourcesReady ? 'Ресурсы готовы' : 'Ресурсы подготовятся при запуске', data?.resourcesReady ? 'accent' : 'neutral'),
        data?.requiredMc ? chip(`База: Minecraft ${data.requiredMc} · Java ${data.requiredJava || 25}`) : null,
        chip(
          hasMs
            ? `Microsoft: ${acc.username} (онлайн + одиночная)`
            : acc
              ? `Офлайн: ${acc.username} (одиночная игра)`
              : 'Аккаунт не выбран (гостевой режим)',
          hasMs ? 'accent' : 'neutral'
        )
      )
    );

    if (data?.warning) {
      nodes.push(el('p', { className: 'muted', style: { fontSize: '12px' } }, data.warning));
    }

    if (liveState.message) {
      nodes.push(el('p', { className: liveState.state === 'error' ? 'field__error' : 'muted' }, liveState.message));
    }

    if (liveState.state === 'installing' || liveState.state === 'preparing' || liveState.state === 'starting') {
      let pct = null;
      if (typeof liveState.fraction === 'number') {
        pct = Math.max(0, Math.min(100, Math.round(liveState.fraction * 100)));
      } else if (liveState.total > 0) {
        pct = Math.max(0, Math.min(100, Math.floor((100 * (liveState.done || 0)) / liveState.total)));
      }
      nodes.push(progressBar(pct ?? 0, pct === null));
      if (liveState.total > 0 && liveState.stage !== 'minecraft') {
        nodes.push(el('p', { className: 'muted mono' }, `${formatBytes(liveState.done || 0)} / ${formatBytes(liveState.total)} (${pct}%)`));
      } else if (pct !== null) {
        nodes.push(el('p', { className: 'muted mono' }, `${pct}%`));
      }
    }

    statusSlot.replaceChildren(...nodes.filter(Boolean));
  }

  function renderInstalled() {
    const list = data?.installed || [];
    if (!list.length) {
      installedSlot.replaceChildren(
        emptyState('rocket', 'Horizon ещё не установлен', 'Выберите сборку выше (например, nightly) и нажмите «Установить и играть (Rust)».')
      );
      return;
    }
    installedSlot.replaceChildren(
      ...list.map((item) =>
        el(
          'div',
          { className: 'card row', style: { padding: '14px 16px', alignItems: 'center', gap: '12px' } },
          el(
            'div',
            { className: 'grow' },
            el('strong', {}, item.tag),
            el('div', { className: 'muted', style: { fontSize: '12px' } }, item.installedAt ? `Установлено: ${shortDate(item.installedAt)}` : 'Локальная сборка')
          ),
          item.running ? chip('Запущено', 'accent') : null,
          button('Выбрать', { variant: 'secondary', onClick: () => { selectedTag = item.tag; renderAll(); } }),
          button('', { variant: 'ghost', iconName: 'delete', title: 'Удалить сборку', onClick: () => doRemove(item.tag) })
        )
      )
    );
  }

  function renderAll() {
    renderControls();
    renderStatus();
    renderInstalled();
  }

  container.append(
    el(
      'div',
      { className: 'view__inner' },
      el(
        'div',
        { className: 'page-head' },
        el('div', {}, el('h1', { className: 'page-head__title' }, 'Horizon (Rust)'), el('p', { className: 'page-head__sub' }, 'Нативный клиент Minecraft: Java Edition, переписанный на Rust — прямой запуск из MossLauncher')),
        el(
          'div',
          { className: 'page-head__actions' },
          button('GitHub проекта', { variant: 'ghost', iconName: 'external-link', onClick: () => window.moss.system.openExternal('https://github.com/horizon-rust/horizon') }),
          button('Обновить', { variant: 'secondary', iconName: 'check-updates', onClick: load })
        )
      ),
      el(
        'div',
        { className: 'col', style: { gap: '18px' } },
        panel(el('h3', {}, 'Запуск Minecraft на Rust'), controlsSlot, statusSlot),
        panel(el('h3', {}, 'Установленные сборки'), installedSlot)
      )
    )
  );

  load();
  return {
    unmount() {
      disposed = true;
      unsub();
    },
  };
}
