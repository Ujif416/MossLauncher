/**
 * accounts.js — аккаунты игрока.
 *
 * Microsoft-вход по device code: лаунчер показывает код, пользователь
 * вводит его на microsoft.com/link, токены приходят событием MS_LOGIN_STATE.
 * Офлайн-аккаунты — только ник, uuid генерируется детерминированно.
 */

import { el, asset } from '../ui-utils.js';
import { button, chip, emptyState, modal, statusDot } from '../ui/components.js';
import { confirmDialog, promptDialog } from '../ui/dialogs.js';
import { appState } from '../app-state.js';
import { accountHead } from '../account-head.js';
import { skinDialog, skinServerDialog } from '../skin-dialog.js';

export function accountsView(container) {
  const listHost = el('div', { className: 'col' });

  const loginBanner = () => {
    const code = appState.state.msLogin;
    if (!code) return null;
    return el(
      'div',
      { className: 'panel ms-login' },
      el('div', { className: 'tag' }, 'Вход Microsoft'),
      el('p', { className: 'ms-login__hint' }, 'Откройте страницу и введите код:'),
      el('div', { className: 'ms-login__code' }, code.userCode || '…'),
      el('p', { className: 'ms-login__url' }, code.verificationUri || 'https://www.microsoft.com/link'),
      el(
        'div',
        { className: 'row', style: { justifyContent: 'center', marginTop: '16px' } },
        button('Открыть страницу', { variant: 'secondary', iconName: 'external-link', onClick: () => window.moss.system.openExternal(code.verificationUri) }),
        button('Отмена', { variant: 'ghost', onClick: () => { window.moss.accounts.cancelLogin(); appState.update({ msLogin: null }); } })
      )
    );
  };

  function render() {
    const state = appState.state;
    const accounts = state.accounts || [];

    const children = [loginBanner()].filter(Boolean);
    if (accounts.length === 0 && !state.msLogin) {
      children.push(
        emptyState(
          'offline',
          'Нет аккаунтов',
          'Добавьте офлайн-аккаунт или войдите через Microsoft, чтобы играть.',
          el('div', { className: 'row' }, button('Offline', { variant: 'secondary', onClick: addOffline }), button('Microsoft', { variant: 'primary', iconName: 'login', onClick: loginMicrosoft }))
        )
      );
    } else {
      children.push(...accounts.map(accountCard));
    }
    listHost.replaceChildren(...children);
  }

  function accountCard(acc) {
    const selected = acc.uuid === appState.state.selectedAccount;
    const avatar = accountHead(acc);

    return el(
      'div',
      { className: `row-line account-row${selected ? ' is-active' : ''}` },
      el('span', { className: 'row-line__icon account-row__avatar' }, avatar),
      el(
        'div',
        { className: 'row-line__body' },
        el('div', { className: 'row-line__title' }, acc.username),
        el('div', { className: 'row-line__meta' }, acc.type === 'microsoft' ? 'Microsoft' : 'Офлайн')
      ),
      el(
        'div',
        { className: 'row-line__actions' },
        selected ? chip('активен') : null,
        statusDot(selected ? 'online' : null),
        button('Загрузить скин', { variant: 'secondary', onClick: () => skinDialog(acc) }),
        acc.type === 'microsoft' ? button('Обновить скин', { variant: 'ghost', onClick: async e => {
          e.currentTarget.disabled = true;
          try { appState.update({ accounts: await window.moss.accounts.refreshSkin(acc.uuid) }); }
          catch (err) { appState.toast(err.message, 'error'); }
          finally { render(); }
        } }) : null,
        acc.type === 'microsoft' || acc.offlineSkin ? button('SkinsRestorer', { variant: 'ghost', onClick: () => skinServerDialog(acc) }) : null,
        !selected ? button('Выбрать', { variant: 'secondary', onClick: () => window.moss.accounts.select(acc.uuid).then(() => refresh()) }) : null,
        button('', {
          variant: 'ghost',
          iconName: 'delete',
          title: 'Удалить',
          onClick: async () => {
            const ok = await confirmDialog({ title: 'Удалить аккаунт?', message: acc.username, confirmLabel: 'Удалить', danger: true });
            if (!ok) return;
            await window.moss.accounts.remove(acc.uuid);
            refresh();
          },
        })
      )
    );
  }

  async function refresh() {
    const res = await window.moss.accounts.list();
    appState.update({ accounts: res.accounts, selectedAccount: res.selected });
  }

  async function addOffline() {
    const username = await promptDialog({
      title: 'Офлайн-аккаунт',
      label: 'Никнейм',
      placeholder: 'Steve',
      hint: '3–16 символов: латиница, цифры и _',
      confirmLabel: 'Добавить',
      validate: (v) => (/^[A-Za-z0-9_]{3,16}$/.test(v) ? null : 'Ник: 3–16 символов, только латиница, цифры и _'),
    });
    if (!username) return;
    try {
      await window.moss.accounts.addOffline(username);
      await refresh();
      appState.toast(`Добавлен ${username}`, 'success');
    } catch (e) {
      appState.toast(e.message, 'error');
    }
  }

  async function loginMicrosoft() {
    try {
      await window.moss.accounts.loginMicrosoft();
      // Код приходит событием MS_LOGIN_CODE → appState.msLogin
    } catch (e) {
      appState.toast(e.message, 'error', 'Не удалось начать вход');
    }
  }

  const head = el(
    'div',
    { className: 'page-head' },
    el('div', {}, el('h1', { className: 'page-head__title' }, 'Аккаунты'), el('p', { className: 'page-head__sub' }, 'Выберите, под кем запускать игру')),
    el('div', { className: 'page-head__actions' }, button('Offline', { variant: 'secondary', onClick: addOffline }), button('Microsoft', { variant: 'primary', iconName: 'login', onClick: loginMicrosoft }))
  );

  container.append(el('div', { className: 'view__inner' }, head, listHost));

  render();
  const unsubscribe = appState.subscribe(render);
  return { unmount: unsubscribe };
}
