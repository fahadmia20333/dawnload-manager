; Register the Meldrix Native Messaging host for Chrome and Edge at install time.
; The desktop app rewrites this manifest to a stable per-user copy on first launch,
; which also keeps portable builds working after their temporary folder disappears.
!macro customInstall
  CreateDirectory "$APPDATA\meldrix-download-manager"
  Push $0
  FileOpen $0 "$APPDATA\meldrix-download-manager\com.meldrix.downloadmanager.json" w
  FileWrite $0 '{"name":"com.meldrix.downloadmanager","description":"Meldrix Download Manager native messaging host","path":"$INSTDIR/resources/native-host/MeldrixNativeHost.exe","type":"stdio","allowed_origins":["chrome-extension://lhnjhjehjjocnjjfgnpliffgochpgikk/"]}'
  FileClose $0
  Pop $0
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.meldrix.downloadmanager" "" "$APPDATA\meldrix-download-manager\com.meldrix.downloadmanager.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.meldrix.downloadmanager" "" "$APPDATA\meldrix-download-manager\com.meldrix.downloadmanager.json"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.meldrix.downloadmanager"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.meldrix.downloadmanager"
  Delete "$APPDATA\meldrix-download-manager\com.meldrix.downloadmanager.json"
  RMDir /r "$APPDATA\meldrix-download-manager\native-host"
!macroend
