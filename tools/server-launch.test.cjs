'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const spawned = [];
mock.method(require('child_process'), 'spawn', (exe, args, opts) => {
  const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.pid = 100 + spawned.length;
  proc.kill = () => { proc.emit('close', 0); }; spawned.push({ exe, args, opts, proc }); queueMicrotask(() => proc.emit('spawn')); return proc;
});
const mc = require('../src/main/minecraft');
mock.method(require('../src/main/java'), 'detectJava', async () => ({ found: { path: 'fixture-java', major: 21 } }));
test('server launch passes Quick Play once after main class, isolates same-version servers and leaves normal launch unchanged', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-launch-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = '1.21.1', vd = path.join(root, 'versions', id); fs.mkdirSync(vd, { recursive: true });
  fs.writeFileSync(path.join(vd, id + '.json'), JSON.stringify({ id, javaVersion: { majorVersion: 21 }, mainClass: 'fixture.Main', arguments: {
    jvm: ['-cp', '${classpath}'], game: ['--gameDir', '${game_directory}', { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] }],
  }, libraries: [] }));
  const s = { gameDir: root, maxRamMb: 4096 }, account = { username: 'Fixture', uuid: '1', type: 'offline' };
  const p1 = mc.launch(id, s, account, () => {}, { serverId: 'one', instanceDir: path.join(root, 'one'), directConnect: 'createsky.tralala.club' });
  const p2 = mc.launch(id, s, account, () => {}, { serverId: 'two', instanceDir: path.join(root, 'two'), directConnect: '188.127.241.249:25922' });
  await new Promise(setImmediate); assert.equal(spawned.length, 2);
  for (const [i, target] of ['createsky.tralala.club', '188.127.241.249:25922'].entries()) {
    const args = spawned[i].args, pos = args.indexOf('--quickPlayMultiplayer');
    assert.equal(args.filter(x => x === '--quickPlayMultiplayer').length, 1); assert.equal(args[pos + 1], target); assert.ok(pos > args.indexOf('fixture.Main')); assert.ok(!args.some(x => x.includes('${')));
    assert.equal(args[args.indexOf('--gameDir') + 1], spawned[i].opts.cwd);
  }
  assert.notEqual(spawned[0].opts.cwd, spawned[1].opts.cwd); assert.deepEqual(mc.runningVersions(), ['server:one', 'server:two']);
  await assert.rejects(mc.launch(id, s, account, () => {}, { serverId: 'one' }), /уже запущена/);
  mc.stop('server:one'); mc.stop('server:two'); await Promise.all([p1, p2]);
  const normal = mc.launch(id, s, account); await new Promise(setImmediate);
  assert.ok(!spawned[2].args.includes('--quickPlayMultiplayer')); assert.equal(spawned[2].opts.cwd, path.join(root, 'instances', id)); mc.stop(id); await normal;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mc.launch(id, s, account, () => {}, { serverId: 'one', instanceDir: path.join(root, 'one'), directConnect: 'createsky.tralala.club', signal: controller.signal }));
  assert.equal(spawned.length, 3);
});
