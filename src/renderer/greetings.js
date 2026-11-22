import { greetings } from './greetings-data.js';

export function getGreetingPeriod(now) {
  const h = now.getHours();
  return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'day' : h >= 18 && h < 23 ? 'evening' : 'night';
}
export function pickGreeting(period, lastId, random = Math.random, catalog = greetings) {
  const all = catalog[period] || [];
  const alternatives = all.filter(g => g.id !== lastId);
  const pool = alternatives.length ? alternatives : all;
  return pool.length ? pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))] : { id: '', title: 'С возвращением, странник.', description: 'Твои любимые миры уже ждут.' };
}
export function createGreetingService({ now = () => new Date(), random = Math.random, save = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let current, period, timer, active = false, previous = '', writes = Promise.resolve();
  const listeners = new Set();
  function check() {
    if (!active) return;
    cancel(timer);
    const fresh = getGreetingPeriod(now());
    if (!current || fresh !== period) {
      current = pickGreeting(fresh, previous, random); period = fresh; previous = current.id;
      const id = current.id;
      writes = writes.then(() => save(id)).catch(() => {});
      for (const fn of listeners) fn(current);
    }
    // Rare checks also detect clock/timezone changes without platform-specific events.
    const date = now(), boundary = new Date(date);
    const hour = [5, 12, 18, 23].find(h => h > date.getHours());
    if (hour === undefined) boundary.setDate(boundary.getDate() + 1);
    boundary.setHours(hour ?? 5, 0, 0, 0);
    timer = schedule(check, Math.max(1000, Math.min(60000, boundary - date)));
  }
  return {
    start(lastId) { if (active) return; previous = typeof lastId === 'string' ? lastId : ''; active = true; check(); },
    check,
    subscribe(fn) { listeners.add(fn); if (current) fn(current); return () => listeners.delete(fn); },
    stop() { active = false; cancel(timer); listeners.clear(); },
    get current() { return current; },
  };
}
export const greetingService = createGreetingService({ save: id => window.moss.settings.set({ lastGreetingId: id }) });
export function startGreetings(lastId) {
  greetingService.start(lastId);
  const check = () => greetingService.check();
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pagehide', () => {
    greetingService.stop(); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check);
  }, { once: true });
}
