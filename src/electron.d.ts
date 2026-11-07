interface MeldrixApi {
  listDownloads: () => Promise<any[]>;
  addDownload: (input: any) => Promise<any>;
  inspectDownload: (url: string) => Promise<any>;
  pauseDownload: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
  resumeDownload: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
  cancelDownload: (id: string) => Promise<void>;
  deleteDownloads: (ids: string[]) => Promise<{ ok: boolean; deleted: number; canceled?: boolean }>;
  openDownloadFile: (id: string) => Promise<void>;
  openTaskFolder: (id: string) => Promise<{ ok: boolean }>;
  startQueue: () => Promise<boolean>;
  stopQueue: () => Promise<boolean>;
  pendingReview: () => Promise<any>;
  dismissReview: (id: string) => Promise<boolean>;
  openDownloadFolder: () => Promise<{ ok: boolean }>;
  openExternal: (url: string) => Promise<void>;
  openExtensionFolder: () => Promise<{ ok: boolean }>;
  openReadme: () => Promise<void>;
  showAbout: () => Promise<void>;
  showUpdateInfo: () => Promise<void>;
  integrationStatus: () => Promise<any>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<void>;
  hideWindow: () => Promise<void>;
  selectFolder: () => Promise<string | null>;
  getSetting: (key: string) => Promise<string>;
  setSetting: (key: string, value: string) => Promise<string>;
  onProgress: (callback: (value: any) => void) => () => void;
  onInspectRequest: (callback: (value: any) => void) => () => void;
  onDownloadAdded: (callback: (value: any) => void) => () => void;
  onIntegrationChanged: (callback: (value: any) => void) => () => void;
  appVersion: () => Promise<string>;
}
declare global { interface Window { meldrix?: MeldrixApi } }
export {};
