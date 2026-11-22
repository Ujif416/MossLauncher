/**
 * dialogs.js — модальные диалоги, которых нет в Electron.
 *
 * window.prompt() в Electron не реализован, а window.confirm() блокирует
 * рендерер. Поэтому подтверждение и ввод текста живут здесь и возвращают
 * Promise, чтобы вызывающий код читался линейно.
 */

import { el } from '../ui-utils.js';
import { button, field, modal, textInput } from './components.js';

function mount(node) {
  document.body.append(node);
  return node;
}

/** Подтверждение действия. → Promise<boolean> */
export function confirmDialog(opts) {
  const { title, message = '', confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = false } = opts;
  return new Promise((resolve) => {
    let result = false;
    const scrim = mount(
      modal({
        title,
        body: message ? el('p', { className: 'dialog__text' }, message) : null,
        footer: [
          button(cancelLabel, { variant: 'ghost', onClick: () => scrim.close() }),
          button(confirmLabel, {
            variant: danger ? 'danger' : 'primary',
            onClick: () => {
              result = true;
              scrim.close();
            },
          }),
        ],
        onClose: () => resolve(result),
      })
    );
  });
}

/**
 * Ввод одной строки. → Promise<string|null>
 * validate(value) возвращает текст ошибки или null.
 */
export function promptDialog(opts) {
  const {
    title,
    label = '',
    value = '',
    placeholder = '',
    hint = null,
    confirmLabel = 'Сохранить',
    validate = null,
  } = opts;

  return new Promise((resolve) => {
    let result = null;
    const input = textInput(value, { placeholder });
    const error = el('p', { className: 'field__error' });
    const body = el('div', { className: 'col' }, label ? field(label, input, hint) : input, error);
    const submit = () => {
      const raw = input.value.trim();
      const problem = validate ? validate(raw) : raw ? null : 'Поле не может быть пустым';
      if (problem) {
        error.textContent = problem;
        input.classList.add('input--invalid');
        input.focus();
        return;
      }
      result = raw;
      scrim.close();
    };

    const scrim = mount(
      modal({
        title,
        body,
        footer: [
          button('Отмена', { variant: 'ghost', onClick: () => scrim.close() }),
          button(confirmLabel, { variant: 'primary', onClick: submit }),
        ],
        onClose: () => resolve(result),
      })
    );

    input.addEventListener('input', () => {
      error.textContent = '';
      input.classList.remove('input--invalid');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => input.focus(), 30);
  });
}