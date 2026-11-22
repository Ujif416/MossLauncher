'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./server-catalog');
const remote = require('./server-download');
const changelog = require('./server-changelog');
function writeJson(file, value) {
  catalog.noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp'; catalog.noLinks(temp);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file);
}
function readState(dirs) {
  catalog.noLinks(dirs.state);
  if (!fs.existsSync(dirs.state)) return null;
  if (fs.statSync(dirs.state).size > 8 * 1024 ** 2) throw new Error('Повреждён список установленной сборки');
  const data = JSON.parse(fs.readFileSync(dirs.state, 'utf8'));
  if (!Array.isArray(data.files) || data.files.length > 20000) throw new Error('Повреждён список установленной сборки');
  for (const f of data.files) catalog.safePath(f.path);
  return data;
}
function exists(file) {
  catalog.noLinks(file);
  try { if (!fs.statSync(file).isFile()) throw new Error('Вместо файла найдена папка: ' + path.basename(file)); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function matches(file, expected, signal) {
  if (!exists(file) || fs.statSync(file).size !== expected.size) return false;
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) h.update(chunk);
  return h.digest('hex') === expected.sha256;
}
function copy(from, to) {
  catalog.noLinks(from); catalog.noLinks(to);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
}
function removeTransaction(dirs) {
  catalog.noLinks(dirs.transaction);
  // All files in this private transaction directory were created by this synchronizer.
  fs.rmSync(dirs.transaction, { recursive: true, force: true });
}
function finishTransaction(dirs, journal) {
  const backup = path.join(dirs.transaction, 'backup');
  if (fs.existsSync(backup)) {
    const dest = path.join(dirs.root, 'backups', journal.backupId);
    catalog.noLinks(dest); fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.renameSync(backup, dest);
  }
  removeTransaction(dirs);
}
function recover(dirs) {
  catalog.noLinks(dirs.root); catalog.noLinks(dirs.transaction);
  const file = path.join(dirs.transaction, 'journal.json'); catalog.noLinks(file);
  if (!fs.existsSync(file)) { if (fs.existsSync(dirs.transaction)) removeTransaction(dirs); return; }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j.operations) || j.operations.length > 40000 || !/^[a-f0-9-]{36}$/.test(j.backupId)) throw new Error('Повреждён журнал обновления сервера');
  for (const op of j.operations) catalog.safePath(op.path);
  if (j.committed) { finishTransaction(dirs, j); return; }
  for (const op of j.operations) {
    const dest = path.join(dirs.game, op.path); catalog.noLinks(dest);
    if (op.existed) copy(path.join(dirs.transaction, 'backup', op.path), dest);
    else if (exists(dest)) fs.unlinkSync(dest);
  }
  if (j.hadState) copy(path.join(dirs.transaction, 'previous-state.json'), dirs.state);
  else if (fs.existsSync(dirs.state)) { catalog.noLinks(dirs.state); fs.unlinkSync(dirs.state); }
  removeTransaction(dirs);
}
async function sync(server, files, dirs, { signal, onProgress = () => {}, download = remote.file } = {}) {
  recover(dirs); signal?.throwIfAborted();
  fs.mkdirSync(dirs.game, { recursive: true });
  const previous = readState(dirs), oldFiles = new Map((previous?.files || []).map(f => [f.path, f]));
  const jobs = []; let checked = 0;
  for (const f of files) {
    signal?.throwIfAborted(); const dest = path.join(dirs.game, f.path);
    // Player settings survive relaunches; an upstream config change still gets applied with backup.
    const personalConfig = /^(config|defaultconfigs)\//.test(f.path) && oldFiles.get(f.path)?.sha256 === f.sha256 && exists(dest);
    if (!personalConfig && !await matches(dest, f, signal)) jobs.push(f);
    onProgress({ stage: 'verify', done: ++checked, total: files.length, unit: 'files' });
  }
  const nextNames = new Set(files.map(f => f.path.toLowerCase()));
  const removed = (previous?.files || []).filter(f => !nextNames.has(f.path.toLowerCase()) && exists(path.join(dirs.game, f.path)));
  const total = jobs.reduce((n, f) => n + f.size, 0), counts = new Map();
  let cursor = 0;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const workers = Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const f = jobs[cursor++], target = path.join(dirs.transaction, 'new', f.path);
        catalog.noLinks(target);
        for (let attempt = 0; ; attempt++) {
          controller.signal.throwIfAborted();
          try {
            await download(catalog.fileUrl(server, f.path), target, f, { signal: controller.signal, onBytes: done => {
              counts.set(f.path, done);
              onProgress({ stage: 'download', done: [...counts.values()].reduce((a, b) => a + b, 0), total, unit: 'bytes', file: path.basename(f.path) });
            } }); break;
          } catch (e) { if (controller.signal.aborted || attempt >= 2) throw e; counts.set(f.path, 0); }
        }
      }
    });
    let failure;
    await Promise.all(workers.map(p => p.catch(e => { failure ||= e; controller.abort(); })));
    if (failure) throw failure;
    signal?.throwIfAborted();
    const operations = [...jobs, ...removed].map(f => ({ path: f.path, existed: exists(path.join(dirs.game, f.path)) }));
    const journal = { operations, hadState: !!previous, backupId: crypto.randomUUID(), committed: false };
    for (const op of operations) if (op.existed) copy(path.join(dirs.game, op.path), path.join(dirs.transaction, 'backup', op.path));
    if (previous) copy(dirs.state, path.join(dirs.transaction, 'previous-state.json'));
    writeJson(path.join(dirs.transaction, 'journal.json'), journal);
    // No await in this short commit section: cancellation cannot leave half an update applied.
    for (const f of jobs) copy(path.join(dirs.transaction, 'new', f.path), path.join(dirs.game, f.path));
    for (const f of removed) { const dest = path.join(dirs.game, f.path); catalog.noLinks(dest); fs.unlinkSync(dest); }
    writeJson(dirs.state, { serverId: server.id, packRevision: server.packRevision, minecraft: server.minecraft, loader: server.loader, syncedAt: Date.now(), files });
    writeJson(path.join(dirs.transaction, 'journal.json'), { ...journal, committed: true });
    finishTransaction(dirs, journal);
    try {
      if (previous && (previous.packRevision !== server.packRevision || jobs.length > 0 || removed.length > 0)) {
        const diff = changelog.computeDiff(previous.files || [], files);
        if (diff.totalChanges > 0 || previous.packRevision !== server.packRevision) {
          changelog.recordEntry(dirs.root, {
            fromRevision: previous.packRevision || null,
            toRevision: server.packRevision || null,
            syncedAt: Date.now(),
            diff,
          });
        }
      }
    } catch {}
    onProgress({ stage: 'ready', done: files.length, total: files.length, unit: 'files' });
    return { changed: jobs.length, removed: removed.length };
  } catch (e) { recover(dirs); throw e; }
  finally { signal?.removeEventListener('abort', abort); }
}
module.exports = { sync, recover, readState, matches };
