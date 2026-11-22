/**
 * popmenu.js — выпадающее меню, привязанное к кнопке.
 *
 * Меню позиционируется относительно кнопки (вверх или вниз), закрывается
 * по клику вне, Escape и выбору пункта.
 */

import { el, icon } from '../ui-utils.js';

/**
 * @param {HTMLElement} anchor кнопка-триггер
 * @param {Array<{label:string, icon?:string, onClick?:Function, active?:boolean, action?:boolean}>} items
 * @param {{up?: boolean, minWidth?: number}} opts
 */
export function openPopmenu(anchor, items, opts = {}) {
  closeOpenPopmenu();

  const { up = false, minWidth = 240 } = opts;
  const menu = el('div', { className: `popmenu${up ? ' popmenu--up' : ''}` });
  menu.style.minWidth = `${Math.max(anchor.offsetWidth, minWidth)}px`;

  for (const item of items) {
    if (item.separator) {
      menu.append(el('div', { className: 'popmenu__sep' }));
      continue;
    }
    const node = el(
      'button',
      {
        className: `popmenu__item${item.active ? ' is-active' : ''}${item.action ? ' popmenu__item--action' : ''}`,
        type: 'button',
        onClick: () => {
          close();
          if (item.onClick) item.onClick();
        },
      },
      item.icon ? el('span', { className: 'popmenu__icon' }, iconNode(item.icon)) : null,
      el('span', { className: 'grow ellipsis' }, item.label),
      item.active ? el('span', { className: 'popmenu__check' }, iconNode('check')) : null
    );
    menu.append(node);
  }

  menu.style.visibility = 'hidden';
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUp = up || (spaceBelow < menuRect.height + 16 && rect.top > menuRect.height + 16);

  menu.classList.toggle('popmenu--up', openUp);
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menuRect.width - 12)}px`;
  menu.style.top = openUp ? `${rect.top - menuRect.height - 8}px` : `${rect.bottom + 8}px`;
  menu.style.visibility = '';

  current = { menu, close };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  return menu;

  function onOutside(event) {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    close();
  }

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  function close() {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    menu.remove();
    if (current && current.menu === menu) current = null;
  }
}

let current = null;

export function closeOpenPopmenu() {
  if (current) current.close();
}

function iconNode(name) {
  return icon(name);
}