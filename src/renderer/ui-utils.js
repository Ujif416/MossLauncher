/**
 * ui-utils.js — DOM-хелперы и форматирование.
 *
 * ASSET_ROOT: protocol.js maps app://launcher/assets/<path> to
 * assets/mosslauncher-complete/<path>, so we reference assets/ directly.
 */

export const ASSET_ROOT = new URL('./assets/', import.meta.url).href;

export function asset(...parts) {
  return ASSET_ROOT + parts.join('/');
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function img(src, alt = '') {
  return el('img', { src, alt, draggable: 'false', loading: 'lazy' });
}

/** Иконка из набора ассетов (icons/default). */
export function icon(name) {
  return img(asset('icons/default', name + '.svg'));
}

/** Иконка в акцентном цвете. */
export function iconAccent(name) {
  return img(asset('icons/accent', name + '.svg'));
}

export function iconMuted(name) {
  return img(asset('icons/muted', name + '.svg'));
}

/** Пустая иллюстрация из набора ассетов. */
export function emptyArt(name) {
  return img(asset('empty-states', name + '.png'));
}

export function formatBytes(bytes) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1).replace('.0', '') + ' млрд';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace('.0', '') + ' млн';
  if (value >= 1_000) return (value / 1_000).toFixed(1).replace('.0', '') + ' тыс.';
  return String(value);
}

export function shortDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Разбор идентификатора версии на «версия игры + загрузчик».
 * Понимает vanilla (1.21.1), fabric-loader-0.16.9-1.21.1,
 * quilt-loader-…, 1.20.1-forge-47.2.0 и 21.1.80-neoforge-….
 */
export function parseVersionId(id) {
  const s = String(id || '');
  let m;
  if ((m = s.match(/^fabric-loader-[\d.]+-(.+)$/))) return { loader: 'fabric', mcVersion: m[1] };
  if ((m = s.match(/^quilt-loader-[\d.]+-(.+)$/))) return { loader: 'quilt', mcVersion: m[1] };
  if ((m = s.match(/^(.+)-forge-?[\d.]+$/))) return { loader: 'forge', mcVersion: m[1] };
  if ((m = s.match(/^(.+)-neoforge-[\d.]+$/))) return { loader: 'neoforge', mcVersion: m[1] };
  if ((m = s.match(/^neoforge-(\d+)\.(\d+)\./))) return { loader: 'neoforge', mcVersion: `1.${m[1]}${m[2] === '0' ? '' : '.' + m[2]}` };
  return { loader: 'vanilla', mcVersion: s };
}

export const LOADER_LABELS = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

/** Сравнение версий вида 1.21.4 / 1.21 / 24w14a. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = String(pa[i] || '').localeCompare(String(pb[i] || ''));
      if (c) return c;
    } else if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}
