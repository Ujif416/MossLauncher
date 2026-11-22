/**
 * logs.js — консоль игры и журнал ошибок сессии.
 *
 * Две вкладки:
 *  - «Игра»: строки GAME_LOG из main (последние 2000).
 *  - «Ошибки»: всё, что словил IPC-обёртка и логгер за текущую сессию.
 */

import { el, icon, shortDate } from '../ui-utils.js';
import { button, chip, segmented, emptyState } from '../ui/components.js';
import { appState, refreshErrors } from '../app-state.js';

export function logsView(container) {
  const tabsHost = el('div', { className: 'tabs' });
  const status = el('div', { className: 'row' });
  const diagSlot = el('div');
  const scroll = el('div', { className: 'logs__scroll' });
  const toolbar = el('div', { className: 'page-head__actions' });

  let tab = 'game';
  let uploading = false;

  function lineClass(line) {
    if (/\b(error|exception|failed|fatal)\b/i.test(line)) return ' logs__line--err';
    if (/\b(warn|deprecated)\b/i.test(line)) return ' logs__line--warn';
    return '';
  }

  function renderTabs() {
    const errCount = (appState.state.sessionErrors || []).length;
    tabsHost.replaceChildren(
      segmented(
        [
          { value: 'game', label: 'Игра' },
          { value: 'errors', label: `Ошибки сессии (${errCount})` },
        ],
        tab,
        (v) => { tab = v; renderAll(); }
      )
    );
  }

  async function runAnalyze() {
    try {
      const report = await window.moss.logs.analyze({ lines: appState.state.gameLog || [] });
      appState.update({ crashReport: report });
      appState.toast(report.detected ? report.title : 'Критичных ошибок в логе не найдено', report.detected ? 'warning' : 'success');
    } catch (e) {
      appState.toast(e.message, 'error');
    }
  }

  async function uploadLog() {
    if (uploading) return;
    const text = (appState.state.gameLog || []).join('\n');
    if (!text.trim()) { appState.toast('Лог игры пуст', 'info'); return; }
    uploading = true;
    renderToolbar();
    try {
      const res = await window.moss.logs.upload(text);
      appState.update({ lastLogUrl: res.url });
      try { await navigator.clipboard.writeText(res.url); } catch {}
      appState.toast(`Ссылка скопирована: ${res.url}`, 'success', 'Лог выгружен на mclo.gs', 6000);
    } catch (e) {
      appState.toast(e.message, 'error', 'Ошибка выгрузки на mclo.gs');
    } finally {
      uploading = false;
      renderToolbar();
    }
  }

  function renderDiagnosis() {
    if (tab !== 'game') { diagSlot.replaceChildren(); return; }
    const report = appState.state.crashReport;
    const logUrl = appState.state.lastLogUrl;
    const nodes = [];

    if (report) {
      const sevClass = report.severity === 'error' ? '' : report.severity === 'warning' ? ' crash-banner--warning' : ' crash-banner--info';
      nodes.push(
        el(
          'div',
          { className: `crash-banner${sevClass}` },
          el(
            'div',
            { className: 'crash-banner__head' },
            icon(report.severity === 'error' ? 'error' : report.severity === 'warning' ? 'warning' : 'check'),
            el('div', { className: 'crash-banner__title grow' }, report.title),
            button('На mclo.gs', { variant: 'secondary', iconName: 'upload', disabled: uploading, onClick: uploadLog }),
            button('', { variant: 'ghost', iconName: 'close', title: 'Скрыть', onClick: () => appState.update({ crashReport: null }) })
          ),
          el('div', { className: 'crash-banner__summary' }, report.summary),
          report.culprits?.length
            ? el('div', { className: 'crash-banner__culprits' }, ...report.culprits.map((c) => chip(c, 'danger')))
            : null,
          report.hints?.length
            ? el('ul', { className: 'crash-banner__hints' }, ...report.hints.map((h) => el('li', {}, h)))
            : null
        )
      );
    }

    if (logUrl) {
      nodes.push(
        el(
          'div',
          { className: 'crash-banner crash-banner--info' },
          el(
            'div',
            { className: 'crash-banner__head' },
            icon('link'),
            el('div', { className: 'grow' }, el('span', { className: 'muted' }, 'Последний лог mclo.gs: '), el('span', { className: 'mono' }, logUrl)),
            button('Открыть', { variant: 'secondary', iconName: 'external-link', onClick: () => window.moss.system.openExternal(logUrl) }),
            button('Копировать', {
              variant: 'ghost', iconName: 'copy',
              onClick: async () => { try { await navigator.clipboard.writeText(logUrl); appState.toast('Ссылка скопирована', 'success'); } catch {} },
            }),
            button('', { variant: 'ghost', iconName: 'close', title: 'Скрыть', onClick: () => appState.update({ lastLogUrl: null }) })
          )
        )
      );
    }

    diagSlot.replaceChildren(...nodes);
  }

  function renderToolbar() {
    if (tab === 'game') {
      toolbar.replaceChildren(
        button('Анализ', { variant: 'secondary', iconName: 'bug', onClick: runAnalyze }),
        button(uploading ? 'Выгрузка…' : 'На mclo.gs', { variant: 'primary', iconName: 'upload', disabled: uploading, onClick: uploadLog }),
        button('Копировать', {
          variant: 'secondary', iconName: 'copy',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText((appState.state.gameLog || []).join('\n'));
              appState.toast('Логи скопированы', 'success');
            } catch { appState.toast('Не удалось скопировать', 'error'); }
          },
        }),
        button('Очистить', { variant: 'secondary', iconName: 'delete', onClick: () => appState.update({ gameLog: [], crashReport: null }) })
      );
    } else {
      toolbar.replaceChildren(
        button('Обновить', { variant: 'secondary', iconName: 'check-updates', onClick: refreshErrors }),
        button('Копировать', {
          variant: 'secondary', iconName: 'copy',
          onClick: async () => {
            const errs = appState.state.sessionErrors || [];
            const text = errs.map((e) => `[${new Date(e.at).toISOString()}] ${e.scope}: ${e.message}${e.detail ? '\n' + e.detail : ''}`).join('\n\n');
            try { await navigator.clipboard.writeText(text); appState.toast('Ошибки скопированы', 'success'); }
            catch { appState.toast('Не удалось скопировать', 'error'); }
          },
        }),
        button('Очистить', {
          variant: 'secondary', iconName: 'delete',
          onClick: async () => { await window.moss.errors.clear(); await refreshErrors(); },
        })
      );
    }
  }

  function renderStatus() {
    if (tab !== 'game') { status.replaceChildren(); return; }
    const s = appState.state;
    status.replaceChildren(
      el('span', { className: 'muted' }, 'Запущено:'),
      ...(s.runningVersions.length
        ? s.runningVersions.map((v) => chip(v))
        : [el('span', { className: 'muted' }, 'ничего')])
    );
  }

  function renderBody() {
    if (tab === 'game') {
      const lines = appState.state.gameLog || [];
      scroll.replaceChildren(...lines.map((l) => el('div', { className: 'logs__line' + lineClass(l) }, l)));
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      const errs = appState.state.sessionErrors || [];
      if (!errs.length) {
        scroll.replaceChildren(
          el('div', { className: 'center-block', style: { padding: '40px 0' } },
            emptyState('check', 'Ошибок нет', 'За эту сессию ничего не зафиксировано.'))
        );
        return;
      }
      scroll.replaceChildren(...errs.map(errorCard));
    }
  }

  function errorCard(e) {
    const dt = new Date(e.at);
    const time = dt.toLocaleTimeString('ru-RU');
    const detail = e.detail || '';
    const expandable = detail && detail !== e.message;
    const body = el('div', { className: 'error-card__body' },
      el('div', { className: 'error-card__msg' }, e.message),
      expandable ? el('pre', { className: 'error-card__detail', hidden: 'hidden' }, detail) : null
    );
    const head = el('div', { className: 'error-card__head' },
      el('span', { className: 'error-card__icon' }, icon(e.kind === 'warning' ? 'warning' : 'error')),
      el('div', { className: 'grow' },
        el('div', { className: 'error-card__scope' }, e.scope || 'app'),
        el('div', { className: 'error-card__time' }, time)
      ),
      chip(e.kind === 'warning' ? 'предупреждение' : 'ошибка', e.kind === 'warning' ? 'neutral' : 'danger'),
      expandable ? button('', { variant: 'ghost', iconName: 'chevron-down', title: 'Детали', onClick: (ev) => {
        const d = body.querySelector('.error-card__detail');
        if (!d) return;
        const hidden = d.hasAttribute('hidden');
        if (hidden) d.removeAttribute('hidden'); else d.setAttribute('hidden', '');
        ev.currentTarget.querySelector('img').style.transform = hidden ? 'rotate(180deg)' : '';
      } }) : null
    );
    return el('div', { className: `error-card${e.kind === 'warning' ? ' is-warn' : ''}` }, head, body);
  }

  function renderAll() {
    renderTabs();
    renderToolbar();
    renderStatus();
    renderDiagnosis();
    renderBody();
  }

  container.append(
    el(
      'div',
      { className: 'view__inner' },
      el('div', { className: 'page-head' }, el('div', {}, el('h1', { className: 'page-head__title' }, 'Логи'), el('p', { className: 'page-head__sub' }, 'Вывод игры, диагностика крашей и ошибки сессии')), toolbar),
      tabsHost,
      status,
      diagSlot,
      el('div', { className: 'logs__wrap' }, scroll)
    )
  );

  renderAll();
  refreshErrors().catch(() => {});
  const unsubscribe = appState.subscribe(() => { renderAll(); });
  return { unmount: unsubscribe };
}
