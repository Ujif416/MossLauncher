'use strict';

/**
 * protocol.js — serves the renderer over a custom `app://` scheme.
 *
 * file:// origins are opaque, so ES modules and fetch() cannot work there.
 * A privileged, standard scheme gives us a normal origin, working module
 * loading, and a sane CSP (`'self'`).
 *
 *   app://launcher/<path>        → src/renderer/<path>
 *   app://launcher/assets/<path> → assets/mosslauncher-complete/<path>
 */

const { protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const HOST = 'launcher';

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function handle(rendererDir, assetsDir) {
  protocol.handle(SCHEME, async (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!rel) rel = 'index.html';

    let filePath;
    if (rel.startsWith('screenshots/')) {
      try {
        const settingsMod = require('./settings');
        const profileTools = require('./profile-tools');
        const shotRel = rel.slice('screenshots/'.length);
        filePath = profileTools.resolveSafeScreenshot(settingsMod.getSettings(), shotRel);
      } catch {
        return new Response('Forbidden', { status: 403 });
      }
    } else {
      let base = rendererDir;
      if (rel.startsWith('assets/')) {
        base = assetsDir;
        rel = rel.slice('assets/'.length);
      }
      filePath = path.resolve(base, rel);
      if (!isInside(base, filePath)) return new Response('Forbidden', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { SCHEME, HOST, registerScheme, handle };