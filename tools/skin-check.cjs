const {app,nativeImage,BrowserWindow,dialog}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const source=process.argv.includes('--release')?path.join(root,'release',require('../package.json').version,'win-unpacked/resources/app.asar'):root;
const work=fs.mkdtempSync(path.join(require('os').tmpdir(),'moss-skin-check-'));
app.setPath('userData',work);
const report=path.join(root,'build/skin-check.log');fs.writeFileSync(report,'');const log=s=>fs.appendFileSync(report,s+'\n');
const protocol=require(path.join(source,'src/main/protocol'));protocol.registerScheme();
app.whenReady().then(async()=>{
 const skins=require(path.join(source,'src/main/skins'));
 const bitmap=Buffer.alloc(64*64*4);
 for(let y=8;y<16;y++)for(let x=8;x<16;x++){const i=(y*64+x)*4;bitmap[i+2]=255;bitmap[i+3]=255;}
 for(let y=8;y<16;y++){const i=(y*64+40)*4;bitmap[i+1]=255;bitmap[i+3]=255;}
 const png=nativeImage.createFromBitmap(bitmap,{width:64,height:64}).toPNG();
 skins.validateSkin(png);const head=nativeImage.createFromDataURL(skins.headImage(png));assert.deepEqual(head.getSize(),{width:8,height:8});
 const pixels=head.toBitmap();assert.equal(pixels[1],255);assert.equal(pixels[6],255);log('PASS head crop and overlay composition');
 assert.throws(()=>skins.validateSkin(Buffer.from('bad')));
 assert.throws(()=>skins.validateSkin(nativeImage.createFromBitmap(Buffer.alloc(32*32*4),{width:32,height:32}).toPNG()));
 assert.throws(()=>skins.textureUrl('https://example.com/texture/abc'));log('PASS malformed PNG, dimensions and texture host validation');
 const net=require(path.join(source,'src/main/net'));let calls=0;
 const uuid='0123456789abcdef0123456789abcdef';
 const profile={id:uuid,name:'SkinTest',skins:[{state:'ACTIVE',url:'https://textures.minecraft.net/texture/abcdef',variant:'SLIM'}]};
 const origRequest=net.request;
 net.request=async(url,opts)=>{calls++;assert.equal(url,'https://api.minecraftservices.com/minecraft/profile/skins');assert.equal(opts.method,'POST');assert.equal(opts.headers.Authorization,'Bearer test-token');assert.equal(opts.headers['Content-Length'],opts.body.length);assert.ok(opts.body.includes(png));assert.ok(opts.body.includes(Buffer.from('\r\nslim\r\n')));return {status:200,body:Buffer.from(JSON.stringify(profile))};};
 // Reload only skins so its request dependency uses the controlled transport.
 delete require.cache[require.resolve(path.join(source,'src/main/skins'))];
 const fakeSkins=require(path.join(source,'src/main/skins'));
 const account={uuid,username:'SkinTest',type:'microsoft',mcAccessToken:'test-token',mcExpiresAt:Date.now()+3600000,skins:[],avatar:null};
 fs.writeFileSync(path.join(work,'accounts.json'),JSON.stringify({accounts:[account],selected:uuid}));
 const auth=require(path.join(source,'src/main/auth'));
 const result=await auth.changeSkin(uuid,png,'slim');assert.equal(calls,1);assert.equal(result.accounts[0].skins[0].variant,'SLIM');assert.equal(result.accounts[0].mcAccessToken,undefined);
 await assert.rejects(()=>auth.changeSkin(uuid,png,'invalid'));assert.equal(calls,1);log('PASS upload multipart, account update, variant validation, no credentials in result');
 net.request=async()=>({status:429,body:Buffer.from('{}')});delete require.cache[require.resolve(path.join(source,'src/main/skins'))];
 await assert.rejects(()=>require(path.join(source,'src/main/skins')).uploadSkin('test-token',png,'classic'),/Подождите/);log('PASS upload rate-limit error');
 net.request=origRequest;delete require.cache[require.resolve(path.join(source,'src/main/skins'))];

 let queueCalls=0;
 net.request=async(url,opts)=>{
   queueCalls++;assert.equal(opts.headers.Authorization,'Bearer test-api-key');
   if(queueCalls===1){assert.equal(opts.method,'POST');assert.ok(opts.body.includes(Buffer.from('name="file"')));return {status:202,body:Buffer.from(JSON.stringify({job:{id:'fixture',status:'waiting'}}))};}
   if(queueCalls===2){assert.ok(url.endsWith('/queue/fixture'));return {status:200,body:Buffer.from(JSON.stringify({job:{id:'fixture',status:'completed',result:'skin-fixture'}}))};}
   assert.ok(url.endsWith('/skins/skin-fixture'));
   return {status:200,body:Buffer.from(JSON.stringify({skin:{texture:{data:{value:Buffer.from(JSON.stringify({textures:{SKIN:{url:'http://textures.minecraft.net/texture/abcdef'}}})).toString('base64')}}}}))};
 };
 const queuedSkins=require(path.join(source,'src/main/skins'));
 const queued=await queuedSkins.publishOfflineSkin(png,'slim','test-api-key');assert.equal(queueCalls,3);assert.equal(queued.url,'https://textures.minecraft.net/texture/abcdef');
 delete require.cache[require.resolve(path.join(source,'src/main/skins'))];
 net.request=async()=>({status:401,body:Buffer.from('{}')});
 await assert.rejects(()=>require(path.join(source,'src/main/skins')).publishOfflineSkin(png,'classic'),/API-ключ/);
 delete require.cache[require.resolve(path.join(source,'src/main/skins'))];net.request=origRequest;
 log('PASS MineSkin queue polling without duplicate uploads, signed-texture parsing and API-key error');
 // Read only: verify the actual signed-in account texture without uploading or refreshing credentials.
 const accountsFile=path.join(process.env.APPDATA,'mosslauncher/accounts.json');
 if(fs.existsSync(accountsFile)){
   const real=JSON.parse(fs.readFileSync(accountsFile,'utf8')).accounts.find(a=>a.type==='microsoft');
   const url=real?.skins?.find(s=>s.state==='ACTIVE')?.url||real?.avatar;
   if(url){const data=await skins.avatar(url);assert.equal(nativeImage.createFromDataURL(data).getSize().width,8);log('PASS live official-account texture fetched and cropped (read only)');}
 }
 const skinFile=path.join(work,'test.png');fs.writeFileSync(skinFile,png);
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[skinFile]});
 protocol.handle(path.join(source,'src/renderer'),path.join(source,'assets/mosslauncher-complete'));
 const w=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.join(source,'src/preload/preload.js'),sandbox:false,contextIsolation:true,backgroundThrottling:false,offscreen:true}});
 // All UI uploads stay inside the isolated fixture transport.
 const activeSkins=require(path.join(source,'src/main/skins'));activeSkins.avatar=async()=>skins.headImage(png);
 activeSkins.uploadSkin=async(token,buffer,variant)=>{assert.equal(token,'test-token');assert.ok(buffer.equals(png));assert.equal(variant,'slim');return profile;};
 require(path.join(source,'src/main/ipc-handlers')).register(w);
 await w.loadURL('app://launcher/index.html');await new Promise(r=>setTimeout(r,1300));
 await w.webContents.executeJavaScript(`import('./app-state.js').then(({appState})=>appState.navigateTo('accounts'))`);
 await new Promise(r=>setTimeout(r,200));
 assert.equal(await w.webContents.executeJavaScript(`document.querySelector('.skin-head').naturalWidth`),8);
 await w.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Загрузить скин').click();[...document.querySelectorAll('button')].find(b=>b.textContent==='Выбрать PNG').click()`);
 await new Promise(r=>setTimeout(r,250));
 assert.equal(await w.webContents.executeJavaScript(`document.querySelector('.skin-preview__head').naturalWidth`),8);
 await new Promise(r=>setTimeout(r,1500));
 fs.writeFileSync(path.join(root,'build/skin-dialog.png'),(await w.webContents.capturePage()).toPNG());
 await w.webContents.executeJavaScript(`document.querySelector('.modal select').value='slim';[...document.querySelectorAll('button')].find(b=>b.textContent==='Применить к аккаунту').click()`);
 await new Promise(r=>setTimeout(r,500));
 assert.equal(await w.webContents.executeJavaScript(`document.querySelectorAll('.modal').length`),0);
 await w.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent==='SkinsRestorer').click()`);
 assert.equal(await w.webContents.executeJavaScript(`document.querySelector('.modal input').value`),'/skin url "https://textures.minecraft.net/texture/abcdef" slim');
 log('PASS UI head image, file selection, preview, upload IPC and SkinsRestorer command');

 await w.webContents.executeJavaScript("document.querySelectorAll('.scrim').forEach(n=>n.remove())");
 const offline=auth.addOffline('OfflineSkin');
 const officialBefore=JSON.stringify(auth.listAccounts().find(a=>a.uuid===uuid));
 const actualPublisher=activeSkins.publishOfflineSkin;
 activeSkins.publishOfflineSkin=async(buffer,variant)=>{assert.ok(buffer.equals(png));return {url:'https://textures.minecraft.net/texture/abcdef',variant,head:skins.headImage(buffer),uploadedAt:Date.now()};};
 await w.webContents.executeJavaScript(`import('./app-state.js').then(async({appState})=>{const a=await window.moss.accounts.list();appState.update({accounts:a.accounts,selectedAccount:a.selected});appState.navigateTo('accounts')})`);
 await w.webContents.executeJavaScript(`[...document.querySelectorAll('.account-row')].find(r=>r.textContent.includes('OfflineSkin')).querySelectorAll('button')[0].click();[...document.querySelectorAll('button')].find(b=>b.textContent==='Выбрать PNG').click()`);
 await new Promise(r=>setTimeout(r,250));
 assert.ok(await w.webContents.executeJavaScript(`document.querySelector('.modal').textContent.includes('публичной ссылке')`));
 await new Promise(r=>setTimeout(r,600));
 fs.writeFileSync(path.join(root,'build/offline-skin-dialog.png'),(await w.webContents.capturePage()).toPNG());
 await w.webContents.executeJavaScript(`document.querySelector('.modal select').value='slim';[...document.querySelectorAll('button')].find(b=>b.textContent==='Загрузить на MineSkin').click()`);
 await new Promise(r=>setTimeout(r,500));
 assert.equal(await w.webContents.executeJavaScript(`document.querySelector('.modal input').value`),'/skin url "https://textures.minecraft.net/texture/abcdef" slim');
 assert.equal(JSON.stringify(auth.listAccounts().find(a=>a.uuid===uuid)),officialBefore);
 assert.equal(JSON.parse(fs.readFileSync(path.join(work,'accounts.json'))).accounts.find(a=>a.uuid===offline.uuid).offlineSkin.variant,'slim');
 assert.equal(auth.addOffline('OfflineSkin').offlineSkin.variant,'slim');
 activeSkins.publishOfflineSkin=async()=>{throw Error('network unavailable')};
 await assert.rejects(()=>auth.changeSkin(offline.uuid,png,'classic'),/network unavailable/);
 assert.equal(auth.getAccount(offline.uuid).offlineSkin.variant,'slim');
 activeSkins.publishOfflineSkin=actualPublisher;
 log('PASS offline UI upload, public-upload notice, command, persistent avatar; failed upload preserves previous skin; Microsoft untouched');
 if(process.argv.includes('--live-offline')){
   const published=await skins.publishOfflineSkin(png,'classic');
   const downloaded=await origRequest(published.url);
   assert.equal(downloaded.status,200);skins.validateSkin(downloaded.body);
   log('PASS live anonymous MineSkin upload and PNG download (synthetic test skin only)');
 }
 log('COMPLETE (real profile was not changed)');app.exit();
}).catch(e=>{log(e.stack);app.exit(1)});

