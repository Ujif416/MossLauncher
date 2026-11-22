import { el, asset, formatBytes, shortDate } from '../ui-utils.js';
import { button, chip, modal, textInput } from '../ui/components.js';
import { appState } from '../app-state.js';

const STAGES = { account: 'Проверка аккаунта', manifest: 'Получение списка файлов', java: 'Подготовка Java 21', runtime: 'Подготовка Minecraft и NeoForge', libraries: 'Загрузка библиотек', natives: 'Подготовка библиотек', assetindex: 'Проверка ресурсов', assets: 'Загрузка ресурсов Minecraft', installer: 'Установка NeoForge', loader: 'Установка NeoForge', extract: 'Распаковка Java', verify: 'Проверка файлов сборки', download: 'Загрузка файлов', apply: 'Применение обновления', ready: 'Сборка готова', launch: 'Запуск Minecraft' };
const put = (node, value) => { if (node.textContent !== value) node.textContent = value; };

export function serversView(container) {
  let disposed = false, polling = false, dialog = null;
  const cards = new Map(), pending = new Map();
  const list = el('div', { className: 'servers__list' });
  const notice = el('p', { className: 'servers__notice muted' }, 'Получение каталога серверов…');
  container.append(el('div', { className: 'view__inner servers' },
    el('div', { className: 'view-head' },
      el('h1', {}, 'Серверы'),
      el('p', { className: 'muted' }, 'Выберите сервер — лаунчер подготовит сборку и запустит подключение.'),
      button('Опубликовать обновление сборки', { variant: 'secondary', iconName: 'check-updates', onClick: showPublish })),
    notice, list));
  const unsubscribe = window.moss.events.onServerState(s => {
    pending.set(s.id, s); cards.get(s.id)?.update(s);
    if (s.state === 'error' && s.errorCode === 'account-missing') appState.toast(s.message, 'error');
  });

  function makeCard(server) {
    const image = el('img', { className: 'server-card__icon', src: asset('placeholders', 'server.png'), alt: '' });
    const online = el('div', { className: 'server-card__online' }, 'Проверка статуса…');
    const label = el('span', {}, 'Играть');
    const play = button('', { variant: 'primary', className: 'server-card__play', onClick: async () => {
      if (!appState.state.selectedAccount) { appState.navigateTo('accounts'); appState.toast('Выберите аккаунт для входа на сервер', 'info'); return; }
      play.disabled = true;
      try {
        const result = await window.moss.servers.play(server.id);
        if (result?.started === false) {
          if (result.state) cards.get(server.id)?.update(result.state);
          else play.disabled = false;
        }
      }
      catch (e) { appState.toast(e.message, 'error'); play.disabled = false; }
    } }); play.append(label);
    const cancel = button('Отменить', { variant: 'ghost', className: 'server-card__cancel', onClick: () => window.moss.servers.cancel(server.id).catch(e => appState.toast(e.message, 'error')) });
    const message = el('span', { className: 'server-card__message' });
    const count = el('span', { className: 'server-card__count' });
    const fill = el('div', { className: 'server-card__fill' });
    const bar = el('div', { className: 'server-card__bar', role: 'progressbar', 'aria-label': 'Подготовка сборки', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
    const progress = el('div', { className: 'server-card__progress' }, el('div', { className: 'server-card__progress-head' }, message, count), bar);
    const revisionText = server.hasUpdate
      ? `Доступно обновление: ${server.installedRevision} → ${server.packRevision}`
      : server.installedRevision
        ? `Установлена ревизия: ${server.installedRevision}`
        : server.packRevision
          ? `Актуальная ревизия: ${server.packRevision}`
          : '';
    const revisionEl = el('p', { className: `server-card__revision${server.hasUpdate ? ' server-card__revision--update' : ''}` }, revisionText);
    const card = el('article', { className: 'card server-card', 'data-server-id': server.id },
      el('div', { className: 'server-card__head' }, image,
        el('div', { className: 'server-card__body' }, el('h2', {}, server.name), el('p', { className: 'muted' }, server.description),
          el('p', { className: 'server-card__version' }, `Minecraft ${server.minecraft} · NeoForge ${server.loader.version}`),
          revisionEl), online),
      el('div', { className: 'server-card__address muted' }, server.address.host + (server.address.port === 25565 ? '' : ':' + server.address.port)),
      progress,
      el('div', { className: 'server-card__actions' },
        button('Моды', { variant: 'secondary', onClick: () => showMods(server) }),
        button('Изменения', { variant: 'secondary', iconName: 'history', onClick: () => showChangelog(server) }),
        button('Папка', { variant: 'ghost', onClick: () => window.moss.servers.folder(server.id).catch(e => appState.toast(e.message, 'error')) }),
        button('Логи', { variant: 'ghost', onClick: () => appState.navigateTo('logs') }),
        el('span', { className: 'grow' }), cancel, play));
    list.append(card);
    let lastTime = 0;
    return {
      update(s) {
        if (s.updatedAt && s.updatedAt < lastTime) return; lastTime = s.updatedAt || lastTime;
        const busy = ['preparing', 'starting', 'running'].includes(s.state);
        play.disabled = busy || !!s.cancelling;
        cancel.style.visibility = busy ? 'visible' : 'hidden'; cancel.disabled = !!s.cancelling;
        put(cancel, s.state === 'running' ? 'Закрыть игру' : 'Отменить');
        const value = s.total > 0 ? Math.max(0, Math.min(100, Math.floor(100 * (s.done || 0) / s.total))) : null;
        put(label, s.state === 'running' ? 'Игра запущена' : s.state === 'starting' ? 'Запуск…' : s.state === 'preparing' ? (s.stage === 'download' && value !== null ? `Загрузка ${value}%` : 'Подготовка…') : s.state === 'error' ? 'Повторить' : 'Играть');
        put(message, s.cancelling ? s.message : s.state === 'preparing' ? (STAGES[s.stage] || s.message || 'Подготовка сборки') : (s.message || (s.state === 'error' ? 'Не удалось подготовить сборку. Нажмите «Повторить» или откройте «Логи».' : 'Сборка проверяется перед каждым запуском')));
        message.title = s.message || message.textContent;
        message.classList.toggle('server-card__message--error', s.state === 'error');
        put(count, s.state === 'preparing' && s.total > 0 ? (s.unit === 'bytes' ? `${formatBytes(s.done || 0)} / ${formatBytes(s.total)}` : `${s.done || 0} / ${s.total}`) : '');
        bar.style.visibility = s.state === 'preparing' || s.state === 'starting' ? 'visible' : 'hidden';
        bar.classList.toggle('server-card__bar--indeterminate', value === null);
        if (value === null) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(value));
        fill.style.width = value === null ? '32%' : `${value}%`;
      },
      status(s) {
        put(online, s.state === 'online' ? `Онлайн · ${s.playersOnline ?? '—'} / ${s.playersMax ?? '—'}` : 'Статус недоступен');
        online.classList.toggle('server-card__online--up', s.state === 'online');
        online.title = s.state === 'online' ? 'Сервер ответил на запрос статуса' : 'Сервер может быть доступен для входа. Попробуйте «Играть».';
        const src = s.favicon || asset('placeholders', 'server.png');
        if (image.getAttribute('src') !== src) image.src = src;
      },
    };
  }
  async function poll() {
    if (disposed || polling) return; polling = true;
    try { await Promise.all([...cards].map(async ([id, card]) => {
      try { const s = await window.moss.servers.status(id); if (!disposed) card.status(s); }
      catch { if (!disposed) card.status({ state: 'unknown' }); }
    })); } finally { polling = false; }
  }
  async function showPublish() {
    const settings = appState.state.settings || {};
    const status = el('p', { className: 'muted' }, 'Готово к публикации.');
    const token = textInput(settings.githubToken || '', { type: 'password', placeholder: 'GitHub Personal Access Token' });
    const revision = textInput('', { placeholder: 'Например, skybound-2026-11-20.1 (автоматически)' });
    const body = el('div', { className: 'col' },
      el('p', { className: 'muted' }, 'Список модов берётся из папки сервера. Файлы, помеченные как серверные, игрокам не передаются.'),
      el('label', { className: 'field' }, el('span', { className: 'field__label' }, 'GitHub-токен'), token),
      el('label', { className: 'field' }, el('span', { className: 'field__label' }, 'Номер выпуска (необязательно)'), revision),
      status);
    const publish = button('Опубликовать', { variant: 'primary' });
    let unsub = () => {};
    const scrim = modal({
      title: 'Опубликовать обновление сборки',
      subtitle: 'Пересчёт контрольных сумм и новая ревизия в GitHub',
      body,
      footer: el('div', { className: 'row' }, el('span', { className: 'grow' }), button('Отмена', { variant: 'ghost', onClick: () => scrim.close() }), publish),
      onClose: () => unsub(),
    });
    dialog = scrim; document.body.append(scrim);
    unsub = window.moss.events.onSyncProgress(p => {
      if (p.scope !== 'publish' || !scrim.isConnected) return;
      put(status, p.message || p.stage || 'Публикация…');
    });
    publish.onclick = async () => {
      publish.disabled = true;
      try {
        const result = await window.moss.packs.publish({
          token: token.value.trim() || settings.githubToken,
          revision: revision.value.trim() || undefined,
        });
        if (result.unchanged) appState.toast(`Ревизия ${result.revision} уже актуальна`, 'info');
        else appState.toast(`Опубликована ревизия ${result.revision}: файлов ${result.files}, добавлено ${result.added}, обновлено ${result.updated}`, 'success');
        scrim.close();
        const refreshed = await window.moss.servers.list();
        put(notice, refreshed.warning || 'Иконка и онлайн обновляются автоматически.');
      } catch (e) {
        put(status, e.message);
        appState.toast(e.message, 'error');
        publish.disabled = false;
      }
    };
  }

  function renderDiffBlock(diff) {
    if (!diff || diff.totalChanges === 0) return el('p', { className: 'muted' }, 'Состав модов и конфигов не изменился.');
    const items = [];
    for (const m of diff.modsAdded || []) items.push(el('div', { className: 'changelog-item--add' }, `+ ${m}`));
    for (const m of diff.modsUpdated || []) items.push(el('div', { className: 'changelog-item--upd' }, `~ ${m.from} → ${m.to}`));
    for (const m of diff.modsRemoved || []) items.push(el('div', { className: 'changelog-item--rem' }, `- ${m}`));
    if (diff.configsCount) items.push(el('div', { className: 'muted' }, `Конфигов изменено: ${diff.configsCount}`));
    if (diff.otherCount) items.push(el('div', { className: 'muted' }, `Прочих файлов изменено: ${diff.otherCount}`));
    return el('div', { className: 'changelog-list' }, ...items);
  }

  async function showChangelog(server) {
    const content = el('div', { className: 'changelog-section' }, el('p', { className: 'muted' }, 'Загрузка истории изменений…'));
    dialog?.remove();
    const scrim = modal({
      title: `Изменения сборки: ${server.name}`,
      subtitle: 'Сравнение установленной и опубликованной ревизий',
      wide: true,
      body: content,
    });
    dialog = scrim; document.body.append(scrim);
    try {
      const data = await window.moss.servers.changelog(server.id);
      if (disposed || !scrim.isConnected) return;
      const blocks = [];
      blocks.push(
        el(
          'div',
          { className: 'row' },
          chip(data.installedRevision ? `Установлено: ${data.installedRevision}` : 'Сборка ещё не установлена'),
          data.remoteRevision ? chip(`На GitHub: ${data.remoteRevision}`, data.hasUpdate ? 'accent' : 'neutral') : null
        )
      );
      if (data.pendingDiff) {
        blocks.push(
          el(
            'div',
            { className: 'changelog-entry changelog-entry--pending' },
            el(
              'div',
              { className: 'changelog-entry__head' },
              el('strong', {}, 'Ожидает установки'),
              el('span', { className: 'muted' }, data.pendingDiff.summary)
            ),
            renderDiffBlock(data.pendingDiff)
          )
        );
      }
      if (data.history?.length) {
        for (const h of data.history) {
          blocks.push(
            el(
              'div',
              { className: 'changelog-entry' },
              el(
                'div',
                { className: 'changelog-entry__head' },
                el('strong', {}, `${h.fromRevision || 'начало'} → ${h.toRevision || 'актуальная'}`),
                el('span', { className: 'muted' }, `${shortDate(h.syncedAt)} · ${h.diff?.summary || ''}`)
              ),
              renderDiffBlock(h.diff)
            )
          );
        }
      } else if (!data.pendingDiff) {
        blocks.push(el('p', { className: 'muted' }, 'История обновлений появится после первого обновления сборки между ревизиями.'));
      }
      content.replaceChildren(...blocks);
    } catch (e) {
      if (scrim.isConnected) content.replaceChildren(el('p', { className: 'field__error' }, e.message));
    }
  }

  async function showMods(server) {
    const content = el('div', { className: 'server-mods__list' }, 'Загрузка списка…');
    const count = el('p', { className: 'muted' }); let files = [];
    const input = textInput('', { placeholder: 'Поиск по имени файла', onInput: render }); input.setAttribute('aria-label', 'Поиск модов сервера');
    dialog?.remove();
    const scrim = modal({ title: `Моды: ${server.name}`, wide: true, body: el('div', { className: 'col server-mods' }, input, count, content) });
    dialog = scrim; document.body.append(scrim);
    function render() {
      const selected = files.filter(f => f.toLowerCase().includes(input.value.toLowerCase()));
      put(count, `Показано ${selected.length} из ${files.length}`);
      content.replaceChildren(...(selected.length ? selected.map(f => el('div', { className: 'server-mods__item' }, f)) : [el('p', { className: 'muted' }, files.length ? 'Совпадений нет' : 'Моды появятся после подготовки сборки.')]));
    }
    try { files = await window.moss.servers.mods(server.id); if (!disposed && scrim.isConnected) render(); }
    catch (e) { if (scrim.isConnected) put(content, e.message); }
  }
  window.moss.servers.list().then(result => {
    if (disposed) return;
    put(notice, result.warning || 'Иконка и онлайн обновляются автоматически.');
    for (const server of result.servers) { const card = makeCard(server); cards.set(server.id, card); card.update(pending.get(server.id) || server.state); }
    poll();
  }).catch(e => { if (!disposed) put(notice, e.message); });
  const timer = setInterval(poll, 20000);
  return { unmount() { disposed = true; clearInterval(timer); unsubscribe(); dialog?.remove(); } };
}
