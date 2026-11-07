const fs=require('fs');const path=require('path');const os=require('os');const {execFileSync}=require('child_process');
const root=__dirname;
const template=JSON.parse(fs.readFileSync(path.join(root,'com.meldrix.downloadmanager.json'),'utf8'));
const origins=JSON.parse(fs.readFileSync(path.join(root,'extension-origins.json'),'utf8'));
const exe=process.env.MELDRIX_NATIVE_HOST_EXE||path.join(root,'MeldrixNativeHost.exe');
const browsers={
  chrome:{registry:'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.meldrix.downloadmanager',manifest:path.join(root,'com.meldrix.downloadmanager.chrome.json')},
  edge:{registry:'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.meldrix.downloadmanager',manifest:path.join(root,'com.meldrix.downloadmanager.edge.json')}
};
for(const [browser,values] of Object.entries(browsers)){
  const manifest={...template,path:exe,allowed_origins:[`chrome-extension://${origins[browser]}/`]};
  fs.writeFileSync(values.manifest,JSON.stringify(manifest,null,2));
  if(process.platform==='win32')execFileSync('reg.exe',['ADD',values.registry,'/ve','/t','REG_SZ','/d',values.manifest,'/f'],{stdio:'inherit'});
}
console.log(`Native Messaging host manifests written for Chrome and Edge in ${root}`);
