'use strict';
const {app}=require('electron');const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),work=path.join(root,'.functional-check');app.setPath('userData',work);
const log=s=>fs.appendFileSync(path.join(root,'build/install-check.log'),s+'\n');fs.writeFileSync(path.join(root,'build/install-check.log'),'');
app.whenReady().then(async()=>{
 const java=require('../src/main/java'),mc=require('../src/main/minecraft'),auth=require('../src/main/auth'),gh=require('../src/main/github-sync'),mods=require('../src/main/mods');
 const s={...require('../src/main/settings').getSettings(),gameDir:path.join(work,'minecraft'),maxRamMb:2048};
 const test=async(name,fn)=>{try{const r=await fn();log('PASS '+name);return r}catch(e){log('FAIL '+name+': '+e.stack);return null}};
 const j=await test('Java 21 detection',async()=>{const result=await java.detectJava(21);return result.found || await java.installJava(21,()=>{});}); if(j)s.javaPath=j.path;
 const id=await test('NeoForge 21.1.265 installation',()=>mc.installNeoForge('1.21.1',s,p=>{if(p.done===p.total)log('STAGE '+p.stage)},'21.1.265'));
 if(id){await test('Minecraft starts and stays running 45 seconds',async()=>{const account=auth.addOffline('MossTest');let ended=false;const running=mc.launch(id,s,account,d=>log(d.trim())).then(r=>{ended=true;return r});await new Promise(r=>setTimeout(r,45000));if(ended)throw new Error('Game exited before observation completed');mc.stop(id);await running;});}
 await test('Modrinth mod install/remove',async()=>{const r=await mods.searchAll({source:'modrinth',query:'sodium',version:'1.21.1',loader:'neoforge'},s);const hit=r.modrinth.hits[0];if(!hit)throw new Error(r.modrinth.error||'No compatible result');await mods.install('modrinth',hit.id,{settings:s,loader:'neoforge',mcVersion:'1.21.1',versionId:id||'neoforge-21.1.265'});const all=mods.listMods(s,id||'neoforge-21.1.265');if(!all.length)throw new Error('Missing installed mod');mods.removeMod(s,id||'neoforge-21.1.265',all[0].file);});
 await test('GitHub sync/update/remove',async()=>{await gh.syncRepo({repo:'octocat/Hello-World',branch:'master',targetName:'verification',settings:s});await gh.syncRepo({repo:'octocat/Hello-World',branch:'master',targetName:'verification',settings:s});gh.removePack(s,'verification');});
 log('COMPLETE');app.exit();
}).catch(e=>{log(e.stack);app.exit(1)});
