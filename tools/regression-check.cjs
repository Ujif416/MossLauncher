const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const source=process.argv.includes('--release')?path.join(root,'release',require('../package.json').version,'win-unpacked/resources/app.asar'):root;
const report=path.join(root,'build/regression-check.log');fs.writeFileSync(report,'');
const log=s=>fs.appendFileSync(report,s+'\n');
app.setPath('userData',path.join(root,'.smoke-data'));
const protocol=require(path.join(source,'src/main/protocol'));protocol.registerScheme();
app.whenReady().then(async()=>{
const mc=require(path.join(source,'src/main/minecraft'));
const fixture=fs.mkdtempSync(path.join(require('os').tmpdir(),'moss-ready-'));
for(const [id,marker] of [['partial',null],['installing',{installing:true}],['base',{dependency:true}],['ready',{installedAt:1}]]){
 const dir=path.join(fixture,'versions',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id+'.json'),'{}');fs.writeFileSync(path.join(dir,id+'.jar'),'fixture');if(marker)fs.writeFileSync(path.join(dir,'.moss-installed'),JSON.stringify(marker));
}
assert.deepEqual(mc.listInstalled({gameDir:fixture}),['ready']);log('PASS completed installations only; hidden dependencies');
protocol.handle(path.join(source,'src/renderer'),path.join(source,'assets/mosslauncher-complete'));
const w=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{backgroundThrottling:false,preload:path.join(source,'src/preload/preload.js'),sandbox:false,contextIsolation:true}});
require(path.join(source,'src/main/ipc-handlers')).register(w);
await w.loadURL('app://launcher/index.html');await new Promise(r=>setTimeout(r,1500));
const result=await w.webContents.executeJavaScript(`(async()=>{
 const {appState}=await import('./app-state.js');
 const ids=Array.from({length:40},(_,i)=>'neoforge-21.1.'+(260+i));
 appState.update({installedVersions:ids,selectedVersionId:ids[0]});appState.navigateTo('home');
 const update=n=>appState.update({downloads:[{scope:'version',versionId:'1.21.1',stage:'libraries',done:n,total:100}]});
 update(1);const play=document.querySelector('.play'),picker=document.querySelector('.version-pick'),card=document.querySelector('.home__card'),fill=document.querySelector('.progress__fill');
 const before=picker.getBoundingClientRect().top;
 picker.click(); const menu=document.querySelector('.version-menu');
 for(let n=2;n<=100;n++)update(n);
 if(play!==document.querySelector('.play')||picker!==document.querySelector('.version-pick')||card!==document.querySelector('.home__card')||fill!==document.querySelector('.progress__fill'))throw Error('DOM replaced on progress');
 if(before!==picker.getBoundingClientRect().top)throw Error('Picker moved');
 if(!menu.isConnected||menu.querySelectorAll('.popmenu__item').length!==41)throw Error('Long menu truncated/replaced');
 const r=menu.getBoundingClientRect();if(r.bottom>innerHeight||r.top<0)throw Error('Menu outside viewport');
 const hit=document.elementFromPoint(r.left+20,r.top+20);if(!menu.contains(hit))throw Error('Menu covered');
 appState.navigateTo('mods');if(menu.isConnected)throw Error('Menu leaked on unmount');
 let target=document.querySelector('.mods__target select');target.value=ids[1];target.dispatchEvent(new Event('change'));
 if(appState.state.selectedVersionId!==ids[1]||!document.querySelector('.mods__target-path').textContent.includes(ids[1]))throw Error('Mod target not updated');
 return 'PASS stable controls over 100 updates; 40-version menu visible and scrollable; cleanup; mod target switch';
})()`);log(result);
const auth=require(path.join(source,'src/main/auth'));
const login=await auth.beginMicrosoftLogin();assert.ok(login.code.userCode&&login.code.verificationUri);auth.cancelDeviceLogin();
await assert.rejects(login.complete,e=>e.code==='cancelled');log('PASS Microsoft live device code issuance and cancellation (no account sign-in)');
log('COMPLETE');app.exit(0);
}).catch(e=>{log(e.stack);app.exit(1)});
