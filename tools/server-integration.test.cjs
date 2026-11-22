'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const catalog = require('../src/main/server-catalog');
const sync = require('../src/main/server-sync');
const remote = require('../src/main/server-download');
const { ping, iconData } = require('../src/main/server-status');
const server = catalog.get('create-skybound');
function fixture(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-server-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return catalog.paths(p, server.id); }
function file(name, body) { return { path: name, size: Buffer.byteLength(body), sha256: catalog.hash(Buffer.from(body)) }; }
function downloader(bodies, calls) { return async (_url, dest, f, opts) => { opts.signal?.throwIfAborted(); calls.push(f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bodies[f.path]); opts.onBytes(f.size); }; }
test('catalog rejects traversal, ambiguous Windows paths, duplicate destinations and foreign sources', () => {
  for (const name of ['../secret', 'mods/../../secret', 'mods/C:/x', 'mods/a\\b', 'mods/a:stream', 'mods/CON.jar', 'mods/a.', 'saves/world', 'mods//x']) assert.throws(() => catalog.safePath(name), name);
  const source = require('../src/shared/server-catalog.json');
  const bad = structuredClone(source); bad.servers[0].pack.repository = 'attacker/files'; assert.throws(() => catalog.validateCatalog(bad));
  const a = file('mods/a.jar', 'a');
  assert.throws(() => catalog.validateIndex({ minecraft: '1.21.1', loader: 'neoforge', files: [a, { ...a, path: 'mods/A.jar' }] }, server));
  assert.throws(() => catalog.validateIndex({ minecraft: '1.21.1', loader: 'neoforge', files: [a, { ...a, path: 'mods/a.jar/child' }] }, server));
  for (const url of ['http://raw.githubusercontent.com/Ujif416/Create-Aeronautics-Skybound/a', 'https://evil.test/x', 'https://raw.githubusercontent.com/other/repo/x', 'https://user:pass@raw.githubusercontent.com/Ujif416/Create-Aeronautics-Skybound/x']) assert.throws(() => remote.allowed(url));
});
test('incremental sync preserves user worlds and settings, replaces changed mods, removes only retired managed files', async t => {
  const d = fixture(t), calls = [], a = file('mods/a.jar', 'first'), conf = file('config/a.toml', 'default');
  await sync.sync(server, [a, conf], d, { download: downloader({ [a.path]: 'first', [conf.path]: 'default' }, calls) });
  fs.mkdirSync(path.join(d.game, 'saves/world'), { recursive: true }); fs.writeFileSync(path.join(d.game, 'saves/world/level.dat'), 'world');
  fs.writeFileSync(path.join(d.game, 'options.txt'), 'personal'); fs.writeFileSync(path.join(d.game, 'mods/user.jar'), 'manual'); fs.writeFileSync(path.join(d.game, conf.path), 'personal config');
  calls.length = 0;
  await sync.sync(server, [a, conf], d, { download: downloader({}, calls) }); assert.deepEqual(calls, []);
  const b = file('mods/b.jar', 'second');
  await sync.sync({ ...server, packRevision: 'test-2' }, [b, conf], d, { download: downloader({ [b.path]: 'second' }, calls) });
  assert.deepEqual(calls, [b.path]); assert.ok(!fs.existsSync(path.join(d.game, a.path)));
  for (const [name, expected] of [['saves/world/level.dat', 'world'], ['options.txt', 'personal'], ['mods/user.jar', 'manual'], [conf.path, 'personal config']]) assert.equal(fs.readFileSync(path.join(d.game, name), 'utf8'), expected);
  assert.equal(sync.readState(d).packRevision, 'test-2');
});
test('download failure and cancellation never overwrite the installed revision', async t => {
  const d = fixture(t), a = file('mods/a.jar', 'old'), calls = [];
  await sync.sync(server, [a], d, { download: downloader({ [a.path]: 'old' }, calls) });
  const oldState = fs.readFileSync(d.state, 'utf8');
  await assert.rejects(sync.sync(server, [file(a.path, 'new')], d, { download: async () => { throw new Error('hash mismatch'); } }), /hash mismatch/);
  const abort = new AbortController();
  await assert.rejects(sync.sync(server, [file(a.path, 'new')], d, { signal: abort.signal, download: async () => { abort.abort(); abort.signal.throwIfAborted(); } }));
  assert.equal(fs.readFileSync(path.join(d.game, a.path), 'utf8'), 'old'); assert.equal(fs.readFileSync(d.state, 'utf8'), oldState);
});
test('an apply failure rolls back all files and the revision', async t => {
  const d = fixture(t), calls = [], a = file('mods/a.jar', 'old-a'), b = file('mods/b.jar', 'old-b');
  await sync.sync(server, [a, b], d, { download: downloader({ [a.path]: 'old-a', [b.path]: 'old-b' }, calls) });
  const original = fs.copyFileSync, state = fs.readFileSync(d.state, 'utf8');
  t.mock.method(fs, 'copyFileSync', (from, to, ...rest) => {
    if (from === path.join(d.transaction, 'new', b.path)) throw new Error('simulated disk failure'); return original(from, to, ...rest);
  });
  await assert.rejects(sync.sync(server, [file(a.path, 'new-a'), file(b.path, 'new-b')], d, { download: downloader({ [a.path]: 'new-a', [b.path]: 'new-b' }, calls) }), /disk failure/);
  assert.equal(fs.readFileSync(path.join(d.game, a.path), 'utf8'), 'old-a'); assert.equal(fs.readFileSync(path.join(d.game, b.path), 'utf8'), 'old-b'); assert.equal(fs.readFileSync(d.state, 'utf8'), state);
});
test('crash journal is recovered before a new update', async t => {
  const d = fixture(t), a = file('mods/a.jar', 'old');
  await sync.sync(server, [a], d, { download: downloader({ [a.path]: 'old' }, []) });
  fs.mkdirSync(path.join(d.transaction, 'backup/mods'), { recursive: true });
  fs.copyFileSync(path.join(d.game, a.path), path.join(d.transaction, 'backup', a.path)); fs.copyFileSync(d.state, path.join(d.transaction, 'previous-state.json'));
  fs.writeFileSync(path.join(d.transaction, 'journal.json'), JSON.stringify({ operations: [{ path: a.path, existed: true }], hadState: true, backupId: require('crypto').randomUUID(), committed: false }));
  fs.writeFileSync(path.join(d.game, a.path), 'interrupted update'); fs.writeFileSync(d.state, '{}');
  sync.recover(d); assert.equal(fs.readFileSync(path.join(d.game, a.path), 'utf8'), 'old'); assert.equal(sync.readState(d).files[0].sha256, a.sha256);
});
test('junctions are refused and server directories are independent', async t => {
  const d = fixture(t), other = catalog.paths(path.dirname(path.dirname(d.root)), 'another-server');
  assert.notEqual(d.game, other.game); fs.mkdirSync(d.game, { recursive: true }); fs.mkdirSync(other.game, { recursive: true });
  fs.symlinkSync(other.game, path.join(d.game, 'mods'), 'junction');
  await assert.rejects(sync.sync(server, [file('mods/a.jar', 'a')], d, { download: downloader({ 'mods/a.jar': 'a' }, []) }), /junction/);
  assert.deepEqual(fs.readdirSync(other.game), []);
});
function varInt(n) { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); }
test('SLP accepts a fragmented response and refuses malformed / oversized responses', async t => {
  let mode = 'valid';
  const tcp = net.createServer(socket => socket.once('data', () => {
    if (mode === 'timeout') return;
    if (mode === 'large') { socket.end(varInt(200000)); return; }
    const bytes = Buffer.from(mode === 'bad' ? '{bad' : JSON.stringify({ players: { online: 3, max: 20 }, version: { name: '1.21.1' } }));
    const payload = Buffer.concat([Buffer.from([0]), varInt(bytes.length), bytes]); const full = Buffer.concat([varInt(payload.length), payload]);
    socket.write(full.subarray(0, 2)); setTimeout(() => socket.end(full.subarray(2)), 10);
  }));
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve)); t.after(() => tcp.close());
  const addr = { host: '127.0.0.1', port: tcp.address().port };
  const valid = await ping(addr); assert.equal(valid.playersOnline, 3); assert.equal(valid.state, 'online');
  for (mode of ['bad', 'large', 'timeout']) assert.equal((await ping(addr, 100)).state, 'unknown');
  assert.equal(iconData('https://evil.test/icon'), null); assert.equal(iconData('data:image/png;base64,YQ=='), null);
});
test('real downloader checks SHA-256 and size before renaming and cleans temporary files', async t => {
  const https = require('https'), { Readable } = require('stream'), { EventEmitter } = require('events'); const d = fixture(t);
  t.mock.method(https, 'get', (_url, _opts, cb) => { const req = new EventEmitter(); req.setTimeout = () => {}; queueMicrotask(() => { const res = Readable.from([Buffer.from('body')]); res.statusCode = 200; cb(res); }); return req; });
  const url = catalog.fileUrl(server, 'mods/a.jar'), dest = path.join(d.root, 'file');
  await remote.file(url, dest, file('mods/a.jar', 'body'));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'body'); fs.unlinkSync(dest);
  for (const f of [file('mods/a.jar', 'fake'), file('mods/a.jar', 'x')]) {
    await assert.rejects(remote.file(url, dest, f)); assert.ok(!fs.existsSync(dest)); assert.ok(!fs.existsSync(dest + '.part'));
  }
});

test('connection timeout retries IPv4 and preserves URL in errors', async t => {
 const https=require('https'),{EventEmitter}=require('events'),{Readable}=require('stream');const families=[];let fail=false;
 t.mock.method(https,'get',(url,opts,cb)=>{const req=new EventEmitter();req.setTimeout=()=>{};families.push(opts.family);queueMicrotask(()=>{if(!opts.family||fail)req.emit('error',Object.assign(new AggregateError([]),{code:'ETIMEDOUT'}));else{const res=Readable.from([Buffer.from('ok')]);res.statusCode=200;cb(res);}});return req;});
 const url=catalog.fileUrl(server);assert.equal((await remote.read(url,{maxBytes:10})).toString(),'ok');assert.deepEqual(families,[undefined,4]);fail=true;await assert.rejects(remote.read(url,{maxBytes:10}),e=>e.message.includes(url));
});
