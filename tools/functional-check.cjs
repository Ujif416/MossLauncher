'use strict';
const { app } = require('electron');
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), crypto = require('crypto'), http = require('http');
const root = path.resolve(__dirname, '..');
const work = path.join(root, '.functional-check');
fs.mkdirSync(work, { recursive: true });
app.setPath('userData', work);
const report = path.join(root, 'build/functional-check.log');
fs.writeFileSync(report, '');
const log = s => fs.appendFileSync(report, s + '\n');
async function check(name, fn) { try { await fn(); log('PASS ' + name); } catch(e) { log('FAIL ' + name + ': ' + e.message); } }
app.whenReady().then(async () => {
  const net = require('../src/main/net'), mc = require('../src/main/minecraft'), mods = require('../src/main/mods');
  const settings = require('../src/main/settings'), auth = require('../src/main/auth'), loaders = require('../src/main/loaders');
  const config = { ...settings.getSettings(), gameDir: path.join(work, 'minecraft') };
  await check('offline create/select/remove and settings save', async () => {
    const a = auth.addOffline('MossTest'); auth.addOffline('MossTest'); assert.equal(auth.listAccounts().filter(x=>x.uuid===a.uuid).length,1);
    auth.selectAccount(a.uuid); assert.equal((await auth.getSelectedAccount()).uuid,a.uuid); auth.removeAccount(a.uuid);
    settings.setSettings({maxRamMb:3072}); assert.equal(settings.getSettings().maxRamMb,3072);
  });
  await check('LWJGL classifier paths are distinct', async () => {
    const entries=mc.libraryEntries({libraries:[{name:'org.lwjgl:lwjgl-freetype:3.3.3',downloads:{artifact:{path:'org/lwjgl/main.jar',url:'https://example.org/a'}}},{name:'org.lwjgl:lwjgl-freetype:3.3.3:natives-windows',downloads:{artifact:{path:'org/lwjgl/native.jar',url:'https://example.org/b'}}}]});
    assert.notEqual(entries.libs[0].rel,entries.libs[1].rel);
    assert.ok(mc.artifactPath({name:'org.lwjgl:lwjgl:3.3.3:natives-windows'}).endsWith('-natives-windows.jar'));
  });
  await check('parallel downloads, hash, truncation, retry, cleanup', async () => {
    const body=Buffer.from('verified library'); let count=0, retries=0;
    const server=http.createServer((req,res)=>{count++;if(req.url==='/retry' && retries++===0){res.writeHead(503);res.end();}else if(req.url==='/bad'){res.writeHead(200,{'Content-Length':100});res.end('short');}else res.end(body);});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try { const url=`http://127.0.0.1:${server.address().port}`; const dest=path.join(work,'library.jar');fs.rmSync(dest,{force:true});
      const sha1=crypto.createHash('sha1').update(body).digest('hex');
      await Promise.all(Array.from({length:16},()=>net.downloadFile(url,dest,{sha1,size:body.length})));assert.equal(count,1);assert.deepEqual(fs.readFileSync(dest),body);
      await assert.rejects(net.downloadFile(url+'/bad',path.join(work,'bad.jar'),{size:100,timeout:1000}));
      await assert.rejects(net.downloadFile(url,path.join(work,'hash.jar'),{sha1:'0'.repeat(40)}));
      const retryDest=path.join(work,'retry.jar');fs.rmSync(retryDest,{force:true});
      const retried=await net.downloadAll([{url:url+'/retry',dest:retryDest,size:body.length}],{retries:1});assert.equal(retried.errors.length,0);assert.equal(retries,2);
      assert.equal(fs.readdirSync(work).filter(f=>f.endsWith('.part')).length,0);
    } finally {server.closeAllConnections();server.close();}
  });
  await check('NeoForge 21.1.266 and 21.1.265 are selectable',async()=>{const versions=await loaders.listLoaderVersions('neoforge','1.21.1');assert.ok(versions.includes('21.1.266'));assert.ok(versions.includes('21.1.265'));});
  for (const loader of ['fabric','quilt','forge']) await check(loader+' compatible version catalog',async()=>{assert.ok((await loaders.listLoaderVersions(loader,'1.21.1')).length);});
  await check('Modrinth pagination and compatibility',async()=>{const q={source:'modrinth',query:'',version:'1.21.1',loader:'neoforge',limit:5};const a=await mods.searchAll({...q,offset:0},config),b=await mods.searchAll({...q,offset:5},config);assert.ok(a.modrinth.hits.length);assert.ok(b.modrinth.hits.length);assert.notEqual(a.modrinth.hits[0].id,b.modrinth.hits[0].id);assert.ok(a.modrinth.hits.every(h=>h.versions.includes('1.21.1')));});
  await check('CurseForge missing key message',async()=>{const r=await mods.searchAll({source:'curseforge'}, {...config,curseforgeApiKey:''});assert.equal(r.curseforge.needsKey,true);});
  await check('local mod toggle and removal',async()=>{const id='neoforge-21.1.266',dir=mods.modsDirFor(config,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'test.jar'),'fixture');mods.toggleMod(config,id,'test.jar',false);assert.equal(mods.listMods(config,id)[0].enabled,false);mods.toggleMod(config,id,'test.jar',true);mods.removeMod(config,id,'test.jar');assert.equal(mods.listMods(config,id).length,0);});
  log('CHECKS COMPLETE'); app.exit();
}).catch(e=>{log(e.stack);app.exit(1)});
