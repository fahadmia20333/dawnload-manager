const fs=require('fs');const path=require('path');const {execFileSync}=require('child_process');
const dir=__dirname;const root=path.dirname(dir);const config=path.join(dir,'sea-config.json');const blob=path.join(dir,'meldrix-native.blob');const out=path.join(dir,'MeldrixNativeHost.exe');
fs.writeFileSync(config,JSON.stringify({main:path.join(dir,'host.cjs'),output:blob,disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false}));
execFileSync(process.execPath,['--experimental-sea-config',config],{stdio:'inherit'});fs.copyFileSync(process.execPath,out);
const postject=path.join(root,'node_modules','postject','dist','cli.js');const fuse='NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';execFileSync(process.execPath,[postject,out,'NODE_SEA_BLOB',blob,'--sentinel-fuse',fuse],{stdio:'inherit'});fs.rmSync(blob,{force:true});console.log(`Built ${out}`);
