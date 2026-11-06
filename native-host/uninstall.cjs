const {execFileSync}=require('child_process');
if(process.platform==='win32'){for(const key of ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.meldrix.downloadmanager','HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.meldrix.downloadmanager']){try{execFileSync('reg.exe',['DELETE',key,'/f'],{stdio:'inherit'})}catch{}}}
console.log('Meldrix Native Messaging registry entries removed.');
