'use strict';

/**
 * errors.js — журнал ошибок текущей сессии.
 *
 * Каждая ошибка, попадающая в IPC-обработчик или логгер, сохраняется в
 * массиве в памяти (не персистентно — «за эту сессию»). Renderer запрашивает
 * список через IPC и показывает на вкладке «Логи».
 */

const MAX = 500;
const buffer = [];
let seq = 0;

function push(entry) {
  buffer.push({
    id: ++seq,
    at: Date.now(),
    scope: entry.scope || 'app',
    message: entry.message || String(entry),
    detail: entry.detail || '',
    kind: entry.kind || 'error',
  });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  return buffer[buffer.length - 1];
}

function list() {
  return buffer.slice().reverse(); // новые сверху
}

function clear() {
  buffer.length = 0;
}

/** Человекочитаемое описание для AggregateError и простых Error. */
function describe(err) {
  if (!err) return { message: 'Неизвестная ошибка', detail: '' };
  if (err.name === 'AggregateError' && Array.isArray(err.errors)) {
    const inner = err.errors.map((e) => e && (e.code || e.message)).filter(Boolean).join('; ');
    return { message: `Несколько ошибок сети: ${inner || err.message}`, detail: err.stack || '' };
  }
  return { message: err.message || String(err), detail: err.stack || '' };
}

module.exports = { push, list, clear, describe };
