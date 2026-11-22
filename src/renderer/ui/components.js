/**
 * components.js — переиспользуемые элементы интерфейса.
 * Каждая функция возвращает DOM-элемент без побочных эффектов.
 */

import { el, img, icon, emptyArt } from '../ui-utils.js';

export function button(label, opts = {}) {
  const {
    variant = 'secondary',
    iconName = null,
    disabled = false,
    onClick = null,
    className = '',
    title = '',
    type = 'button',
  } = opts;
  return el(
    'button',
    { className: `btn btn--${variant} ${className}`.trim(), type, title, disabled, onClick },
    iconName ? el('span', { className: 'btn__icon' }, icon(iconName)) : null,
    label
  );
}

export function iconBtn(iconName, opts = {}) {
  const { onClick = null, title = '', className = '' } = opts;
  return el('button', {
    className: `btn btn--icon ${className}`.trim(),
    title,
    type: 'button',
    onClick,
  }, icon(iconName));
}

export function field(label, control, hint = null) {
  return el(
    'div',
    { className: 'field' },
    label ? el('label', { className: 'field__label' }, label) : null,
    control,
    hint ? el('p', { className: 'field__hint' }, hint) : null
  );
}

export function textInput(value, opts = {}) {
  const { placeholder = '', type = 'text', onInput = null, onChange = null, className = '' } = opts;
  return el('input', {
    className: `input ${className}`.trim(),
    type,
    value: value == null ? '' : String(value),
    placeholder,
    onInput,
    onChange,
  });
}

export function selectInput(value, options, opts = {}) {
  const { onChange = null, className = '' } = opts;
  const node = el('select', { className: `select ${className}`.trim(), onChange });
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    node.append(opt);
  }
  node.value = String(value);
  return node;
}

export function toggle(checked, onChange) {
  return el('button', {
    className: 'toggle',
    role: 'switch',
    type: 'button',
    'aria-checked': checked ? 'true' : 'false',
    onClick: (e) => {
      const next = e.currentTarget.getAttribute('aria-checked') !== 'true';
      e.currentTarget.setAttribute('aria-checked', next ? 'true' : 'false');
      if (onChange) onChange(next);
    },
  });
}

export function checkRow(label, checked, onChange) {
  const node = el(
    'button',
    {
      className: 'check',
      role: 'checkbox',
      type: 'button',
      'aria-checked': checked ? 'true' : 'false',
      onClick: (e) => {
        const next = e.currentTarget.getAttribute('aria-checked') !== 'true';
        e.currentTarget.setAttribute('aria-checked', next ? 'true' : 'false');
        if (onChange) onChange(next);
      },
    },
    el('span', { className: 'check__box' }, el('span', { className: 'btn__icon' }, icon('check'))),
    el('span', {}, label)
  );
  return node;
}

export function spinner() {
  return el('span', { className: 'spinner' });
}

export function progressBar(percent, indeterminate = false) {
  const fill = el('div', { className: 'progress__fill' });
  if (!indeterminate) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const bar = el('div', { className: `progress${indeterminate ? ' progress--indeterminate' : ''}` }, fill);
  bar.setValue = (p) => {
    bar.classList.remove('progress--indeterminate');
    fill.style.width = `${Math.max(0, Math.min(100, p))}%`;
  };
  return bar;
}

export function chip(text, variant = null) {
  return el('span', { className: `chip${variant ? ' chip--' + variant : ''}` }, text);
}

export function statusDot(kind) {
  return el('span', { className: `dot${kind ? ' dot--' + kind : ''}` });
}

export function card(children, opts = {}) {
  const { hover = false, className = '', onClick = null } = opts;
  return el('div', {
    className: `card${hover ? ' card--hover' : ''} ${className}`.trim(),
    onClick,
  }, children);
}

export function panel(...children) {
  return el('div', { className: 'panel' }, ...children);
}

export function emptyState(artName, title, text, action = null) {
  return el(
    'div',
    { className: 'empty' },
    emptyArt(artName),
    el('h4', {}, title),
    text ? el('p', {}, text) : null,
    action
  );
}

export function searchBox(value, placeholder, onInput) {
  return el(
    'div',
    { className: 'search' },
    el('span', { className: 'search__icon' }, icon('search')),
    textInput(value, { placeholder, onInput })
  );
}

export function segmented(items, active, onSelect) {
  return el(
    'div',
    { className: 'segmented' },
    ...items.map((it) =>
      el('button', {
        className: `segmented__item${it.value === active ? ' is-active' : ''}`,
        type: 'button',
        onClick: () => onSelect(it.value),
      }, it.label)
    )
  );
}

export function tabs(items, active, onSelect) {
  return el(
    'div',
    { className: 'tabs' },
    ...items.map((it) =>
      el('button', {
        className: `tab${it.value === active ? ' is-active' : ''}`,
        type: 'button',
        onClick: () => onSelect(it.value),
      }, it.label)
    )
  );
}

/**
 * modal({ title, subtitle, body, footer, wide, onClose }) → узел .scrim
 * Возвращает элемент; закрытие — вызов modal.close() на узле.
 */
export function modal(opts) {
  const { title, subtitle = null, body, footer = null, wide = false, onClose = () => {} } = opts;

  const scrim = el(
    'div',
    { className: 'scrim', onClick: (e) => { if (e.target === e.currentTarget) close(); } },
    el(
      'div',
      { className: `modal${wide ? ' modal--wide' : ''}` },
      el(
        'div',
        { className: 'modal__head' },
        el('div', { className: 'grow' },
          el('div', { className: 'modal__title' }, title),
          subtitle ? el('div', { className: 'modal__sub' }, subtitle) : null
        ),
        el('button', { className: 'btn btn--icon modal__close', type: 'button', onClick: () => close() }, icon('close'))
      ),
      el('div', { className: 'modal__body' }, body),
      footer ? el('div', { className: 'modal__foot' }, footer) : null
    )
  );

  function close() {
    if (scrim.classList.contains('scrim--leaving')) return;
    scrim.classList.add('scrim--leaving');
    setTimeout(() => {
      scrim.remove();
      onClose();
    }, 180);
  }

  scrim.close = close;
  return scrim;
}

export function toastEl(toast, onDismiss) {
  const iconName = {
    success: 'success',
    error: 'error',
    warning: 'warning',
    info: 'info',
    online: 'wifi',
    offline: 'offline',
  }[toast.level] || 'info';

  return el(
    'div',
    { className: `toast toast--${toast.level}${toast.leaving ? ' toast--leaving' : ''}` },
    el('span', { className: 'toast__icon' }, icon(iconName)),
    el('div', { className: 'toast__body' },
      toast.title ? el('div', { className: 'toast__title' }, toast.title) : null,
      el('div', { className: 'toast__msg' }, toast.message)
    ),
    el('button', { className: 'btn btn--icon', type: 'button', onClick: () => onDismiss(toast.id) }, icon('close'))
  );
}