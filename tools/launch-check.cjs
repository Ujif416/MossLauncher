const {app}=require('electron');const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),work=path.join(root,'.functional-check');app.setPath('userData',work);
const report=path.join(root,'build/launch-check.log');fs.writeFileSync(report,'');const log=s=>fs.appendFileSync(report,s+'\n');
app.whenReady().then(async()=>{
 const mc=require('../src/main/minecraft'),java=require('../src/main/java'),auth=require('../src/main/auth');
 const j=await java.detectJava(21);if(!j.found)throw new Error('Java missing');
 const settings={...require('../src/main/settings').getSettings(),gameDir:path.join(work,'minecraft'),javaPath:j.found.path,maxRamMb:2048};
 for(const id of ['1.21.1','neoforge-21.1.265']){
   let rendered=false,exit=null,error=null;
   const running=mc.launch(id,settings,auth.addOffline('MossTest'),line=>{log(line.trim());if(line.includes('textures/atlas/gui.png'))rendered=true}).then(r=>exit=r).catch(e=>error=e);
   for(let i=0;i<120 && !rendered && !exit && !error;i++)await new Promise(r=>setTimeout(r,500));
   const alive=mc.runningVersions().includes(id);
   log((rendered&&alive?'PASS ':'FAIL ')+id+' graphics initialized, running='+alive+', rendered='+rendered+(error?' '+error.message:''));
   if(alive)mc.stop(id);await running;
 }
 log('COMPLETE');app.exit();
}).catch(e=>{log(e.stack);app.exit(1)});
