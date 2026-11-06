const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('meldrix', {
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  addDownload: (input) => ipcRenderer.invoke('downloads:add', input),
  inspectDownload: (url) => ipcRenderer.invoke('downloads:inspect', url),
  pauseDownload: (id) => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('downloads:resume', id),
  cancelDownload: (id) => ipcRenderer.invoke('downloads:cancel', id),
  deleteDownloads: (ids) => ipcRenderer.invoke('downloads:delete-many', ids),
  openDownloadFile: (id) => ipcRenderer.invoke('downloads:open-file', id),
  openTaskFolder: (id) => ipcRenderer.invoke('downloads:open-task-folder', id),
  startQueue: () => ipcRenderer.invoke('downloads:start-queue'),
  stopQueue: () => ipcRenderer.invoke('downloads:stop-queue'),
  pendingReview: () => ipcRenderer.invoke('downloads:pending-review'),
  dismissReview: (id) => ipcRenderer.invoke('downloads:dismiss-review', id),
  openDownloadFolder: () => ipcRenderer.invoke('downloads:open-folder'),
  openExternal: (url) => ipcRenderer.invoke('browser:open-external', url),
  openExtensionFolder: () => ipcRenderer.invoke('browser:open-extension-folder'),
  openReadme: () => ipcRenderer.invoke('help:open-readme'),
  showAbout: () => ipcRenderer.invoke('help:about'),
  showUpdateInfo: () => ipcRenderer.invoke('help:updates-info'),
  integrationStatus: () => ipcRenderer.invoke('browser:integration-status'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  onProgress: (callback) => subscribe('downloads:progress', callback),
  onInspectRequest: (callback) => subscribe('downloads:inspect-request', callback),
  onDownloadAdded: (callback) => subscribe('downloads:added', callback),
  onIntegrationChanged: (callback) => subscribe('integration:changed', callback),
  appVersion: () => ipcRenderer.invoke('app:version')
});
