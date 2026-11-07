import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import type { Category, Download } from './types';

type View = Category | 'Finished' | 'Unfinished' | 'Queues';
type Detected = { name?: string; mimeType?: string; size?: number; category?: Category; referrer?: string; source?: string; kind?: 'file' | 'hls'; quality?: string };
type Toggles = { autoDetect: boolean; showVideo: boolean; confirmBefore: boolean; startWithWindows: boolean };

const categories: Category[] = ['All files', 'Video', 'Audio', 'Documents', 'Compressed', 'Programs', 'Pictures'];
const nav: { label: View; icon: string }[] = [
  { label: 'All files', icon: 'grid' }, { label: 'Compressed', icon: 'folder' },
  { label: 'Programs', icon: 'download' }, { label: 'Video', icon: 'play' },
  { label: 'Audio', icon: 'zap' }, { label: 'Pictures', icon: 'grid' },
  { label: 'Documents', icon: 'folder' }, { label: 'Finished', icon: 'check' },
  { label: 'Unfinished', icon: 'pause' }, { label: 'Queues', icon: 'more' },
];

const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n ? `${(n / 1e3).toFixed(0)} KB` : '—';
const percent = (d: Download) => d.size ? Math.min(100, Math.round(d.downloaded / d.size * 100)) : 0;
const typeOf = (name: string) => (name.split('.').pop() || 'file').toUpperCase();
const fileNameFromUrl = (value: string) => {
  try {
    const part = decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || 'download');
    return part || 'download';
  } catch { return 'download'; }
};
const hostOf = (value: string) => {
  try { return new URL(value).hostname; } catch { return value; }
};
const categoryOf = (name: string, mime = ''): Category => {
  const v = `${name} ${mime}`.toLowerCase();
  if (/\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv|m3u8|mpd)/.test(v) || mime.startsWith('video/') || /mpegurl|dash\+xml/i.test(mime)) return 'Video';
  if (/\.(mp3|wav|flac|aac|m4a|ogg|opus)/.test(v) || mime.startsWith('audio/')) return 'Audio';
  if (/\.(zip|rar|7z|tar|gz)/.test(v)) return 'Compressed';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)/.test(v) || mime.includes('pdf') || mime.startsWith('text/')) return 'Documents';
  if (/\.(exe|msi|apk)/.test(v)) return 'Programs';
  if (/\.(jpg|jpeg|png|gif|svg|webp|bmp)/.test(v) || mime.startsWith('image/')) return 'Pictures';
  return 'All files';
};

const mapRow = (r: any): Download => ({
  id: r.id,
  name: r.name,
  url: r.url,
  category: (r.category || categoryOf(r.name)) as Category,
  kind: r.kind === 'hls' ? 'hls' : 'file',
  size: Number(r.size) || 0,
  downloaded: Number(r.downloaded) || 0,
  speed: 0,
  status: r.status,
  added: r.created_at ? new Date(r.created_at).toLocaleString() : 'Just now',
  type: typeOf(r.name)
});

export default function App() {
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [view, setView] = useState<View>('All files');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'new' | 'settings' | 'wizard' | null>(() => localStorage.getItem('meldrix-onboarded') ? null : 'wizard');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('All files');
  const [savePath, setSavePath] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [topMenu, setTopMenu] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [taskDetails, setTaskDetails] = useState<Download[] | null>(null);
  const [integration, setIntegration] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggles, setToggles] = useState<Toggles>({ autoDetect: true, showVideo: true, confirmBefore: true, startWithWindows: true });
  const lookupToken = useRef(0);
  const pendingToggle = useRef<Set<string>>(new Set());
  const deletePending = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setNotice(''), 2800);
  }, []);

  const refresh = useCallback(() => {
    window.meldrix?.listDownloads().then(rows => setDownloads(rows.map(mapRow))).catch(() => {});
  }, []);

  const applyIntegration = useCallback((status: any) => {
    if (!status) return;
    setIntegration(status);
    setConnected(!!status.connected);
    if (status.settings) {
      setToggles(current => ({
        ...current,
        autoDetect: status.settings.intercept !== false,
        showVideo: status.settings.overlay !== false,
        confirmBefore: status.settings.confirmBeforeDownload !== false
      }));
    }
  }, []);

  const inspect = useCallback(async (value: string, preserveName = false) => {
    if (!/^https?:\/\//i.test(value)) return;
    const token = ++lookupToken.current;
    try {
      const info = await window.meldrix?.inspectDownload(value);
      if (!info || token !== lookupToken.current) return;
      const inspectedName = info.name || fileNameFromUrl(value);
      const nextCategory = (info.category || categoryOf(inspectedName, info.mimeType)) as Category;
      setDetected(current => ({
        ...(current || {}),
        ...info,
        name: preserveName ? (current?.name || inspectedName) : inspectedName,
        quality: current?.quality,
        size: Number(info.size) || Number(current?.size) || 0,
        mimeType: info.mimeType || current?.mimeType || ''
      }));
      if (!preserveName) setName(inspectedName);
      setCategory(nextCategory);
    } catch {
      if (token === lookupToken.current) setDetected(null);
    }
  }, []);

  const openReview = useCallback((request: any) => {
    if (!request || !request.url) return;
    const nextName = request.name || fileNameFromUrl(request.url);
    const nextCategory = (request.category || categoryOf(nextName, request.mimeType)) as Category;
    setUrl(request.url);
    setName(nextName);
    setCategory(nextCategory);
    setDetected({
      name: nextName,
      mimeType: request.mimeType || '',
      size: Number(request.size) || 0,
      category: nextCategory,
      referrer: request.referrer || '',
      source: request.source || 'browser',
      kind: request.kind === 'hls' ? 'hls' : 'file',
      quality: request.quality || ''
    });
    setReviewId(request.id || null);
    setDialog('new');
    // The extension already probed the real media metadata. Only inspect when
    // the browser request did not supply it, and never overwrite the chosen
    // quality or filename during a review.
    if (!request.mimeType || !request.size) void inspect(request.url, true);
  }, [inspect]);

  useEffect(() => {
    if (!window.meldrix) return;
    refresh();
    window.meldrix.getSetting('default_download_directory').then(value => setSavePath(value || '')).catch(() => {});
    window.meldrix.getSetting('max_concurrent_downloads').then(value => {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 8) setMaxConcurrent(parsed);
    }).catch(() => {});
    window.meldrix.getSetting('start_with_windows').then(value => {
      if (value) setToggles(current => ({ ...current, startWithWindows: value === '1' }));
    }).catch(() => {});
    window.meldrix.integrationStatus().then(applyIntegration).catch(() => {});

    const stops = [
      window.meldrix.onProgress((progress: any) => {
        setDownloads(rows => rows.map(row => row.id === progress.id ? { ...row, ...progress, category: row.category } : row));
      }),
      window.meldrix.onInspectRequest((request: any) => openReview(request)),
      window.meldrix.onDownloadAdded(() => refresh()),
      window.meldrix.onIntegrationChanged((status: any) => applyIntegration(status))
    ];
    window.meldrix.pendingReview().then((request: any) => { if (request) openReview(request); }).catch(() => {});
    return () => stops.forEach(stop => stop && stop());
  }, [applyIntegration, openReview, refresh]);

  const visible = useMemo(() => downloads.filter(d => {
    const matchesView = view === 'All files'
      ? true
      : view === 'Queues'
        ? d.status === 'queued'
      : view === 'Finished'
        ? d.status === 'completed'
        : view === 'Unfinished'
          ? d.status !== 'completed'
          : d.category === view;
    const search = query.trim().toLowerCase();
    return matchesView && (!search || d.name.toLowerCase().includes(search) || d.url.toLowerCase().includes(search) || d.category.toLowerCase().includes(search));
  }), [downloads, view, query]);
  const selected = useMemo(() => downloads.filter(row => selectedIds.has(row.id)), [downloads, selectedIds]);
  const active = downloads.filter(d => d.status === 'downloading');
  const speed = active.reduce((n, d) => n + (d.speed || 0), 0);

  const startNew = () => {
    lookupToken.current++;
    setUrl('');
    setName('');
    setCategory('All files');
    setDetected(null);
    setReviewId(null);
    setDialog('new');
  };

  const closeNew = useCallback(() => {
    if (reviewId) window.meldrix?.dismissReview(reviewId);
    setDialog(null);
    setUrl('');
    setName('');
    setDetected(null);
    setReviewId(null);
  }, [reviewId]);

  const chooseFolder = async () => {
    try {
      const selected = await window.meldrix?.selectFolder();
      if (selected) {
        await window.meldrix?.setSetting('default_download_directory', selected);
        setSavePath(selected);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save the download folder');
    }
  };

  const add = async (startNow: boolean) => {
    if (!/^https?:\/\//i.test(url)) { toast('Enter a valid HTTP or HTTPS URL'); return; }
    setBusy(true);
    const finalName = name.trim() || fileNameFromUrl(url);
    const finalCategory = (detected?.category || category || categoryOf(finalName, detected?.mimeType)) as Category;
    try {
      const created = await window.meldrix?.addDownload({
        url,
        name: finalName,
        category: finalCategory,
        mimeType: detected?.mimeType || '',
        kind: detected?.kind || (/\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file'),
        quality: detected?.quality || '',
        size: detected?.size || 0,
        referrer: detected?.referrer || '',
        destination: savePath || undefined,
        startNow
      });
      if (!created) throw new Error('No download was created');
      const row: Download = {
        id: created.id,
        name: created.name || finalName,
        url: created.url || url,
        category: (created.category || finalCategory) as Category,
        kind: created.kind === 'hls' ? 'hls' : 'file',
        size: Number(created.size) || detected?.size || 0,
        downloaded: Number(created.downloaded) || 0,
        speed: 0,
        status: created.status || (startNow ? 'downloading' : 'queued'),
        added: 'Just now',
        type: typeOf(created.name || finalName)
      };
      setDownloads(rows => rows.some(item => item.id === row.id) ? rows.map(item => item.id === row.id ? row : item) : [row, ...rows]);
      if (reviewId) await window.meldrix?.dismissReview(reviewId);
      setDialog(null);
      setUrl('');
      setName('');
      setDetected(null);
      setReviewId(null);
      toast(startNow ? 'Download started' : `${row.category} added to queue`);
    } catch {
      toast('The desktop engine rejected this URL');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (d: Download) => {
    if (!['downloading', 'paused', 'queued'].includes(d.status)) return;
    if (pendingToggle.current.has(d.id)) return;
    pendingToggle.current.add(d.id);
    const next = d.status === 'downloading' ? 'paused' : 'downloading';
    setDownloads(rows => rows.map(row => row.id === d.id ? { ...row, status: next } : row));
    try {
      if (next === 'paused') await window.meldrix?.pauseDownload(d.id);
      else await window.meldrix?.resumeDownload(d.id);
    } catch {
      toast('Could not change the download state');
      refresh();
    } finally {
      pendingToggle.current.delete(d.id);
    }
  };
  const pauseAll = () => { void pauseTasks(downloads, 'Pause all'); };
  const resumeAll = () => { void resumeTasks(downloads, 'Resume all'); };
  const startQueue = () => { void startQueueAction(); };
  const stopQueue = () => { void stopQueueAction(); };
  const openSettings = () => {
    setDialog('settings');
    window.meldrix?.integrationStatus().then(applyIntegration).catch(() => {});
  };
  const updateToggle = async (key: keyof Toggles, value: boolean) => {
    const settingKey = key === 'autoDetect' ? 'auto_detect_downloads' : key === 'showVideo' ? 'show_video_button' : key === 'confirmBefore' ? 'confirm_before_download' : 'start_with_windows';
    setToggles(current => ({ ...current, [key]: value }));
    try {
      await window.meldrix?.setSetting(settingKey, value ? '1' : '0');
      const status = await window.meldrix?.integrationStatus();
      if (status) applyIntegration(status);
    } catch {
      toast('Could not save the setting');
      setToggles(current => ({ ...current, [key]: !value }));
    }
  };
  const updateMaxConcurrent = async (value: number) => {
    try {
      await window.meldrix?.setSetting('max_concurrent_downloads', String(value));
      setMaxConcurrent(value);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save the simultaneous download limit');
    }
  };

  const selectAllVisible = () => setSelectedIds(new Set(visible.map(row => row.id)));
  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelectedRow = (id: string, additive: boolean) => {
    setSelectedIds(current => {
      const next = new Set(additive ? current : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pauseTasks = async (rows: Download[], label: string) => {
    const applicable = rows.filter(row => row.status === 'downloading' && !pendingToggle.current.has(row.id));
    if (!applicable.length) { toast('No downloading tasks are selected'); return; }
    applicable.forEach(row => pendingToggle.current.add(row.id));
    const results = await Promise.allSettled(applicable.map(row => window.meldrix?.pauseDownload(row.id)));
    applicable.forEach(row => pendingToggle.current.delete(row.id));
    const succeeded = results.filter(result => result.status === 'fulfilled' && (result.value as any)?.ok).length;
    refresh();
    if (succeeded) toast(`${label}: ${succeeded} task${succeeded === 1 ? '' : 's'} paused`);
    if (succeeded !== applicable.length) toast('Some tasks could not be paused');
  };

  const resumeTasks = async (rows: Download[], label: string) => {
    const applicable = rows.filter(row => ['paused', 'queued', 'failed'].includes(row.status) && !pendingToggle.current.has(row.id));
    if (!applicable.length) { toast('No paused or queued tasks are selected'); return; }
    applicable.forEach(row => pendingToggle.current.add(row.id));
    const results = await Promise.allSettled(applicable.map(row => window.meldrix?.resumeDownload(row.id)));
    applicable.forEach(row => pendingToggle.current.delete(row.id));
    const succeeded = results.filter(result => result.status === 'fulfilled' && (result.value as any)?.ok).length;
    refresh();
    if (succeeded) toast(`${label}: ${succeeded} task${succeeded === 1 ? '' : 's'} resumed`);
    if (succeeded !== applicable.length) toast('Some tasks could not be resumed');
  };

  const startQueueAction = async () => {
    try {
      const result = await window.meldrix?.startQueue();
      if (result !== true) throw new Error('Queue did not start');
      toast('Download queue started');
      refresh();
    } catch { toast('Could not start the download queue'); }
  };

  const stopQueueAction = async () => {
    try {
      const result = await window.meldrix?.stopQueue();
      if (result !== true) throw new Error('Queue did not stop');
      toast('Queue stopped; active tasks were paused');
      refresh();
    } catch { toast('Could not stop the download queue'); }
  };

  const deleteTasks = async (rows: Download[]) => {
    if (!rows.length) { toast('Select one or more tasks to delete'); return; }
    if (deletePending.current) return;
    deletePending.current = true;
    try {
      const result = await window.meldrix?.deleteDownloads(rows.map(row => row.id));
      if (result?.canceled) return;
      if (!result?.ok) throw new Error('No tasks were deleted');
      setSelectedIds(current => {
        const next = new Set(current);
        rows.forEach(row => next.delete(row.id));
        return next;
      });
      refresh();
      toast(`${result.deleted} task${result.deleted === 1 ? '' : 's'} deleted`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not delete the selected tasks');
    } finally {
      deletePending.current = false;
    }
  };

  const openTask = async (row: Download) => {
    try {
      if (row.status === 'completed') await window.meldrix?.openDownloadFile(row.id);
      else await window.meldrix?.openExternal(row.url);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not open this task');
    }
  };

  const openTaskFolder = async (row: Download) => {
    try {
      const result = await window.meldrix?.openTaskFolder(row.id);
      if (!result?.ok) throw new Error('Task folder could not be opened');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not open this task folder');
    }
  };

  const openSelected = async () => {
    if (!selected.length) { toast('Select a task to open'); return; }
    if (selected.length > 1) { toast('Open works with one selected task'); return; }
    await openTask(selected[0]);
  };

  const openToolsFolder = async () => {
    try {
      const result = await window.meldrix?.openDownloadFolder();
      if (result === undefined) throw new Error('Download folder could not be opened');
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not open the download folder'); }
  };

  const openExtensionDirectory = async () => {
    try {
      const result = await window.meldrix?.openExtensionFolder();
      if (!result?.ok) throw new Error('Extension folder could not be opened');
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not open the extension folder'); }
  };

  const openRepository = async (url: string) => {
    try { await window.meldrix?.openExternal(url); }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not open the GitHub page'); }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === 'Escape') {
        setTopMenu(null);
        setMenu(null);
        setTaskDetails(null);
        if (dialog === 'new') closeNew();
        else if (dialog) setDialog(null);
      } else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault(); startNew();
      } else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); selectAllVisible();
      } else if (!typing && event.key === 'Delete') {
        event.preventDefault(); void deleteTasks(selected);
      } else if (!typing && event.altKey && event.key === 'Enter' && selected.length) {
        event.preventDefault(); setTaskDetails(selected);
      } else if (!typing && event.key === 'Enter' && selected.length === 1) {
        event.preventDefault(); void openTask(selected[0]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, visible, downloads, dialog, closeNew]);

  const menuItems = (name: string) => {
    const hasSelection = selected.length > 0;
    const hasDownloading = selected.some(row => row.status === 'downloading');
    if (name === 'File') return [
      { label: 'New Download', shortcut: 'Ctrl+N', action: startNew },
      { label: 'Open Download Folder', shortcut: '', action: openToolsFolder },
      { label: 'Settings', shortcut: '', action: openSettings }
    ];
    if (name === 'Tools') return [
      { label: 'Open Download Folder', shortcut: '', action: openToolsFolder },
      { label: 'Open Extension Folder', shortcut: '', action: openExtensionDirectory },
      { label: 'Browser Integration Settings', shortcut: '', action: openSettings },
      { label: 'Settings', shortcut: '', action: openSettings }
    ];
    if (name === 'Edit') return [
      { label: 'Select All Visible', shortcut: 'Ctrl+A', action: selectAllVisible, disabled: !visible.length },
      { label: 'Clear Selection', shortcut: '', action: clearSelection, disabled: !selected.length },
      { label: 'Delete Selected', shortcut: 'Delete', action: () => void deleteTasks(selected), disabled: !selected.length }
    ];
    if (name === 'View') return nav.map(item => ({
      label: `${view === item.label ? '✓ ' : ''}${item.label}`,
      shortcut: '',
      action: () => setView(item.label)
    }));
    if (name === 'Window') return [
      { label: 'Minimize', shortcut: '', action: () => void window.meldrix?.minimizeWindow() },
      { label: 'Toggle Maximize', shortcut: '', action: () => void window.meldrix?.toggleMaximizeWindow() },
      { label: 'Hide to Tray', shortcut: '', action: () => void window.meldrix?.hideWindow() }
    ];
    if (name === 'Tasks') return [
      { label: 'New Download', shortcut: 'Ctrl+N', action: startNew },
      { label: 'Open Selected', shortcut: 'Enter', action: openSelected, disabled: selected.length !== 1 },
      { label: 'Task Details', shortcut: 'Alt+Enter', action: () => selected.length ? setTaskDetails(selected) : toast('Select a task to view details'), disabled: !hasSelection },
      { separator: true },
      { label: 'Pause Selected', shortcut: '', action: () => void pauseTasks(selected, 'Pause selected'), disabled: !hasDownloading },
      { label: 'Resume / Retry Selected', shortcut: '', action: () => void resumeTasks(selected, 'Resume selected'), disabled: !selected.some(row => ['paused', 'queued', 'failed'].includes(row.status)) },
      { label: 'Stop Selected', shortcut: '', action: () => void pauseTasks(selected, 'Stop selected'), disabled: !hasDownloading },
      { label: 'Start Queue', shortcut: '', action: startQueue },
      { label: 'Stop Queue', shortcut: '', action: stopQueue },
      { separator: true },
      { label: 'Select All Visible', shortcut: 'Ctrl+A', action: selectAllVisible, disabled: !visible.length },
      { label: 'Delete Selected', shortcut: 'Delete', action: () => void deleteTasks(selected), disabled: !hasSelection },
      { label: 'Queues', shortcut: '', action: () => setView('Queues') }
    ];
    return [
      { label: 'GitHub Repository', shortcut: '', action: () => void openRepository('https://github.com/fahadmia20333/dawnload-manager') },
      { label: 'Documentation / README', shortcut: '', action: () => void window.meldrix?.openReadme().catch(error => toast(error instanceof Error ? error.message : 'Could not open the README')) },
      { label: 'Report an Issue', shortcut: '', action: () => void openRepository('https://github.com/fahadmia20333/dawnload-manager/issues/new') },
      { separator: true },
      { label: 'Check for Updates', shortcut: '', action: () => void window.meldrix?.showUpdateInfo().catch(error => toast(error instanceof Error ? error.message : 'Could not show update information')) },
      { label: 'About Meldrix Download Manager', shortcut: '', action: () => void window.meldrix?.showAbout().catch(error => toast(error instanceof Error ? error.message : 'Could not show application information')) }
    ];
  };

  return <div className="idm-app" onClick={() => { if (menu) setMenu(null); if (topMenu) setTopMenu(null); }}>
    <header className="idm-titlebar"><div className="idm-brand"><span className="idm-logo"><Icon name="arrow" size={16}/></span><b>Meldrix</b><small>DOWNLOAD MANAGER</small></div><div className="idm-menus">
      {(['File', 'Edit', 'View', 'Tasks', 'Tools', 'Window', 'Help'] as const).map(label => <div className="top-menu" key={label}>
        <button type="button" className={topMenu === label ? 'top-menu-trigger active' : 'top-menu-trigger'} aria-haspopup="menu" aria-expanded={topMenu === label} onClick={event => { event.stopPropagation(); setTopMenu(current => current === label ? null : label); setMenu(null); }}>{label}</button>
        {topMenu === label && <div className="top-menu-popup" role="menu" onClick={event => event.stopPropagation()}>
          {menuItems(label).map((item: any, index: number) => item.separator
            ? <div className="top-menu-separator" key={`${label}-sep-${index}`}/>
            : <button type="button" role="menuitem" key={`${label}-${item.label}`} disabled={!!item.disabled} onClick={() => { setTopMenu(null); item.action(); }}><span>{item.label}</span>{item.shortcut && <small>{item.shortcut}</small>}</button>)}
        </div>}
      </div>)}
    </div><div className="idm-window-actions">
      <button aria-label="Minimize" title="Minimize" onClick={() => void window.meldrix?.minimizeWindow()}>—</button>
      <button aria-label="Toggle maximize" title="Toggle maximize" onClick={() => void window.meldrix?.toggleMaximizeWindow()}>□</button>
      <button aria-label="Hide to tray" title="Hide to tray" onClick={() => void window.meldrix?.hideWindow()}>×</button>
    </div></header>
    <div className="idm-toolbar">
      <Toolbar icon="plus" label="New Download" primary onClick={startNew}/>
      <Toolbar icon="play" label="Resume / Retry" onClick={resumeAll} disabled={!downloads.some(row => ['paused', 'queued', 'failed'].includes(row.status))}/>
      <Toolbar icon="pause" label="Pause" onClick={pauseAll} disabled={!active.length}/>
      <Toolbar icon="zap" label="Start Queue" onClick={startQueue}/>
      <Toolbar icon="close" label="Stop Queue" onClick={stopQueue} disabled={!active.length && !downloads.some(row => row.status === 'queued')}/>
      <Toolbar icon="more" label="Queues" onClick={() => setView('Queues')}/>
      <Toolbar icon="close" label="Stop All" onClick={pauseAll} disabled={!active.length}/>
      <Toolbar icon="close" label={selected.length ? `Delete (${selected.length})` : 'Delete'} onClick={() => void deleteTasks(selected)} disabled={!selected.length}/>
      <Toolbar icon="settings" label="Settings" onClick={openSettings}/>
    </div>
    <div className="idm-body"><aside className="idm-sidebar">
      <div className="sidebar-title">CATEGORIES</div>
      {nav.map(item => <button key={item.label} className={view === item.label ? 'idm-nav active' : 'idm-nav'} onClick={() => setView(item.label)}><Icon name={item.icon} size={15}/><span>{item.label}</span>{item.label === 'All files' && <em>{downloads.length}</em>}</button>)}
      <div className="sidebar-bottom">
        <div className="integration"><i className={connected ? 'connected' : ''}/><div><b>Browser integration</b><small>{connected ? 'Extension connected' : 'Waiting for extension'}</small></div><button onClick={openSettings}><Icon name="settings" size={14}/></button></div>
        <button className="idm-settings-link" onClick={openSettings}><Icon name="settings" size={15}/> Settings</button>
      </div>
    </aside>
      <main className="idm-content"><div className="content-heading"><div><span className="crumb">MELDRIX / DOWNLOADS</span><h1>{view}</h1></div><div className="heading-actions"><div className="idm-search"><Icon name="search" size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search downloads"/></div><button className="compact-button" onClick={startNew}><Icon name="plus" size={14}/> New Download</button></div></div>
        <div className="download-panel">{selected.length > 0 && <div className="selection-bar"><span>{selected.length} task{selected.length === 1 ? '' : 's'} selected</span><button onClick={clearSelection}>Clear selection</button></div>}<div className="table-header"><span className="name-col">FILE NAME <small>· Ctrl+click to select</small></span><span>SIZE</span><span>STATUS</span><span>SPEED</span><span>TIME LEFT</span><span>DATE ADDED</span><span/></div>
          {visible.map(d => {
            const remaining = d.status === 'downloading' && d.speed > 0 && d.size > d.downloaded ? `${Math.max(1, Math.ceil((d.size - d.downloaded) / d.speed))}s` : d.status === 'queued' ? 'Waiting' : '—';
            const interactive = d.status === 'downloading' || d.status === 'paused' || d.status === 'queued';
            const fileTitle = d.status === 'downloading' ? 'Click to pause' : d.status === 'paused' ? 'Click to resume' : d.status === 'queued' ? 'Click to start' : d.status === 'completed' ? 'Click to open file' : 'Click to view task details';
             return <div className={`download-row ${selectedIds.has(d.id) ? 'selected' : ''}`} key={d.id} aria-selected={selectedIds.has(d.id)} onClick={event => { if (event.ctrlKey || event.metaKey) { event.stopPropagation(); toggleSelectedRow(d.id, true); } }} onContextMenu={e => { e.preventDefault(); if (!selectedIds.has(d.id)) setSelectedIds(new Set([d.id])); setMenu(d.id); }}>
               <button type="button" className={`file-cell name-col ${interactive || d.status === 'completed' ? 'clickable' : ''}`} title={`${fileTitle} · Ctrl+click to select`} aria-label={`${fileTitle}; Ctrl+click to select task`} onClick={e => { e.stopPropagation(); if (e.ctrlKey || e.metaKey) toggleSelectedRow(d.id, true); else if (interactive) toggle(d); else if (d.status === 'completed') void openTask(d); else setTaskDetails([d]); }}><span className={'extension ' + d.type.toLowerCase()}>{d.type.slice(0, 3)}</span><div><b>{d.name}</b><small>{d.url.replace(/^https?:\/\//, '').split('/')[0]}</small><div className="mini-progress"><i style={{ width: `${percent(d)}%` }}/></div></div></button>
               <span className="dim">{fmt(d.size)}</span><Status value={d.status}/><span className="dim">{d.status === 'downloading' ? `${fmt(d.speed)}/s` : '—'}</span><span className="dim">{remaining}</span><span className="dim">{d.added}</span>
               <button className="row-menu" aria-label={`Actions for ${d.name}`} onClick={event => { event.stopPropagation(); if (!selectedIds.has(d.id)) setSelectedIds(new Set([d.id])); setMenu(menu === d.id ? null : d.id); }}><Icon name="more" size={16}/>{menu === d.id && <div className="context-menu" onClick={event => event.stopPropagation()}>
                 <button onClick={() => { setMenu(null); void openTask(d); }}>{d.status === 'completed' ? 'Open file' : 'Open source URL'}</button>
                 {interactive && <button onClick={() => { setMenu(null); d.status === 'downloading' ? void pauseTasks([d], 'Task') : void resumeTasks([d], 'Task'); }}>{d.status === 'downloading' ? 'Pause download' : d.status === 'queued' ? 'Start download' : 'Resume download'}</button>}
                 {d.status === 'failed' && <button onClick={() => { setMenu(null); void resumeTasks([d], 'Retry'); }}>Retry download</button>}
                 <button onClick={() => { setMenu(null); setTaskDetails([d]); }}>Task details</button>
                 <button onClick={() => { setMenu(null); void openTaskFolder(d); }}>Open download folder</button>
                 <button onClick={() => { setMenu(null); void deleteTasks([d]); }}>Delete task</button>
               </div>}</button>
            </div>;
          })}
          {!visible.length && <div className="idm-empty"><div><Icon name="download" size={24}/></div><b>No downloads in this category</b><span>Download files from your browser or add a URL to get started.</span><button onClick={startNew}>New Download</button></div>}
        </div>
      </main>
    </div>
    <footer className="idm-statusbar"><span><i/> {active.length} active downloads</span><span><Icon name="download" size={12}/> {fmt(speed)}/s total speed</span><span><Icon name="zap" size={12}/> Queue: {active.length ? 'running' : 'ready'}</span><span className="status-right">Meldrix {integration?.version || '1.0.0'} · Native Messaging</span></footer>

    {dialog === 'new' && <NewDownloadDialog
      url={url}
      name={name}
      category={category}
      detected={detected}
      savePath={savePath}
      busy={busy}
      fromBrowser={!!reviewId}
      onUrlChange={value => {
        if (reviewId) window.meldrix?.dismissReview(reviewId);
        setUrl(value);
        setName('');
        setCategory('All files');
        setDetected(null);
        setReviewId(null);
        lookupToken.current++;
      }}
      onNameChange={setName}
      onCategoryChange={setCategory}
      onChooseFolder={chooseFolder}
      onInspect={() => inspect(url)}
      onClose={closeNew}
      onAdd={add}
    />}
    {dialog === 'settings' && <Settings
      close={() => setDialog(null)}
      integration={integration}
      connected={connected}
      toggles={toggles}
      savePath={savePath}
      maxConcurrent={maxConcurrent}
      onToggle={updateToggle}
      onMaxConcurrentChange={updateMaxConcurrent}
      chooseDownloadFolder={chooseFolder}
      refresh={() => window.meldrix?.integrationStatus().then(applyIntegration).catch(() => {})}
      openFolder={() => window.meldrix?.openExtensionFolder().catch(() => {})}
    />}
    {dialog === 'wizard' && <Wizard
      close={() => { localStorage.setItem('meldrix-onboarded', '1'); setDialog(null); }}
      integration={integration}
      connected={connected}
      openFolder={() => window.meldrix?.openExtensionFolder().catch(() => {})}
      refresh={() => window.meldrix?.integrationStatus().then(applyIntegration).catch(() => {})}
    />}
    {taskDetails && <TaskDetails rows={taskDetails} close={() => setTaskDetails(null)} openTask={openTask}/>}
    {notice && <div className="idm-toast"><Icon name="check" size={15}/>{notice}</div>}
  </div>;
}

function Toolbar({ icon, label, onClick, primary = false, disabled = false }: { icon: string; label: string; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return <button className={primary ? 'tool primary' : 'tool'} onClick={onClick} disabled={disabled}><span><Icon name={icon} size={17}/></span>{label}</button>;
}

function TaskDetails({ rows, close, openTask }: { rows: Download[]; close: () => void; openTask: (row: Download) => void }) {
  return <div className="idm-overlay" onClick={close}><div className="idm-dialog task-details" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
    <DialogHead title={rows.length === 1 ? 'Task Details' : `${rows.length} Task Details`} subtitle="Download task information" close={close}/>
    <div className="task-detail-list">{rows.map(row => <section className="task-detail-card" key={row.id}>
      <h3>{row.name}</h3>
      <dl><dt>Status</dt><dd>{row.status}</dd><dt>Category</dt><dd>{row.category}</dd><dt>Type</dt><dd>{row.type}</dd><dt>Size</dt><dd>{fmt(row.size)}</dd><dt>Downloaded</dt><dd>{fmt(row.downloaded)}</dd><dt>Source</dt><dd>{row.url}</dd><dt>Added</dt><dd>{row.added}</dd></dl>
      <button className="compact-button" onClick={() => void openTask(row)}>{row.status === 'completed' ? 'Open file' : 'Open source URL'}</button>
    </section>)}</div>
    <div className="dialog-actions"><button className="accent-button" onClick={close}>Close</button></div>
  </div></div>;
}

function Status({ value }: { value: Download['status'] }) {
  return <span className={'idm-status ' + value}><i/>{value === 'downloading' ? 'Downloading' : value === 'completed' ? 'Finished' : value === 'paused' ? 'Paused' : value === 'failed' ? 'Failed' : 'Queued'}</span>;
}

function DialogHead({ title, subtitle, close }: { title: string; subtitle: string; close: () => void }) {
  return <div className="dialog-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={close}><Icon name="close"/></button></div>;
}

function NewDownloadDialog({ url, name, category, detected, savePath, busy, fromBrowser, onUrlChange, onNameChange, onCategoryChange, onChooseFolder, onInspect, onClose, onAdd }: {
  url: string; name: string; category: Category; detected: Detected | null; savePath: string; busy: boolean; fromBrowser: boolean;
  onUrlChange: (value: string) => void; onNameChange: (value: string) => void; onCategoryChange: (value: Category) => void;
  onChooseFolder: () => void; onInspect: () => void; onClose: () => void; onAdd: (startNow: boolean) => void;
}) {
  return <div className="idm-overlay"><div className="idm-dialog">
    <DialogHead title="Add Download" subtitle={fromBrowser ? 'Sent by your browser — review before downloading' : 'Add a file to your download queue'} close={onClose}/>
    <label>DOWNLOAD URL<input autoFocus value={url} onChange={e => onUrlChange(e.target.value)} onBlur={onInspect} onKeyDown={e => { if (e.key === 'Enter') onAdd(true); }} placeholder="https://example.com/file.zip"/></label>
    {detected && <div className="detected-file"><Icon name={detected.category === 'Video' ? 'play' : 'check'} size={14}/><span>Detected {detected.category || categoryOf(name, detected.mimeType)} · {detected.name || name}{detected.size ? ` · ${fmt(detected.size)}` : ''}{detected.mimeType ? ` · ${detected.mimeType}` : ''}{detected.quality ? ` · ${detected.quality}` : ''}{detected.referrer ? ` · from ${hostOf(detected.referrer)}` : ''}</span></div>}
    <div className="form-grid">
      <label>FILE NAME<input value={name} onChange={e => onNameChange(e.target.value)} placeholder="File name"/></label>
      <label>CATEGORY<select value={category} onChange={e => onCategoryChange(e.target.value as Category)}>{categories.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    <div className="form-grid">
      <div className="folder-field"><span>SAVE TO</span><div className="path-display"><Icon name="folder" size={15}/><span title={savePath}>{savePath || 'Application default folder'}</span><button type="button" onClick={onChooseFolder}><Icon name="folder" size={13}/> Choose Folder</button></div></div>
      <div className="connection-note">Downloads currently use a single connection. Resume is supported when the server accepts byte ranges.</div>
    </div>
    <div className="dialog-actions">
      <button onClick={onClose} disabled={busy}>Cancel</button>
      <button onClick={() => onAdd(false)} disabled={busy}>Add to queue</button>
      <button className="accent-button" onClick={() => onAdd(true)} disabled={busy}><Icon name="download" size={14}/> Download now</button>
    </div>
  </div></div>;
}

function Settings({ close, integration, connected, toggles, savePath, maxConcurrent, onToggle, onMaxConcurrentChange, chooseDownloadFolder, refresh, openFolder }: {
  close: () => void; integration: any; connected: boolean; toggles: Toggles; savePath: string; maxConcurrent: number;
  onToggle: (key: keyof Toggles, value: boolean) => void; onMaxConcurrentChange: (value: number) => void; chooseDownloadFolder: () => void; refresh: () => void; openFolder: () => void;
}) {
  const chrome = integration?.chrome || {};
  const edge = integration?.edge || {};
  const browserPill = (browser: any) => {
    if (browser.connected) return <span className="pill ok">Extension connected</span>;
    if (!browser.installed) return <span className="pill bad">Browser not installed</span>;
    if (!browser.registered) return <span className="pill bad">Host not registered</span>;
    return <span className="pill warn">Extension not detected</span>;
  };
  return <div className="idm-overlay"><div className="idm-dialog settings-dialog">
    <DialogHead title="Meldrix Settings" subtitle="Configure your download manager" close={close}/>
    <div className="setting-body">
      <h3>Browser Integration</h3>
      <p>Native Messaging is registered by the installer. Load the bundled extension once in Chrome or Edge; no localhost port or separate server is used.</p>
      <div className="browser-card"><div className="browser-icon">C</div><div><b>Google Chrome</b><small>{chrome.installed ? 'Browser installed' : 'Browser not detected'} · {chrome.registered ? 'Native host registered' : 'Native host not registered'}{chrome.lastConnectedAt ? ` · Last connection ${new Date(chrome.lastConnectedAt).toLocaleTimeString()}` : ''}</small></div>{browserPill(chrome)}</div>
      <div className="browser-card"><div className="browser-icon edge">e</div><div><b>Microsoft Edge</b><small>{edge.installed ? 'Browser installed' : 'Browser not detected'} · {edge.registered ? 'Native host registered' : 'Native host not registered'}{edge.lastConnectedAt ? ` · Last connection ${new Date(edge.lastConnectedAt).toLocaleTimeString()}` : ''}</small></div>{browserPill(edge)}</div>
      <div className={`integration-line ${connected ? 'ok' : 'idle'}`}><i/><span>{connected ? 'Extension connected to the desktop app' : 'No recent extension connection'}</span><small>{integration?.lastNativeAt ? `Last contact ${new Date(integration.lastNativeAt).toLocaleTimeString()}` : 'Open the extension popup to test'}</small></div>
      <div className="row-actions"><button className="compact-button" onClick={openFolder}><Icon name="folder" size={14}/> Open extension folder</button><button className="compact-button" onClick={refresh}><Icon name="zap" size={14}/> Refresh status</button></div>

      <h3>Detect downloads</h3>
      <label className="setting-line"><span>Automatically detect browser downloads<small>Send supported files to Meldrix instead of the browser</small></span><input type="checkbox" checked={toggles.autoDetect} onChange={e => onToggle('autoDetect', e.target.checked)}/></label>
      <label className="setting-line"><span>Show download button on videos<small>Direct MP4, WebM, MOV, HLS and audio elements</small></span><input type="checkbox" checked={toggles.showVideo} onChange={e => onToggle('showVideo', e.target.checked)}/></label>
      <label className="setting-line"><span>Confirm before downloading<small>Open the Add Download dialog for every browser request</small></span><input type="checkbox" checked={toggles.confirmBefore} onChange={e => onToggle('confirmBefore', e.target.checked)}/></label>

      <h3>Application</h3>
      <label className="setting-line"><span>Maximum simultaneous downloads<small>Additional active downloads wait in the queue</small></span><select className="setting-select" value={maxConcurrent} onChange={e => onMaxConcurrentChange(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="setting-line"><span>Start Meldrix with Windows<small>Keeps the tray app ready for browser handoff</small></span><input type="checkbox" checked={toggles.startWithWindows} onChange={e => onToggle('startWithWindows', e.target.checked)}/></label>
      <div className="setting-line"><span>Default download folder<small>Used for new downloads unless changed in the download dialog</small></span><b className="setting-path">{savePath || 'Windows Downloads folder'}</b><button className="compact-button" onClick={chooseDownloadFolder}>Change</button></div>

      <details className="troubleshooting">
        <summary>Native Messaging details</summary>
        <div><b>Host</b><code>{integration?.hostPath || 'Not detected'}</code></div>
        <div><b>Manifest</b><code>{integration?.manifestPath || 'Not detected'}</code></div>
        <div><b>Host file</b><code>{integration?.hostExists ? 'Present' : 'Missing'} · manifest {integration?.manifestValid ? 'valid' : 'invalid'}</code></div>
        <div><b>Extension ID</b><code>lhnjhjehjjocnjjfgnpliffgochpgikk</code></div>
      </details>
    </div>
    <div className="dialog-actions"><button className="accent-button" onClick={close}>Close</button></div>
  </div></div>;
}

function Wizard({ close, integration, connected, openFolder, refresh }: {
  close: () => void; integration: any; connected: boolean; openFolder: () => void; refresh: () => void;
}) {
  const [step, setStep] = useState(1);
  const chrome = integration?.chrome || {};
  const edge = integration?.edge || {};
  return <div className="idm-overlay"><div className="idm-dialog wizard">
    <div className="wizard-brand"><span className="idm-logo"><Icon name="arrow" size={18}/></span><b>Welcome to Meldrix</b></div>
    <div className="wizard-steps"><b className={step >= 1 ? 'on' : ''}>1 Welcome</b><b className={step >= 2 ? 'on' : ''}>2 Folder</b><b className={step >= 3 ? 'on' : ''}>3 Browser</b><b className={step >= 4 ? 'on' : ''}>4 Finish</b></div>
    {step === 1 && <div className="wizard-page"><Icon name="download" size={34}/><h2>Welcome to Meldrix Download Manager</h2><p>Fast, secure downloads for your Windows desktop. The browser extension hands supported downloads to this app automatically.</p></div>}
    {step === 2 && <div className="wizard-page"><Icon name="folder" size={34}/><h2>Choose your download folder</h2><p>Files are saved to your configured folder. You can change it any time from the Add Download dialog.</p><div className="folder-choice"><Icon name="folder" size={16}/> Windows Downloads folder</div></div>}
    {step === 3 && <div className="wizard-page"><Icon name="grid" size={34}/><h2>Install the browser extension</h2><p>Open the bundled extension folders, then in Chrome or Edge open Extensions, enable Developer mode, and choose Load unpacked. Select the matching <b>chrome</b> or <b>edge</b> folder. The installer cannot silently install a browser extension.</p><div className="browser-card"><div className="browser-icon">C</div><div><b>Google Chrome</b><small>{chrome.connected ? 'Extension connected' : chrome.installed ? (chrome.registered ? 'Native Messaging registered' : 'Host not registered') : 'Chrome not installed'}</small></div><span className={`pill ${chrome.connected ? 'ok' : !chrome.installed || !chrome.registered ? 'bad' : 'warn'}`}>{chrome.connected ? 'Connected' : !chrome.installed ? 'Not installed' : !chrome.registered ? 'Error' : 'Host registered'}</span></div><div className="browser-card"><div className="browser-icon edge">e</div><div><b>Microsoft Edge</b><small>{edge.connected ? 'Extension connected' : edge.installed ? (edge.registered ? 'Native Messaging registered' : 'Host not registered') : 'Edge not installed'}</small></div><span className={`pill ${edge.connected ? 'ok' : !edge.installed || !edge.registered ? 'bad' : 'warn'}`}>{edge.connected ? 'Connected' : !edge.installed ? 'Not installed' : !edge.registered ? 'Error' : 'Host registered'}</span></div><div className="row-actions"><button className="compact-button" onClick={openFolder}><Icon name="folder" size={14}/> Open extension folders</button><button className="compact-button" onClick={refresh}><Icon name="zap" size={14}/> Re-check</button></div></div>}
    {step === 4 && <div className="wizard-page"><Icon name="check" size={34}/><h2>{connected ? 'Browser integration is connected' : 'Finish setup'}</h2><p>{connected ? 'The extension has contacted Meldrix through Native Messaging.' : 'Open Chrome or Edge and click the Meldrix toolbar icon. Connection recovery runs automatically. Protected or DRM media is not supported.'}</p></div>}
    <div className="wizard-actions"><button onClick={close}>Skip setup</button><button className="accent-button" onClick={() => step < 4 ? setStep(step + 1) : close()}>{step < 4 ? 'Continue' : 'Open dashboard'}</button></div>
  </div></div>;
}
