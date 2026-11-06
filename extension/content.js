// Meldrix in-page download control.
//
// The content script only creates UI for real <video>/<audio> elements (or a
// player whose tab already exposed a real media URL through webRequest). It
// removes stale UI from older injected copies, follows SPA navigation, and
// merges real probed formats before showing a quality choice.
(() => {
  const VERSION = '0.2.0';
  if (window.__meldrixContentVersion === VERSION) return;
  window.__meldrixContentVersion = VERSION;

  const SUPPORTED = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv|mp3|m4a|wav|flac|ogg|aac|opus|zip|rar|7z|tar|gz|exe|msi|apk|pdf|docx?|xlsx?|pptx?|txt|csv)(?:[?#].*)?$/i;
  const VIDEO_TYPES = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv)(?:[?#]|$)/i;
  const settings = { intercept: true, overlay: true, confirmBeforeDownload: true };
  const tracked = new Map();
  const tabCache = { at: 0, items: [] };
  let toastEl = null;
  let panel = null;
  let panelAnchor = null;
  let panelButton = null;
  let scanTimer = null;
  let lastHref = location.href;

  // Remove UI left behind by an older injected content script.
  document.querySelectorAll('[data-meldrix-ui]').forEach(element => {
    if (element.dataset.meldrixVersion !== VERSION) element.remove();
  });

  chrome.storage.local.get({ intercept: true, overlay: true, confirmBeforeDownload: true }).then(value => Object.assign(settings, value)).catch(() => {});
  chrome.storage.onChanged.addListener(changes => {
    if (changes.intercept) settings.intercept = !!changes.intercept.newValue;
    if (changes.overlay) settings.overlay = !!changes.overlay.newValue;
    if (changes.confirmBeforeDownload) settings.confirmBeforeDownload = !!changes.confirmBeforeDownload.newValue;
    if (!settings.overlay) {
      tracked.forEach(entry => entry.button.remove());
      tracked.clear();
      closePanel();
    } else {
      scheduleScan();
    }
  });

  function make(tag, style, text) {
    const element = document.createElement(tag);
    if (style) element.style.cssText = style;
    if (text) element.textContent = text;
    return element;
  }

  function hash(value) {
    let result = 5381;
    for (let index = 0; index < value.length; index++) result = ((result << 5) + result + value.charCodeAt(index)) >>> 0;
    return result.toString(36);
  }

  function showToast(text, ok = true) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = make('div', 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 14px;border-radius:6px;font:12px Segoe UI,Arial,sans-serif;color:#fff;box-shadow:0 6px 22px rgba(0,0,0,.35);transition:opacity .2s;max-width:380px;pointer-events:none;');
      toastEl.dataset.meldrixUi = '1';
      toastEl.dataset.meldrixVersion = VERSION;
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = ok ? '#2f5d50' : '#6b3434';
    toastEl.style.opacity = '1';
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 4200);
  }

  function runtimeMessage(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, code: 'EXTENSION_UPDATED', error: /context invalidated/i.test(error.message || '') ? 'Meldrix was updated. Reload this page once to finish.' : 'Could not reach the Meldrix extension.' });
            return;
          }
          resolve(response || { ok: false, code: 'NO_RESPONSE', error: 'Meldrix did not respond.' });
        });
      } catch {
        resolve({ ok: false, code: 'EXTENSION_UPDATED', error: 'Meldrix was updated. Reload this page once to finish.' });
      }
    });
  }

  function sendDownload(payload) {
    return runtimeMessage({ type: 'enqueue', ...payload });
  }

  function probe(url) {
    return runtimeMessage({ type: 'media:probe', url });
  }

  function getTabSources() {
    return runtimeMessage({ type: 'media:tab' }).then(response => (response && Array.isArray(response.items) ? response.items : []));
  }

  function filenameOf(url) {
    try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'media'); }
    catch { return 'media'; }
  }

  function absolute(value, base = location.href) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value, base);
      return /^https?:$/i.test(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function directSources(element) {
    const values = [
      element.currentSrc,
      element.src,
      element.getAttribute('src'),
      element.getAttribute('data-src'),
      element.getAttribute('data-video-src'),
      element.getAttribute('data-mp4'),
      element.getAttribute('data-webm'),
      element.getAttribute('data-mov'),
      element.getAttribute('data-hls'),
      element.getAttribute('data-dash')
    ];
    element.querySelectorAll('source[src],source[data-src],source[data-hls],source[data-dash]').forEach(source => {
      values.push(source.getAttribute('src'), source.getAttribute('data-src'), source.getAttribute('data-hls'), source.getAttribute('data-dash'));
    });
    const result = [];
    for (const value of values) {
      if (!value) continue;
      const url = absolute(value);
      if (url && !result.includes(url)) result.push(url);
    }
    return result;
  }

  function mediaKindOf(url) {
    if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
    if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
    return 'file';
  }

  function mimeFor(url, element) {
    if (element && element.tagName === 'AUDIO') return 'audio/mpeg';
    if (/\.webm(?:[?#]|$)/i.test(url)) return 'video/webm';
    if (/\.mov(?:[?#]|$)/i.test(url)) return 'video/quicktime';
    if (/\.m4a(?:[?#]|$)/i.test(url)) return 'audio/mp4';
    if (/\.mp3(?:[?#]|$)/i.test(url)) return 'audio/mpeg';
    if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
    if (/\.mpd(?:[?#]|$)/i.test(url)) return 'application/dash+xml';
    return 'video/mp4';
  }

  function baseTitle() {
    const value = (document.title || location.hostname || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
    return (value || 'video').slice(0, 80);
  }

  function formatBytes(size) {
    if (!size) return '';
    if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`;
    if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`;
    return `${(size / 1e3).toFixed(0)} KB`;
  }

  function metaFor(variant, result) {
    const parts = [];
    if (variant.height) parts.push(`${variant.width ? `${variant.width}×` : ''}${variant.height}p`);
    if (variant.container) parts.push(variant.container);
    if (variant.codecs) parts.push(variant.codecs);
    if (variant.bandwidth) parts.push(`${(variant.bandwidth / 1e6).toFixed(1)} Mbps`);
    const size = variant.size || (variant.kind === 'file' ? result.size : 0);
    if (size) parts.push(formatBytes(size));
    if (variant.audioOnly) parts.push('audio only');
    if (variant.unsupported) parts.push(variant.unsupported);
    return parts.join(' · ');
  }

  function extensionFor(result, variant) {
    const kind = variant.kind || result.kind;
    if (kind === 'hls') return variant.audioOnly ? '.m4a' : '.mp4';
    if (kind === 'dash') return variant.container === 'WebM' ? '.webm' : variant.audioOnly ? '.m4a' : '.mp4';
    const match = /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|wav|flac|ogg)(?:[?#]|$)/i.exec(variant.url);
    return match ? `.${match[1].toLowerCase()}` : '.mp4';
  }

  function desiredName(result, variant, context) {
    const filename = variant.filename || result.filename || '';
    if (/\.(mp4|webm|mov|mkv|m4v|mp3|m4a|wav|flac|ogg)(?:[?#]|$)/i.test(filename)) {
      if (variant.height) return filename.replace(/(\.[a-z0-9]+)(?:[?#].*)?$/i, `-${variant.height}p$1`);
      return filename.replace(/[?#].*$/, '');
    }
    const suffix = variant.height ? `-${variant.height}p` : variant.audioOnly ? '-audio' : '';
    return `${baseTitle()}${suffix}${extensionFor(result, variant)}`;
  }

  function buildPayload(result, variant, context, fallbackUrl) {
    const url = variant.url || fallbackUrl;
    const kind = variant.kind || result.kind;
    return {
      url,
      name: desiredName(result, variant, context),
      mimeType: variant.mimeType || result.mimeType || mimeFor(url, context.element),
      kind: kind === 'hls' ? 'hls' : 'file',
      quality: variant.label || '',
      size: variant.size || (kind === 'file' ? result.size || 0 : 0),
      referrer: location.href,
      source: 'media-overlay',
      requestId: `overlay-${hash(`${url}|${variant.label || ''}`)}`
    };
  }

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
    panelAnchor = null;
    panelButton = null;
  }

  function placePanel(anchor) {
    if (!panel) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(376, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 430));
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }

  function createPanel(anchor, button) {
    closePanel();
    panelAnchor = anchor;
    panelButton = button;
    panel = make('div', 'position:fixed;z-index:2147483647;max-height:420px;overflow:auto;background:#1f242c;border:1px solid #3b4553;border-radius:8px;box-shadow:0 16px 42px rgba(0,0,0,.55);color:#d8dee9;font:12px Segoe UI,Arial,sans-serif;padding:0;');
    panel.dataset.meldrixUi = '1';
    panel.dataset.meldrixVersion = VERSION;

    const head = make('div', 'display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid #343d49;background:#252b34;border-radius:8px 8px 0 0;');
    head.appendChild(make('span', 'width:18px;height:18px;border-radius:4px;background:#4d71ee;color:#fff;display:grid;place-items:center;font-weight:700;', '↓'));
    head.appendChild(make('b', 'flex:1;color:#eef2f7;font-size:12px;', 'Download with Meldrix'));
    const close = make('button', 'border:0;background:transparent;color:#98a3b3;font-size:16px;cursor:pointer;line-height:1;', '×');
    close.type = 'button';
    close.onclick = closePanel;
    head.appendChild(close);
    panel.appendChild(head);

    const body = make('div', 'padding:12px;');
    panel.appendChild(body);
    const status = make('div', 'padding:0 12px 12px;color:#8b95a5;font-size:10px;min-height:16px;');
    panel.appendChild(status);

    document.documentElement.appendChild(panel);
    placePanel(anchor);
    return { body, status };
  }

  function setStatus(status, text, color = '#8b95a5') {
    status.textContent = text;
    status.style.color = color;
  }

  function renderError(body, status, message, context) {
    body.innerHTML = '';
    body.appendChild(make('div', 'padding:10px;border:1px solid #5c4540;background:#2c2523;color:#d9aaa1;border-radius:5px;line-height:1.5;font-size:11px;', message));
    const actions = make('div', 'display:flex;gap:8px;margin-top:10px;');
    const retry = make('button', 'flex:1;height:30px;border:1px solid #4d6fc4;background:#33477b;color:#c6d4ff;border-radius:4px;cursor:pointer;font-size:11px;', 'Try again');
    retry.type = 'button';
    retry.onclick = () => loadOptions(body, status, context);
    const open = make('button', 'flex:1;height:30px;border:1px solid #444d5b;background:#242a32;color:#b8c2d1;border-radius:4px;cursor:pointer;font-size:11px;', 'Open Meldrix');
    open.type = 'button';
    open.onclick = () => runtimeMessage({ type: 'show' });
    actions.append(retry, open);
    body.appendChild(actions);
    setStatus(status, 'No download was started.', '#c08f85');
  }

  function renderOptions(body, status, result, context) {
    body.innerHTML = '';
    const supported = result.variants.filter(variant => !variant.unsupported);
    if (!supported.length) {
      renderError(body, status, result.error || 'No supported format was discovered for this source.', context);
      return;
    }
    const summary = make('div', 'color:#8792a3;font-size:10px;margin-bottom:9px;line-height:1.5;', `${result.kind === 'hls' ? 'HLS stream' : result.kind === 'dash' ? 'DASH stream' : 'Direct media'} · ${supported.length} discovered ${supported.length === 1 ? 'format' : 'formats'}`);
    body.appendChild(summary);
    if (result.error) {
      body.appendChild(make('div', 'padding:8px;margin-bottom:9px;border:1px solid #5c4b36;background:#2e2920;color:#e0c08a;border-radius:4px;font-size:10px;line-height:1.45;', result.error));
    }

    let selected = supported[0];
    const group = `meldrix-quality-${Date.now()}`;
    result.variants.forEach(variant => {
      const label = make('label', `display:flex;gap:9px;align-items:flex-start;padding:9px;border:1px solid ${variant === selected ? '#4d68a9' : '#343d49'};border-radius:5px;background:${variant === selected ? '#232d42' : '#1b2027'};margin-bottom:6px;cursor:${variant.unsupported ? 'not-allowed' : 'pointer'};opacity:${variant.unsupported ? '.55' : '1'};`);
      const radio = make('input', 'margin-top:2px;accent-color:#5c7fe8;');
      radio.type = 'radio';
      radio.name = group;
      radio.disabled = !!variant.unsupported;
      radio.checked = variant === selected;
      radio.onchange = () => { selected = variant; };
      const text = make('div', 'min-width:0;flex:1;');
      text.appendChild(make('div', 'color:#e3e9f2;font-size:11px;font-weight:600;', variant.label));
      const meta = metaFor(variant, result);
      if (meta) text.appendChild(make('div', 'color:#8b95a5;font-size:10px;margin-top:2px;line-height:1.45;word-break:break-word;', meta));
      label.append(radio, text);
      body.appendChild(label);
    });

    const download = make('button', 'width:100%;height:34px;margin-top:7px;border:0;border-radius:5px;background:#4d71ee;color:#fff;font-weight:600;font-size:12px;cursor:pointer;', 'Download with Meldrix');
    download.type = 'button';
    download.onclick = async () => {
      if (!selected || download.disabled) return;
      download.disabled = true;
      download.textContent = 'Sending to Meldrix…';
      setStatus(status, 'Sending to Meldrix. It starts automatically if needed.', '#9aa6b7');
      const slow = setTimeout(() => setStatus(status, 'Meldrix is starting… waiting for the desktop to become ready.', '#c9b27a'), 1500);
      const response = await sendDownload(buildPayload(result, selected, context, selected.url));
      clearTimeout(slow);
      if (response.ok) {
        download.textContent = 'Sent to Meldrix';
        setStatus(status, settings.confirmBeforeDownload ? 'Review the Add Download dialog in the desktop app.' : 'Download added and started in Meldrix.', '#82d1b4');
        showToast('Sent to Meldrix Download Manager', true);
      } else {
        download.disabled = false;
        download.textContent = 'Try again';
        setStatus(status, response.error || 'Meldrix did not accept the request.', '#d9aaa1');
      }
    };
    body.appendChild(download);
    setStatus(status, 'Only formats discovered from the real media source are shown.');
  }

  async function loadOptions(body, status, context) {
    body.innerHTML = '';
    body.appendChild(make('div', 'padding:10px;color:#9aa6b7;font-size:11px;', 'Reading available video formats…'));
    setStatus(status, 'Probing the real media source. Protected and DRM content is rejected.');

    const tabItems = tabCache.items.length ? tabCache.items : await getTabSources();
    tabCache.items = tabItems;
    tabCache.at = Date.now();

    const candidates = [];
    const add = value => { if (value && !candidates.includes(value)) candidates.push(value); };
    context.directUrls.forEach(add);
    // Do not mix every media request on a multi-player page. Prefer the
    // player's own direct sources; if it is blob-backed, probe the most recent
    // actual manifest/media request exposed by webRequest.
    if (!candidates.length) {
      tabItems
        .filter(item => item.manifest || (item.kind === 'file' && item.media && VIDEO_TYPES.test(item.url)))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 1)
        .forEach(item => add(item.url));
    }

    if (!candidates.length) {
      renderError(body, status, context.directUrls.length
        ? 'This media source could not be inspected. It may be protected, session-bound, or a blob-only stream. Meldrix does not bypass DRM, authentication, or access controls.'
        : 'No downloadable media URL was exposed by this page. Blob-only, protected and DRM video cannot be downloaded. Start playback, then try again.', context);
      return;
    }

    let lastError = '';
    let primary = null;
    const merged = [];
    const seen = new Set();
    for (const candidate of candidates.slice(0, 6)) {
      const response = await probe(candidate);
      if (!response.ok) { lastError = response.error || lastError; continue; }
      const result = response.result;
      if (!result) continue;
      if (result.drm || result.live) { lastError = result.error || lastError; continue; }
      if (!result.variants || !result.variants.length) { lastError = result.error || lastError; continue; }
      primary = primary || result;
      for (const variant of result.variants) {
        const key = `${variant.url}|${variant.label || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const copy = { ...variant, kind: result.kind, filename: variant.filename || result.filename || '' };
        if (result.kind === 'file' && context.element) {
          const width = context.element.videoWidth || 0;
          const height = context.element.videoHeight || 0;
          if (width && height && !copy.width && !copy.height) { copy.width = width; copy.height = height; copy.label = `${height}p`; }
        }
        merged.push(copy);
      }
    }

    if (!merged.length || !primary) {
      renderError(body, status, lastError || 'No downloadable format was found for this video. The page may use DRM or a protected stream.', context);
      return;
    }

    merged.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0) || (b.size || 0) - (a.size || 0));
    renderOptions(body, status, { ...primary, variants: merged }, context);
  }

  function openPanel(anchor, button, context) {
    const { body, status } = createPanel(anchor, button);
    loadOptions(body, status, context);
  }

  async function handleClick(button, element) {
    const context = {
      directUrls: directSources(element),
      audioOnly: element.tagName === 'AUDIO',
      element
    };

    const tabItems = await getTabSources();
    tabCache.items = tabItems;
    tabCache.at = Date.now();
    const manifests = tabItems.filter(item => item.manifest);
    const fileMedia = tabItems.filter(item => item.kind === 'file' && item.media && VIDEO_TYPES.test(item.url));
    const quick = context.directUrls.length === 1 && !manifests.length && fileMedia.length <= 1;

    if (quick) {
      const response = await probe(context.directUrls[0]);
      const result = response.ok ? response.result : null;
      const variants = result && Array.isArray(result.variants) ? result.variants : [];
      if (result && !result.drm && !result.live && variants.length === 1 && !variants[0].unsupported) {
        const variant = { ...variants[0], kind: result.kind, filename: variants[0].filename || result.filename || '' };
        if (result.kind === 'file' && element.videoWidth && element.videoHeight) {
          variant.width = variant.width || element.videoWidth;
          variant.height = variant.height || element.videoHeight;
          variant.label = variant.height ? `${variant.height}p` : variant.label;
        }
        button.disabled = true;
        const sent = await sendDownload(buildPayload(result, variant, context, context.directUrls[0]));
        button.disabled = false;
        if (sent.ok) {
          showToast(settings.confirmBeforeDownload ? 'Sent to Meldrix — review the Add Download dialog.' : 'Download added and started in Meldrix.', true);
          return;
        }
        showToast(sent.error || 'Meldrix did not accept the request.', false);
      }
    }
    openPanel(button, button, context);
  }

  function isAdLike(element) {
    const marker = (value) => `${value.id || ''} ${typeof value.className === 'string' ? value.className : ''} ${value.getAttribute ? value.getAttribute('aria-label') || '' : ''}`;
    if (/(^|[\s_-])(ad|ads|advert|advertisement|promo|sponsored|sponsor|preview|thumbnail|thumb)([\s_-]|$)/i.test(marker(element))) return true;
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      if (/(^|[\s_-])(ad|ads|advert|advertisement|promo|sponsored|sponsor)([\s_-]|$)/i.test(marker(parent))) return true;
    }
    return false;
  }

  function shouldAttach(element, hasTabMedia) {
    if (!element.isConnected) return false;
    if (element.mediaKeys) return false;
    if (isAdLike(element)) return false;
    if (element.tagName === 'VIDEO') {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (rect.width < 120 || rect.height < 68)) return false;
      if (!rect.width && !rect.height && !directSources(element).length && !hasTabMedia && element.readyState === 0) return false;
    }
    return true;
  }

  function attach(element, hasTabMedia) {
    if (!shouldAttach(element, hasTabMedia)) return;
    const direct = directSources(element);
    if (!direct.length && !hasTabMedia) return;

    const existing = tracked.get(element);
    if (existing) {
      const current = direct.join('|');
      if (existing.src === current && existing.button.isConnected) return;
      if (existing.button.isConnected) {
        existing.src = current;
        existing.button.dataset.url = direct[0] || '';
        return;
      }
      // The page removed our button; rebuild it from the current source.
      tracked.delete(element);
    }

    const parent = element.parentElement || document.body;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

    const button = make('button', 'position:absolute;top:10px;right:10px;z-index:2147483646;display:flex;align-items:center;gap:5px;padding:6px 9px;border:1px solid rgba(255,255,255,.22);border-radius:4px;background:#4b6fe0;color:#fff;font:600 11px Segoe UI,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);opacity:.92;transition:opacity .15s;');
    button.type = 'button';
    button.dataset.meldrixUi = '1';
    button.dataset.meldrixVersion = VERSION;
    button.dataset.url = direct[0] || '';
    button.setAttribute('aria-label', 'Download with Meldrix');
    button.title = 'Download with Meldrix';
    button.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg><span>Meldrix</span>';
    button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
    button.addEventListener('mouseleave', () => { button.style.opacity = '.92'; });
    button.addEventListener('mousedown', event => event.stopPropagation());
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      handleClick(button, element).catch(error => {
        showToast(error && error.message ? error.message : 'Meldrix could not inspect this video.', false);
      });
    });
    parent.appendChild(button);
    tracked.set(element, { button, src: direct.join('|') });
  }

  function prune() {
    for (const [element, entry] of Array.from(tracked)) {
      if (!element.isConnected || element.mediaKeys) {
        entry.button.remove();
        tracked.delete(element);
      }
    }
    if (panel && panelAnchor && !panelAnchor.isConnected) closePanel();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 300);
  }

  function scan() {
    if (!settings.overlay) return;
    const elements = document.querySelectorAll('video,audio');
    const hasTabMedia = tabCache.items.some(item => item.manifest || item.media);
    let needsTabSources = false;
    elements.forEach(element => {
      if (!directSources(element).length) needsTabSources = true;
      attach(element, hasTabMedia);
    });
    if (needsTabSources && Date.now() - tabCache.at > 4000) {
      tabCache.at = Date.now();
      getTabSources().then(items => {
        if (JSON.stringify(items) !== JSON.stringify(tabCache.items)) {
          tabCache.items = items;
          scheduleScan();
        }
      });
    }
    prune();
  }

  function resetForNavigation() {
    closePanel();
    tracked.forEach(entry => entry.button.remove());
    tracked.clear();
    tabCache.items = [];
    tabCache.at = 0;
    scheduleScan();
  }

  function checkNavigation() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      resetForNavigation();
    }
  }

  document.addEventListener('click', async event => {
    if (!settings.intercept || event.defaultPrevented || event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!target || !target.closest || target.closest('[data-meldrix-ui]')) return;
    const anchor = target.closest('a[href]');
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { return; }
    if (!/^https?:$/i.test(url.protocol) || !SUPPORTED.test(url.pathname)) return;
    event.preventDefault();
    const response = await sendDownload({
      url: url.href,
      name: filenameOf(url.href),
      mimeType: '',
      kind: 'file',
      referrer: location.href,
      source: 'link',
      requestId: `link-${hash(url.href)}`
    });
    if (response.ok) {
      showToast('Sent to Meldrix Download Manager', true);
    } else {
      showToast(response.error || 'Meldrix did not accept the link.', false);
      setTimeout(() => { window.location.assign(url.href); }, 600);
    }
  }, true);

  document.addEventListener('loadedmetadata', event => {
    if (event.target && (event.target.tagName === 'VIDEO' || event.target.tagName === 'AUDIO')) scheduleScan();
  }, true);
  document.addEventListener('emptied', event => {
    if (event.target && (event.target.tagName === 'VIDEO' || event.target.tagName === 'AUDIO')) scheduleScan();
  }, true);
  document.addEventListener('play', event => {
    if (event.target && (event.target.tagName === 'VIDEO' || event.target.tagName === 'AUDIO')) scheduleScan();
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message && message.type === 'rescan') {
      scheduleScan();
      reply({ ok: true });
      return false;
    }
    if (message && message.type === 'content:ping') {
      reply({ ok: true, version: VERSION });
      return false;
    }
    return false;
  });

  window.addEventListener('popstate', checkNavigation);
  window.addEventListener('hashchange', checkNavigation);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  setInterval(checkNavigation, 1500);
  setInterval(() => { if (!document.hidden) scheduleScan(); }, 5000);
  document.addEventListener('DOMContentLoaded', scheduleScan);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closePanel(); }, true);
  document.addEventListener('click', event => {
    if (!panel) return;
    if (panel.contains(event.target) || (panelButton && panelButton.contains(event.target))) return;
    closePanel();
  }, true);
  window.addEventListener('resize', () => { if (panel && panelAnchor) placePanel(panelAnchor); });
  scan();
})();
