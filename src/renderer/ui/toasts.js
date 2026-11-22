/**
 * toasts.js — единственный владелец DOM-контейнера уведомлений.
 * Подписывается на appState и держит список тостов в актуальном состоянии.
 */

import { el } from '../ui-utils.js';
import { appState } from '../app-state.js';
import { toastEl } from './components.js';

export function mountToasts() {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { className: 'toasts', id: 'toasts' });
    document.body.append(host);
  }

  const render = (state) => {
    host.replaceChildren(...state.toasts.map((t) => toastEl(t, (id) => appState.dismissToast(id))));
  };

  render(appState.state);
  appState.subscribe(render);
  return host;
}