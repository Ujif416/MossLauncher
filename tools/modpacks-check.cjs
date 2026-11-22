'use strict';
// Isolated regression check: local HTTP fixtures, real IPC and renderer, no user data.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const http = require('http'), crypto = require('crypto');
const AdmZip = require('adm-zip');
const root = path.resolve(__dirname, '..');
const source = process.argv.includes('--release')
  ? path.join(root, 'release', require('../package.json').version, 'win-unpacked/resources/app.asar') : root;
const fixture = fs.mkdtempSync(path.join(root, 'build', 'modpacks-check-'));
app.setPath('userData', path.join(fixture, 'user-data'));
const report = path.join(root, 'build', process.argv.includes('--release') ? 'modpacks-release-check.log' : 'modpacks-check.log');
fs.writeFileSync(report, '');
const log = message => fs.appendFileSync(report, message + '\n');
const protocol = require(path.join(source, 'src/main/protocol'));
protocol.registerScheme();
const load = file => require(path.join(source, 'src', file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function zip(entries) {
  const archive = new AdmZip();
  for (const [name, bytes] of Object.entries(entries)) archive.addFile(name, Buffer.from(bytes));
  return archive.toBuffer();
}
app.whenReady().then(async () => {
  const { API, PATHS, EVENTS } = load('shared/constants');
  const net = load('main/net');
  const mod = Buffer.from('test mod file');
  const hash = crypto.createHash('sha1').update(mod).digest('hex');
  let base;
  const payload = Buffer.alloc(32000, 7);
  const archives = {};
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/known' }); res.end(); return; }
    if (req.url === '/abort') { res.writeHead(200, { 'Content-Length': 100000 }); res.write(payload); setTimeout(() => res.destroy(), 50); return; }
    const bytes = archives[req.url] || payload;
    res.writeHead(200, req.url === '/unknown' ? {} : { 'Content-Length': bytes.length });
    if (req.method === 'HEAD') { res.end(); return; }
    for (let offset = 0; offset < bytes.length; offset += Math.ceil(bytes.length / 8)) {
      if (res.destroyed) return;
      res.write(bytes.subarray(offset, offset + Math.ceil(bytes.length / 8)));
      await sleep(40);
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const download = net.downloadFile;
  for (const endpoint of ['known', 'unknown', 'redirect']) {
    const progress = [];
    await download(`${base}/${endpoint}`, path.join(fixture, endpoint), { onProgress: p => progress.push(p) });
    assert.ok(progress.length >= 3);
    assert.equal(progress.at(-1).done, payload.length);
    assert.equal(progress.at(-1).total, endpoint === 'unknown' ? 0 : payload.length);
    assert.ok(progress.every((p, i) => i === 0 || p.done >= progress[i - 1].done));
  }
  const before = requests;
  const dest = path.join(fixture, 'shared');
  await Promise.all(Array.from({ length: 12 }, () => download(`${base}/known`, dest)));
  assert.equal(requests - before, 1);
  await assert.rejects(download(`${base}/abort`, path.join(fixture, 'broken'), { onProgress() {} }));
  await assert.rejects(download(`${base}/known`, path.join(fixture, 'bad-hash'), { sha1: 'bad' }));
  assert.ok(!fs.readdirSync(fixture).some(name => name.endsWith('.part')));
  log('PASS download bytes: known/unknown size, redirect, throttled events; concurrent destination, aborted stream and hash cleanup');

  archives['/owner/pack/zip/refs/heads/main'] = zip({ 'pack-main/mods/GitHub.jar': mod, 'pack-main/config/test.txt': 'config' });
  archives['/cf.zip'] = zip({ 'manifest.json': JSON.stringify({ files: [{ projectID: 5, fileID: 1234 }], minecraft: { version: '1.21.1' } }), 'overrides/config/test.txt': 'config' });
  archives['/mr.zip'] = zip({ 'modrinth.index.json': JSON.stringify({ files: [{ path: 'mods/Modrinth.jar', downloads: [base + '/mod.jar'], hashes: { sha1: hash } }], dependencies: { minecraft: '1.21.1' } }), 'overrides/config/test.txt': 'config' });
  archives['/mod.jar'] = mod;
  API.githubCodeload = base;
  net.downloadFile = (url, file, opts) => download(url.startsWith('https://edge.forgecdn.net/')
    ? base + (url.endsWith('cf.zip') ? '/cf.zip' : '/mod.jar') : url, file, opts);
  net.fetchJson = async url => {
    if (url.includes('/minecraft/modpacks/')) return { title: 'CF', id: 1, files: [{ id: 1000, name: 'cf.zip', type: 'release', filesize: archives['/cf.zip'].length }] };
    if (url === API.cfwidget + '/5') return { files: [{ id: 1234, name: 'CurseForge.jar' }] };
    if (url.endsWith('/project/test/version')) return [{ id: 'v1', version_number: '1', game_versions: ['1.21.1'], files: [{ url: base + '/mr.zip', filename: 'test.mrpack', size: archives['/mr.zip'].length }] }];
    if (url.endsWith('/project/test')) return { title: 'MR', id: 'test', slug: 'test' };
    if (url.includes('version_manifest')) return { versions: [] };
    throw new Error('Unexpected external request in isolated test: ' + url);
  };
  const packSync = load('main/modpack-sync');
  const settings = { gameDir: path.join(fixture, 'game') };
  for (const [input, name] of [['owner/pack', 'GH'], ['cf:test', 'CF'], ['mr:test', 'MR']]) {
    const progress = [];
    await packSync.syncModpack(input, { settings, targetName: name, onProgress: p => progress.push(p) });
    assert.ok(progress.some(p => p.stage === 'download' && p.done > 0 && p.unit === 'bytes'));
    assert.ok(progress.some(p => p.stage === 'sync' && p.done === 2 && p.total === 2));
    if (name !== 'GH') assert.ok(progress.some(p => p.stage === 'mods' && p.done === 1 && p.total === 1));
    assert.equal(progress.at(-1).stage, 'done');
    assert.equal(packSync.listPackMods(settings, name).length, 1);
  }
  log('PASS GitHub, CurseForge and Modrinth fixtures: archive bytes, file counts, final sync and actual mod listing');
  const modsDir = path.join(settings.gameDir, 'modpacks/GH/mods');
  fs.writeFileSync(path.join(modsDir, 'Disabled.jar.disabled'), mod);
  fs.writeFileSync(path.join(modsDir, 'README.txt'), 'not a mod');
  fs.mkdirSync(path.join(modsDir, 'directory.jar'));
  for (let i = 0; i < 160; i++) fs.writeFileSync(path.join(modsDir, `Local-${i}.jar`), mod);
  assert.equal(packSync.listPackMods(settings, 'GH').length, 162);
  assert.equal(packSync.listPackMods(settings, 'GH').find(m => m.file === 'Disabled.jar.disabled').enabled, false);
  for (const name of ['..', '../GH', 'GH/mods', 'C:\\', 'missing']) assert.throws(() => packSync.listPackMods(settings, name));
  const empty = path.join(settings.gameDir, 'modpacks/Empty');
  fs.mkdirSync(empty, { recursive: true }); fs.writeFileSync(path.join(empty, '.moss-pack.json'), '{}');
  assert.deepEqual(packSync.listPackMods(settings, 'Empty'), []);
  log('PASS pack list reads local JARs, disabled files, ignores directories/non-mods, rejects invalid names; empty pack');

  load('main/settings').setSettings(settings);
  protocol.handle(path.join(source, 'src/renderer'), path.join(source, 'assets/mosslauncher-complete'));
  const w = new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(source, 'src/preload/preload.js'), sandbox: false, contextIsolation: true } });
  load('main/ipc-handlers').register(w);
  await w.loadURL('app://launcher/index.html');
  const js = code => w.webContents.executeJavaScript(code);
  const screenshot = async name => {
    // Wake the hidden surface before waiting for CSS transitions and its next paint.
    await w.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await sleep(600);
    fs.writeFileSync(path.join(root, 'build', name), (await w.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  const waitFor = async code => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(50); } throw new Error('UI timeout: ' + code); };
  await waitFor(`!!document.querySelector('.home')`);
  await js(`import('./app-state.js').then(({appState})=>{window.testState=appState;appState.navigateTo('modpacks')})`);
  await waitFor(`document.querySelectorAll('.pack-card').length === 4`);
  await js(`testState.update({syncProgress:{stage:'download',done:1,total:100,unit:'bytes',message:'Скачивание…'}})`);
  // Let the existing 420 ms page entrance finish before measuring geometry.
  await sleep(700);
  await js(`window.packRefs = {card:document.querySelector('.pack-card'),buttons:[...document.querySelectorAll('.content button')],bar:document.querySelector('.pack-progress .progress'),fill:document.querySelector('.pack-progress .progress__fill')}; packRefs.buttons[1].focus(); window.focused=document.activeElement; window.rects=packRefs.buttons.map(b=>JSON.stringify(b.getBoundingClientRect().toJSON())); window.buttonAnimations=0; document.querySelector('.content').addEventListener('animationstart',e=>{if(e.target.closest('.pack-card') || e.target.closest('button'))window.buttonAnimations++})`);
  for (let i = 1; i <= 100; i++) w.webContents.send(EVENTS.SYNC_PROGRESS, { stage: 'download', done: i, total: 100, unit: 'bytes', message: i % 2 ? 'Скачивание…' : 'Очень длинное название сборки '.repeat(15) });
  await waitFor(`document.querySelector('.pack-progress .progress').getAttribute('aria-valuenow')==='100'`);
  assert.equal(await js(`packRefs.card===document.querySelector('.pack-card') && packRefs.bar===document.querySelector('.pack-progress .progress') && packRefs.fill===document.querySelector('.pack-progress .progress__fill') && packRefs.buttons.every((b,i)=>b===document.querySelectorAll('.content button')[i] && rects[i]===JSON.stringify(b.getBoundingClientRect().toJSON())) && document.activeElement===focused && buttonAnimations===0`), true);
  w.webContents.send(EVENTS.SYNC_PROGRESS, { stage: 'download', done: 10485760, total: 0, unit: 'bytes', message: 'Скачивание архива…' });
  await waitFor(`document.querySelector('.pack-progress .progress--indeterminate') && document.querySelector('.pack-progress__count').textContent.includes('МБ')`);
  assert.equal(await js(`document.querySelector('.pack-progress .progress').hasAttribute('aria-valuenow')`), false);
  for (const p of [{ stage: 'extract', message: 'Распаковка…' }, { stage: 'mods', done: 4, total: 10, message: 'Скачивание модов…' }, { stage: 'sync', done: 3, total: 6, message: 'Копирование файлов…' }]) w.webContents.send(EVENTS.SYNC_PROGRESS, p);
  await waitFor(`document.querySelector('.pack-progress .progress').getAttribute('aria-valuenow')==='50'`);
  assert.equal(await js(`packRefs.buttons.every((b,i)=>b===document.querySelectorAll('.content button')[i] && rects[i]===JSON.stringify(b.getBoundingClientRect().toJSON()))`), true);
  await screenshot('modpacks-progress.png');
  log('PASS real IPC: 100 progress updates and stage changes preserve all buttons, DOM, geometry, focus and animations; unknown-size activity + bytes');
  await js(`[...document.querySelectorAll('.pack-card')].find(c=>c.querySelector('.pack-card__title').textContent.includes('GH')).querySelector('button').click()`);
  await waitFor(`document.querySelectorAll('.pack-mods__item').length===162`);
  assert.equal(await js(`document.querySelector('.pack-mods__list').scrollHeight > document.querySelector('.pack-mods__list').clientHeight`), true);
  await js(`window.modSearch=document.querySelector('.pack-mods input'); modSearch.value='DISABLED';modSearch.dispatchEvent(new Event('input'));modSearch.focus()`);
  assert.equal(await js(`document.querySelectorAll('.pack-mods__item').length===1 && document.querySelector('.pack-mods__item').textContent.includes('Отключён')`), true);
  for (let i = 0; i < 100; i++) w.webContents.send(EVENTS.SYNC_PROGRESS, { stage: 'mods', done: i, total: 100 });
  await sleep(200);
  assert.equal(await js(`modSearch===document.querySelector('.pack-mods input') && document.activeElement===modSearch && modSearch.value==='DISABLED' && document.querySelectorAll('.pack-mods__item').length===1`), true);
  await js(`modSearch.value='';modSearch.dispatchEvent(new Event('input'))`);
  await screenshot('modpacks-mods.png');
  await js(`testState.navigateTo('home')`);
  assert.equal(await js(`!!document.querySelector('.pack-mods')`), false);
  await js(`testState.navigateTo('modpacks')`);
  assert.equal(await js(`document.querySelector('.pack-progress .progress').getAttribute('aria-valuenow')`), '99');
  await js(`testState.update({syncProgress:{stage:'done'}})`);
  assert.equal(await js(`document.querySelector('.pack-progress .progress').getAttribute('aria-valuenow')`), '100');
  await js(`testState.update({syncProgress:null})`);
  assert.equal(await js(`document.querySelector('.pack-progress').parentElement.hidden`), true);
  await js(`[...document.querySelectorAll('.pack-card')].find(c=>c.querySelector('.pack-card__title').textContent.includes('Empty')).querySelector('button').click()`);
  await waitFor(`document.querySelector('.pack-mods')?.textContent.includes('нет модов')`);
  log('PASS mod dialog: actual IPC, 162 files, scroll, case-insensitive search, disabled status, preserved focus/filter during download, unmount, empty pack, progress restored on navigation and cleared');
  await js(`testState.navigateTo('home')`);
  await js(`window.homeRefs=[document.querySelector('.play'),document.querySelector('.version-pick'),document.querySelector('.home__card')]; for(let i=0;i<100;i++)testState.update({syncProgress:{stage:'download',done:i,total:100}})`);
  assert.equal(await js(`homeRefs.every(e=>e && e.isConnected)`), true);
  log('PASS existing home controls remain connected during pack progress');
  server.close(); w.destroy(); log('COMPLETE'); app.exit(0);
}).catch(error => { log(error.stack); app.exit(1); });
