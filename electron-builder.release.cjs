const {build,version}=require('./package.json');
module.exports={...build, directories:{...build.directories,output:`release/${version}`}, compression:'normal',
 extraResources:[{from:'distribution/THIRD-PARTY-NOTICES.txt',to:'THIRD-PARTY-NOTICES.txt'}],
 nsis:{...build.nsis,artifactName:'MossLauncher-Setup-${version}-${arch}.${ext}',perMachine:false,allowElevation:false,deleteAppDataOnUninstall:false,runAfterFinish:false,differentialPackage:false,useZip:true},
 portable:{artifactName:'MossLauncher-Portable-${version}-${arch}.${ext}',useZip:true}};
