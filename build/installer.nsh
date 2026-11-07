; Register browser-specific Native Messaging manifests for Chrome and Edge.
!macro customInstall
  CreateDirectory "$APPDATA\meldrix-download-manager"
  Push $0
  FileOpen $0 "$APPDATA\meldrix-download-manager\chrome-host.json" w
  FileWrite $0 '{"name":"com.meldrix.downloadmanager","description":"Meldrix Download Manager native messaging host","path":"$INSTDIR/resources/native-host/MeldrixNativeHost.exe","type":"stdio","allowed_origins":["chrome-extension://lhnjhjehjjocnjjfgnpliffgochpgikk/"]}'
  FileClose $0
  FileOpen $0 "$APPDATA\meldrix-download-manager\edge-host.json" w
  FileWrite $0 '{"name":"com.meldrix.downloadmanager","description":"Meldrix Download Manager native messaging host","path":"$INSTDIR/resources/native-host/MeldrixNativeHost.exe","type":"stdio","allowed_origins":["chrome-extension://lhnjhjehjjocnjjfgnpliffgochpgikk/"]}'
  FileClose $0
  Pop $0
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.meldrix.downloadmanager" "" "$APPDATA\meldrix-download-manager\chrome-host.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.meldrix.downloadmanager" "" "$APPDATA\meldrix-download-manager\edge-host.json"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.meldrix.downloadmanager"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.meldrix.downloadmanager"
  Delete "$APPDATA\meldrix-download-manager\chrome-host.json"
  Delete "$APPDATA\meldrix-download-manager\edge-host.json"
  Delete "$APPDATA\meldrix-download-manager\com.meldrix.downloadmanager-chrome.json"
  Delete "$APPDATA\meldrix-download-manager\com.meldrix.downloadmanager-edge.json"
  RMDir /r "$APPDATA\meldrix-download-manager\native-host"
!macroend
