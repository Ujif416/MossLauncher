/**
 * screenshots.js — встроенная галерея скриншотов со всех игровых профилей.
 *
 * Позволяет фильтровать по профилю, просматривать в полном размере,
 * копировать изображение в буфер обмена в 1 клик, открывать папку и удалять в корзину.
 */

import { el, formatBytes, shortDate } from '../ui-utils.js';
import { button, chip, emptyState, modal, selectInput } from '../ui/components.js';
import { confirmDialog } from '../ui/dialogs.js';
import { appState } from '../app-state.js';

export function screenshotsView(container) {
  let disposed = false;
  let allShots = [];
  let profiles = [];
  let selectedProfile = 'all';
  let activeDialog = null;

  const filterSlot = el('div', { className: 'row' });
  const countLabel = el('span', { className: 'muted' });
  const grid = el('div', { className: 'shots__grid' });

  async function load() {
    grid.replaceChildren(el('p', { className: 'muted' }, 'Сканируем скриншоты…'));
    try {
      const [profData, shots] = await Promise.all([
        window.moss.profiles.list(),
        window.moss.screenshots.list('all'),
      ]);
      if (disposed) return;
      profiles = profData.profiles || [];
      allShots = shots || [];
      renderFilter();
      renderGrid();
    } catch (e) {
      if (!disposed) grid.replaceChildren(el('p', { className: 'field__error' }, e.message));
    }
  }

  function renderFilter() {
    const opts = [
      { value: 'all', label: `Все профили (${allShots.length})` },
      ...profiles
        .filter((p) => p.screenshotCount > 0)
        .map((p) => ({ value: p.id, label: `${p.label} (${p.screenshotCount})` })),
    ];
    if (!opts.some((o) => o.value === selectedProfile)) selectedProfile = 'all';
    const sel = selectInput(opts, selectedProfile, (val) => {
      selectedProfile = val;
      renderGrid();
    });
    filterSlot.replaceChildren(sel);
  }

  async function copyShot(shot) {
    try {
      await window.moss.screenshots.copy(shot.relPath);
      appState.toast('Скриншот скопирован в буфер обмена', 'success');
    } catch (e) {
      appState.toast(e.message, 'error');
    }
  }

  async function removeShot(shot) {
    const ok = await confirmDialog({
      title: 'Удалить скриншот?',
      message: `Файл «${shot.name}» будет перемещён в корзину.`,
      confirmLabel: 'В корзину',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.moss.screenshots.remove(shot.relPath);
      allShots = allShots.filter((s) => s.id !== shot.id);
      const prof = profiles.find((p) => p.id === shot.profileId);
      if (prof && prof.screenshotCount > 0) prof.screenshotCount -= 1;
      activeDialog?.close();
      renderFilter();
      renderGrid();
      appState.toast('Скриншот перемещён в корзину', 'info');
    } catch (e) {
      appState.toast(e.message, 'error');
    }
  }

  function openLightbox(shot) {
    activeDialog?.remove();
    const img = el('img', {
      className: 'shots__preview-img',
      src: shot.url,
      alt: shot.name,
    });
    const meta = el(
      'div',
      { className: 'row shots__preview-meta' },
      chip(shot.profileLabel),
      el('span', { className: 'muted' }, shortDate(shot.mtimeMs)),
      el('span', { className: 'muted' }, formatBytes(shot.size))
    );
    const scrim = modal({
      title: shot.name,
      wide: true,
      body: el('div', { className: 'col' }, img, meta),
      footer: el(
        'div',
        { className: 'row' },
        button('Копировать изображение', { variant: 'primary', iconName: 'copy', onClick: () => copyShot(shot) }),
        button('Открыть папку', {
          variant: 'secondary',
          iconName: 'folder-open',
          onClick: () => {
            const dir = shot.filePath.replace(/[\\/][^\\/]+$/, '');
            window.moss.system.openFolder(dir);
          },
        }),
        el('span', { className: 'grow' }),
        button('В корзину', { variant: 'danger', iconName: 'delete', onClick: () => removeShot(shot) })
      ),
    });
    activeDialog = scrim;
    document.body.append(scrim);
  }

  function renderGrid() {
    const visible = selectedProfile === 'all'
      ? allShots
      : allShots.filter((s) => s.profileId === selectedProfile);
    countLabel.textContent = visible.length ? `Показано: ${visible.length}` : '';

    if (!visible.length) {
      grid.replaceChildren(
        el(
          'div',
          { className: 'center-block', style: { gridColumn: '1 / -1', padding: '48px 0' } },
          emptyState('screenshot', 'Скриншотов пока нет', 'Нажмите F2 в Minecraft — скриншоты из всех профилей и серверов появятся здесь.')
        )
      );
      return;
    }

    grid.replaceChildren(
      ...visible.map((shot) =>
        el(
          'article',
          { className: 'card shot-card' },
          el(
            'button',
            {
              className: 'shot-card__thumb',
              type: 'button',
              title: 'Открыть просмотр',
              onClick: () => openLightbox(shot),
            },
            el('img', { src: shot.url, alt: shot.name, loading: 'lazy', draggable: 'false' })
          ),
          el(
            'div',
            { className: 'shot-card__foot' },
            el(
              'div',
              { className: 'shot-card__info' },
              el('div', { className: 'shot-card__name ellipsis', title: shot.name }, shot.name),
              el('div', { className: 'shot-card__sub muted ellipsis' }, `${shot.profileLabel} · ${shortDate(shot.mtimeMs)}`)
            ),
            el(
              'div',
              { className: 'row' },
              button('', { variant: 'ghost', iconName: 'copy', title: 'Копировать изображение', onClick: () => copyShot(shot) }),
              button('', { variant: 'ghost', iconName: 'delete', title: 'Удалить в корзину', onClick: () => removeShot(shot) })
            )
          )
        )
      )
    );
  }

  container.append(
    el(
      'div',
      { className: 'view__inner' },
      el(
        'div',
        { className: 'page-head' },
        el('div', {}, el('h1', { className: 'page-head__title' }, 'Скриншоты'), el('p', { className: 'page-head__sub' }, 'Галерея снимков из всех профилей и серверов')),
        el(
          'div',
          { className: 'page-head__actions' },
          filterSlot,
          button('Обновить', { variant: 'secondary', iconName: 'check-updates', onClick: load })
        )
      ),
      countLabel,
      grid
    )
  );

  load();
  return {
    unmount() {
      disposed = true;
      activeDialog?.remove();
    },
  };
}
