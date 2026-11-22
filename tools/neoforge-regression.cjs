const {app}=require('electron');const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),work=path.join(root,'.functional-check');app.setPath('userData',work);
const report=path.join(root,'build/neoforge-regression.log');fs.writeFileSync(report,'');const log=s=>fs.appendFileSync(report,s+'\n');
app.whenReady().then(async()=>{
 const mc=require('../src/main/minecraft'),java=require('../src/main/java'),auth=require('../src/main/auth');
 const j=await java.detectJava(21);if(!j.found)throw Error('Java 21 missing');
 const gameDir=fs.mkdtempSync(path.join(work,'standalone-'));
 for(const dir of ['libraries','assets']){const cache=path.join(work,'minecraft',dir);if(fs.existsSync(cache))fs.symlinkSync(cache,path.join(gameDir,dir),'junction');}
 const settings={gameDir,javaPath:j.found.path,maxRamMb:2048};
 assert.deepEqual(mc.listInstalled(settings),[]);
 const id=await mc.installNeoForge('1.21.1',settings,p=>{if(p.done===0)log('STAGE '+p.stage)},'21.1.265');
 assert.deepEqual(mc.listInstalled(settings),[id]);log('PASS NeoForge installed alone; base Minecraft automatically installed and hidden');
 let rendered=false,exit=null,error=null;
 const running=mc.launch(id,settings,auth.addOffline('MossTest'),line=>{if(line.includes('textures/atlas/gui.png'))rendered=true;if(line.includes('Exception')||line.includes('Error'))log(line)}).then(r=>exit=r).catch(e=>error=e);
 for(let i=0;i<180&&!rendered&&!exit&&!error;i++)await new Promise(r=>setTimeout(r,500));
 const alive=mc.runningVersions().includes(id);if(alive)mc.stop(id);await running;
 assert.ok(rendered&&alive,error?.message||'Game did not initialize graphics: '+JSON.stringify(exit));
 log('PASS standalone NeoForge launched to initialized GUI');log('COMPLETE');app.exit();
}).catch(e=>{log(e.stack);app.exit(1)});
