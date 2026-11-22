const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureLauncherProfile, installerProfileId } = require('../src/main/loader-installer');
const AdmZip = require('adm-zip');
const { prepareInstance, splitJvmArgs } = require('../src/main/game-instance');
test('instance mods respect enabled files and preserve unmanaged files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-instance-'));
  const source = path.join(root, 'mods', 'test'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'enabled.jar'), 'a');
  fs.writeFileSync(path.join(source, 'off.jar.disabled'), 'b');
  const instance = prepareInstance(root, 'test');
  assert.ok(fs.existsSync(path.join(instance, 'mods/enabled.jar')));
  assert.ok(!fs.existsSync(path.join(instance, 'mods/off.jar.disabled')));
  fs.writeFileSync(path.join(instance, 'mods/manual.jar'), 'c');
  fs.renameSync(path.join(source, 'enabled.jar'), path.join(source, 'enabled.jar.disabled'));
  prepareInstance(root, 'test');
  assert.ok(!fs.existsSync(path.join(instance, 'mods/enabled.jar')));
  assert.ok(fs.existsSync(path.join(instance, 'mods/manual.jar')));
  assert.deepEqual(splitJvmArgs('-Dname="with spaces" -Xss2M'), ['-Dname=with spaces', '-Xss2M']);
});

test('fresh directory is accepted by Forge-family profile precondition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-profile-'));
  const file = ensureLauncherProfile(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).profiles, {});
});
test('existing profile is preserved byte for byte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-profile-'));
  const file = path.join(root, 'launcher_profiles.json');
  const original = '{"profiles":{"personal":{"name":"My world"}},"settings":{"keep":true}}';
  fs.writeFileSync(file, original);
  ensureLauncherProfile(root);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('malformed profile is reported without replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-profile-'));
  const file = path.join(root, 'launcher_profiles.json');
  fs.writeFileSync(file, 'broken');
  assert.throws(() => ensureLauncherProfile(root));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
test('profile selection uses installer metadata, not other installed versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-profile-'));
  const jar = path.join(root, 'installer.jar');
  const zip = new AdmZip();
  zip.addFile('version.json', Buffer.from(JSON.stringify({ id: 'neoforge-21.1.266' })));
  zip.writeZip(jar);
  assert.equal(installerProfileId(jar), 'neoforge-21.1.266');
});

test('maven coordinates map to library paths', () => {
  const { mavenPath } = require('../src/main/loader-installer');
  assert.equal(mavenPath('[net.neoforged:neoforge:21.1.259:client]'), 'net/neoforged/neoforge/21.1.259/neoforge-21.1.259-client.jar');
  assert.equal(mavenPath('[net.neoforged:neoform:1.21.1-20240808.144430@zip]'), 'net/neoforged/neoform/1.21.1-20240808.144430/neoform-1.21.1-20240808.144430.zip');
});
test('installer artifacts expose downloadable libraries and patched client', () => {
  const { installerArtifacts } = require('../src/main/loader-installer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-artifacts-'));
  const lib = (name, p, url) => ({ name, downloads: { artifact: { path: p, url, sha1: 'x', size: 1 } } });
  const zip = new AdmZip();
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify({
    data: { PATCHED: { client: '[net.neoforged:neoforge:1.0:client]', server: '[x:y:1:server]' } },
    libraries: [lib('a:b:1', 'a/b/1/b-1.jar', 'https://maven.neoforged.net/releases/a/b/1/b-1.jar'), lib('gen:c:1', 'gen/c/1/c-1.jar', '')],
  })));
  zip.addFile('version.json', Buffer.from(JSON.stringify({ id: 'neoforge-1.0', libraries: [lib('a:b:1', 'a/b/1/b-1.jar', 'https://maven.neoforged.net/releases/a/b/1/b-1.jar')] })));
  const file = path.join(root, 'installer.jar'); zip.writeZip(file);
  const res = installerArtifacts(file);
  assert.deepEqual(res.libraries.map((l) => l.rel), ['a/b/1/b-1.jar']);
  assert.equal(res.patched, 'net/neoforged/neoforge/1.0/neoforge-1.0-client.jar');
});
test('neoforged maven falls back to mirrors', () => {
  const { candidateUrls } = require('../src/main/net');
  const urls = candidateUrls('https://maven.neoforged.net/releases/net/neoforged/x/1/x-1.jar');
  assert.equal(urls[0], 'https://maven.neoforged.net/releases/net/neoforged/x/1/x-1.jar');
  assert.ok(urls.includes('https://neoforged.forgecdn.net/releases/net/neoforged/x/1/x-1.jar'));
  assert.ok(urls.includes('https://maven.creeperhost.net/net/neoforged/x/1/x-1.jar'));
  assert.deepEqual(candidateUrls('https://libraries.minecraft.net/a.jar'), ['https://libraries.minecraft.net/a.jar']);
});
test('launch guard detects missing patched client only for bootstrap launcher', () => {
  const mc = require('../src/main/minecraft');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-guard-'));
  const dirs = mc.gameDirs({ gameDir: root });
  const v = { mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', arguments: { game: ['--fml.neoForgeVersion', '21.1.259'] } };
  assert.equal(mc.missingPatchedClient(v, dirs), 'net/neoforged/neoforge/21.1.259/neoforge-21.1.259-client.jar');
  const jar = path.join(dirs.libraries, 'net/neoforged/neoforge/21.1.259/neoforge-21.1.259-client.jar');
  fs.mkdirSync(path.dirname(jar), { recursive: true }); fs.writeFileSync(jar, 'x');
  assert.equal(mc.missingPatchedClient(v, dirs), null);
  assert.equal(mc.missingPatchedClient({ mainClass: 'net.minecraft.client.main.Main' }, dirs), null);
});
