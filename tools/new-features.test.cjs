'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const jvmPresets = require('../src/main/jvm-presets');
const crashAnalyzer = require('../src/main/crash-analyzer');
const serverChangelog = require('../src/main/server-changelog');
const updater = require('../src/main/updater');
const profileTools = require('../src/main/profile-tools');
const horizon = require('../src/main/horizon');

test('jvm-presets resolves auto/zgc/g1gc/aikar/custom and recommends safe RAM', () => {
  const auto21Heavy = jvmPresets.resolveJvmFlags({ maxRamMb: 8192, jvmPreset: 'auto' }, 21);
  assert.equal(auto21Heavy.effectivePreset, 'zgc');
  assert.ok(auto21Heavy.flags.includes('-XX:+UseZGC'));
  assert.ok(auto21Heavy.flags.includes('-XX:+ZGenerational'));

  const auto21Light = jvmPresets.resolveJvmFlags({ maxRamMb: 4096, jvmPreset: 'auto' }, 21);
  assert.equal(auto21Light.effectivePreset, 'g1gc');
  assert.ok(auto21Light.flags.includes('-XX:+UseG1GC'));

  const zgcOn17 = jvmPresets.resolveJvmFlags({ maxRamMb: 8192, jvmPreset: 'zgc' }, 17);
  assert.equal(zgcOn17.effectivePreset, 'g1gc');
  assert.ok(!zgcOn17.flags.includes('-XX:+UseZGC'));

  const custom = jvmPresets.resolveJvmFlags({ maxRamMb: 4096, jvmPreset: 'custom' }, 21);
  assert.ok(!custom.flags.includes('-XX:+UseG1GC'));
  assert.ok(!custom.flags.includes('-XX:+UseZGC'));

  const rec16 = jvmPresets.recommendRam(16384);
  assert.equal(rec16.standardMb, 6144);
  assert.equal(rec16.heavyModpackMb, 8192);
});

test('crash-analyzer detects OOM, Java version, Mixin, missing mod dep and sanitizes secrets', () => {
  const oom = crashAnalyzer.analyzeLogs(['java.lang.OutOfMemoryError: Java heap space'], { exitCode: 1 });
  assert.equal(oom.detected, true);
  assert.match(oom.title, /OutOfMemoryError/);

  const javaVer = crashAnalyzer.analyzeLogs(['java.lang.UnsupportedClassVersionError: class file version 65.0'], { exitCode: 1 });
  assert.equal(javaVer.detected, true);
  assert.match(javaVer.title, /Java 21/);

  const dep = crashAnalyzer.analyzeLogs(["Mod 'create_skybound' requires 'flywheel' 1.0+"], { exitCode: 1 });
  assert.equal(dep.detected, true);
  assert.ok(dep.culprits.includes('create_skybound'));

  const mixin = crashAnalyzer.analyzeLogs(['org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError in sodium.mixins.json'], { exitCode: 1 });
  assert.equal(mixin.detected, true);
  assert.ok(mixin.culprits.includes('sodium.mixins.json'));

  const clean = crashAnalyzer.sanitizeLog('C:\\Users\\George\\AppData --accessToken secret123 ghp_1234567890abcdef');
  assert.ok(!clean.includes('George'));
  assert.ok(!clean.includes('secret123'));
  assert.ok(!clean.includes('ghp_1234567890abcdef'));
});

test('server-changelog computes mod updates, additions, removals and records history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-changelog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const prev = [
    { path: 'mods/balm-neoforge-1.21.1-21.0.63.jar', sha256: 'aaa' },
    { path: 'mods/old-mod-1.0.jar', sha256: 'bbb' },
    { path: 'config/create.toml', sha256: 'ccc' },
  ];
  const next = [
    { path: 'mods/balm-neoforge-1.21.1-21.0.66.jar', sha256: 'ddd' },
    { path: 'mods/new-mod-2.0.jar', sha256: 'eee' },
    { path: 'config/create.toml', sha256: 'fff' },
  ];
  const diff = serverChangelog.computeDiff(prev, next);
  assert.deepEqual(diff.modsAdded, ['new-mod-2.0.jar']);
  assert.deepEqual(diff.modsRemoved, ['old-mod-1.0.jar']);
  assert.equal(diff.modsUpdated.length, 1);
  assert.equal(diff.modsUpdated[0].from, 'balm-neoforge-1.21.1-21.0.63.jar');
  assert.equal(diff.modsUpdated[0].to, 'balm-neoforge-1.21.1-21.0.66.jar');
  assert.equal(diff.configsCount, 1);

  serverChangelog.recordEntry(dir, { fromRevision: 'r1', toRevision: 'r2', syncedAt: 1000, diff });
  const hist = serverChangelog.readHistory(dir);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].toRevision, 'r2');
});

test('updater normalizes repo, compares semver, picks assets and parses SHA256SUMS', () => {
  assert.equal(updater.normalizeRepo('https://github.com/Ujif416/MossLauncher.git'), 'Ujif416/MossLauncher');
  assert.equal(updater.normalizeRepo('Ujif416/MossLauncher'), 'Ujif416/MossLauncher');
  assert.equal(updater.isNewerVersion('1.0.13', '1.0.12'), true);
  assert.equal(updater.isNewerVersion('1.0.12', '1.0.12'), false);
  assert.equal(updater.isNewerVersion('1.0.11', '1.0.12'), false);

  const assets = [
    { name: 'MossLauncher-Setup-1.0.13-x64.exe', browser_download_url: 'https://example/setup.exe' },
    { name: 'MossLauncher-Portable-1.0.13-x64.exe', browser_download_url: 'https://example/portable.exe' },
  ];
  assert.equal(updater.pickReleaseAsset(assets, false).name, 'MossLauncher-Setup-1.0.13-x64.exe');
  assert.equal(updater.pickReleaseAsset(assets, true).name, 'MossLauncher-Portable-1.0.13-x64.exe');

  const sha = 'a'.repeat(64);
  const parsed = updater.parseChecksumForFile(`${sha}  MossLauncher-Setup-1.0.13-x64.exe\n`, 'MossLauncher-Setup-1.0.13-x64.exe');
  assert.equal(parsed, sha);
});

test('profile-tools discovers profiles, syncs options.txt with backup, and lists screenshots safely', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const instA = path.join(root, 'instances', '1.21.1');
  const srvGame = path.join(root, 'servers', 'create-skybound', 'game');
  fs.mkdirSync(path.join(instA, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(srvGame, 'screenshots'), { recursive: true });

  fs.writeFileSync(path.join(instA, 'options.txt'), 'fov:0.5\nkey_key.jump:key.keyboard.space\nlang:ru_ru\ncustomModKey:1\n');
  fs.writeFileSync(path.join(srvGame, 'options.txt'), 'fov:0.0\nlang:en_us\nserverOnlyKey:42\n');
  fs.writeFileSync(path.join(srvGame, 'screenshots', '2026-11-22_14.00.00.png'), Buffer.from([137, 80, 78, 71]));

  const settings = { gameDir: root };
  const profiles = profileTools.listProfiles(settings);
  assert.equal(profiles.length, 2);

  const res = profileTools.syncOptions(settings, {
    sourceId: 'instance:1.21.1',
    targetIds: ['server:create-skybound'],
    categories: ['video', 'language'],
  });
  assert.equal(res.updated.length, 1);
  assert.ok(fs.existsSync(path.join(srvGame, 'options.txt.bak')));

  const merged = profileTools.parseOptions(fs.readFileSync(path.join(srvGame, 'options.txt'), 'utf8'));
  assert.equal(merged.get('fov'), '0.5');
  assert.equal(merged.get('lang'), 'ru_ru');
  assert.equal(merged.get('serverOnlyKey'), '42');
  assert.equal(merged.has('customModKey'), false);

  const shots = profileTools.listScreenshots(settings, 'all');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].profileId, 'server:create-skybound');
  assert.ok(profileTools.resolveSafeScreenshot(settings, shots[0].relPath).endsWith('2026-11-22_14.00.00.png'));
  assert.throws(() => profileTools.resolveSafeScreenshot(settings, '../../evil.png'), /Недопустимый путь/);
});

test('horizon parses SHA256SUMS, lists installed builds and rejects unsafe tags', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-horizon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sha = 'b'.repeat(64);
  assert.equal(horizon.parseSha256Sums(`${sha}  horizon-windows-x64.zip\n`, 'horizon-windows-x64.zip'), sha);

  const vdir = path.join(root, 'horizon', 'versions', 'nightly');
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 'horizon-client.exe'), 'stub');
  fs.writeFileSync(path.join(vdir, 'horizon-prepare.exe'), 'stub');

  const installed = horizon.listInstalled({ gameDir: root });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].tag, 'nightly');
  assert.ok(installed[0].clientExe.endsWith('horizon-client.exe'));
  assert.throws(() => horizon.removeVersion('../evil', { gameDir: root }), /Некорректный тег/);
});
