// Settings page logic — auto-saves on every change.

const DEFAULTS = {
  defaultPrayerTime: 5,
  extendedPrayerTime: 20,
  whitelistedSites: [
    'PLHcBUkwitvcO52am3hK9AQPr1CKk9adSP',
    'PLHcBUkwitvcMxESxOvZSQY_OZ1qWw9X1U',
    'PLHcBUkwitvcNfuhdyZIO8uldRlQYOndTS',
  ],
  exportSubfolder: 'Prayers',
  blockMusicVideos: false,
  disableMusicPlayback: true,
};

const inputs = {
  defaultPrayerTime: document.getElementById('default-prayer-time'),
  extendedPrayerTime: document.getElementById('extended-prayer-time'),
  exportSubfolder: document.getElementById('export-subfolder'),
  blockMusicVideos: document.getElementById('block-music-videos'),
  disableMusicPlayback: document.getElementById('disable-music-playback'),
};

const urlList = document.getElementById('url-list');
const addUrlBtn = document.getElementById('add-url-btn');
const chooseDirBtn = document.getElementById('choose-dir-btn');
const saveStatus = document.getElementById('save-status');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');

let whitelistedSites = [...DEFAULTS.whitelistedSites];
// Per-row metadata: title + isPlaylist. Keyed by index in whitelistedSites.
let urlMeta = {};
// Set of indices currently in "edit mode" (showing the URL input).
const editingRows = new Set();

// ── Small utility helpers ──────────────────────────────────────

function escapeHtml(text) {
  // Defensive helper: also used by anything that may fall back to innerHTML
  // (none currently does, but defining it locally prevents a stray
  // ReferenceError if a stale cached script reaches for it).
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function safeString(v) {
  return typeof v === 'string' ? v : '';
}

function isPlaylistId(id) {
  return typeof id === 'string' && id.startsWith('PL');
}

function urlToDisplay(id) {
  const s = safeString(id);
  if (!s) return '';
  if (isPlaylistId(s)) {
    return `https://www.youtube.com/playlist?list=${s}`;
  }
  return s;
}

function displayToId(url) {
  const s = safeString(url).trim();
  if (!s) return null;
  if (s.includes('youtube.com/playlist?list=')) {
    return s.split('list=')[1].split('&')[0];
  }
  if (s.includes('youtube.com/watch?v=')) {
    return s.split('v=')[1].split('&')[0];
  }
  return s;
}

// ── Title lookups ──────────────────────────────────────────────
//
// Videos  → youtube.com/oembed (no API key, returns the video title).
// Playlists → fetch the public playlist HTML and read the <title> tag,
//             stripping the trailing " - YouTube" suffix. This works in
//             browsers and in extension pages served via chrome-extension://
//             because YouTube does NOT lock down CORS for these requests.
//             We fall back to a friendly placeholder if the fetch fails.

function fetchVideoTitle(videoId) {
  return new Promise((resolve) => {
    const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(data => resolve({ title: (data && data.title) || videoId, isPlaylist: false }))
      .catch(() => resolve({ title: null, isPlaylist: false, error: true }));
  });
}

function fetchPlaylistTitle(playlistId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
    fetch(url, { credentials: 'omit' })
      .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(html => {
        // <title>Playlist Name - YouTube</title>
        const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (!m) return resolve({ title: null, isPlaylist: true, error: true });
        let t = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        // Strip trailing " - YouTube"
        t = t.replace(/\s*-\s*YouTube\s*$/i, '').trim();
        // YouTube SSR returns "undefined - YouTube" when the page can't
        // resolve the playlist client-side. Treat that as a missing title
        // so the caller falls back to a placeholder.
        if (!t || t.toLowerCase() === 'undefined') {
          return resolve({ title: null, isPlaylist: true, error: true });
        }
        resolve({ title: t, isPlaylist: true });
      })
      .catch(() => resolve({ title: null, isPlaylist: true, error: true }));
  });
}

function resolveMeta(id) {
  const s = safeString(id);
  if (!s) return Promise.resolve({ title: '', isPlaylist: false, error: false });
  if (isPlaylistId(s)) {
    return fetchPlaylistTitle(s);
  }
  return fetchVideoTitle(s);
}

// ── Rendering ──────────────────────────────────────────────────

function renderUrlBoxes() {
  urlList.innerHTML = '';

  // Ensure meta has an entry for every site, and trigger async lookups
  whitelistedSites.forEach((id, index) => {
    if (!urlMeta[index]) {
      urlMeta[index] = { title: '', isPlaylist: isPlaylistId(id), error: false, loading: !!id };
      if (id) {
        resolveMeta(id).then(meta => {
          urlMeta[index] = { ...meta, loading: false };
          // The row may have been removed while the fetch was in flight
          if (whitelistedSites[index] === id) {
            const row = urlList.querySelector(`[data-row-idx="${index}"]`);
            if (row) replaceRowContent(row, index);
          }
        });
      }
    }
  });

  whitelistedSites.forEach((id, index) => {
    const row = document.createElement('div');
    row.className = 'url-row';
    row.setAttribute('data-row-idx', String(index));
    if (editingRows.has(index)) row.classList.add('is-editing');
    replaceRowContent(row, index);
    urlList.appendChild(row);
  });
}

// Build either the preview mode OR the edit mode inside the given row
function replaceRowContent(row, index) {
  row.innerHTML = '';
  if (editingRows.has(index)) {
    buildEditMode(row, index);
  } else {
    buildPreviewMode(row, index);
  }
}

// ── Preview mode: title card fills the row ─────────────────────
function buildPreviewMode(row, index) {
  const id = safeString(whitelistedSites[index]);

  const titleEl = document.createElement('div');
  titleEl.className = 'url-title';
  titleEl.setAttribute('data-title-idx', String(index));
  titleEl.title = 'Click to edit URL  •  Right-click to set a custom label';
  populatePreview(titleEl, index);

  titleEl.addEventListener('click', () => {
    // Enter edit mode for this row
    editingRows.add(index);
    const r = urlList.querySelector(`[data-row-idx="${index}"]`);
    if (r) {
      replaceRowContent(r, index);
      const input = r.querySelector('input');
      if (input) { input.focus(); input.select(); }
    }
  });

  // Right-click → rename cosmetic label
  titleEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const meta = urlMeta[index] || {};
    const current = meta.customLabel || meta.title || '';
    const next = window.prompt('Label for this entry:', current);
    if (next === null) return;
    urlMeta[index] = { ...meta, customLabel: next.trim() };
    populatePreview(titleEl, index);
  });

  const editBtn = document.createElement('button');
  editBtn.className = 'url-edit-btn';
  editBtn.title = 'Edit URL';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editingRows.add(index);
    const r = urlList.querySelector(`[data-row-idx="${index}"]`);
    if (r) {
      replaceRowContent(r, index);
      const input = r.querySelector('input');
      if (input) { input.focus(); input.select(); }
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'url-remove-btn';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    whitelistedSites.splice(index, 1);
    const nextMeta = {};
    Object.keys(urlMeta).forEach(k => {
      const ki = parseInt(k, 10);
      if (ki < index) nextMeta[ki] = urlMeta[ki];
      else if (ki > index) nextMeta[ki - 1] = urlMeta[ki];
    });
    urlMeta = nextMeta;
    editingRows.delete(index);
    // Adjust any open editor indices that point past the removed row
    const shifted = new Set();
    editingRows.forEach(i => { shifted.add(i > index ? i - 1 : i); });
    editingRows.clear();
    shifted.forEach(i => editingRows.add(i));
    renderUrlBoxes();
    saveSettings();
  });

  row.appendChild(titleEl);
  row.appendChild(editBtn);
  row.appendChild(removeBtn);
}

function populatePreview(titleEl, index) {
  const meta = urlMeta[index] || {};
  const display = meta.customLabel || meta.title || '';
  titleEl.classList.remove('is-loading', 'is-error');

  titleEl.textContent = '';

  const head = document.createElement('div');
  head.className = 'url-title-head';

  const icon = document.createElement('span');
  icon.className = 'url-title-icon';
  icon.textContent = '▶';
  head.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'url-title-text';
  const id = safeString(whitelistedSites[index]);

  if (meta.loading) {
    titleEl.classList.add('is-loading');
    text.textContent = 'Loading preview…';
  } else if (meta.error) {
    titleEl.classList.add('is-error');
    // Friendly fallback: show a shortened playlist/video ID so the user
    // can still tell rows apart, and they can right-click to set a label.
    text.textContent = id
      ? (isPlaylistId(id) ? `Playlist ${id.slice(0, 4)}…${id.slice(-4)}`
                          : `Video ${id.slice(0, 4)}…${id.slice(-4)}`)
      : 'Preview unavailable';
  } else {
    text.textContent = display || '(untitled)';
  }
  head.appendChild(text);

  if (meta.isPlaylist && !meta.loading && !meta.error) {
    const badge = document.createElement('span');
    badge.className = 'url-title-badge';
    badge.textContent = 'Playlist';
    head.appendChild(badge);
  }
  titleEl.appendChild(head);

  const hint = document.createElement('span');
  hint.className = 'url-title-hint';
  if (meta.loading) hint.textContent = '';
  else if (meta.error) hint.textContent = 'YouTube title not available — right-click to set a label';
  else hint.textContent = 'Click to edit URL';
  titleEl.appendChild(hint);
}

// ── Edit mode: full URL input + Done button ────────────────────
function buildEditMode(row, index) {
  const id = safeString(whitelistedSites[index]);
  const wrap = document.createElement('div');
  wrap.className = 'url-edit';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = urlToDisplay(id);
  input.placeholder = 'https://www.youtube.com/playlist?list=PL...';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  });
  // Auto-save the typed URL as the user edits (without leaving edit mode)
  input.addEventListener('input', () => {
    const newId = displayToId(input.value);
    const oldId = whitelistedSites[index];
    if (newId) {
      whitelistedSites[index] = newId;
      if (newId !== oldId) {
        urlMeta[index] = { title: '', isPlaylist: isPlaylistId(newId), error: false, loading: true };
        populatePreview(urlList.querySelector(`[data-title-idx="${index}"]`) || document.createElement('div'), index);
        resolveMeta(newId).then(meta => {
          if (whitelistedSites[index] === newId) {
            urlMeta[index] = { ...meta, loading: false };
          }
        });
      }
    } else {
      whitelistedSites[index] = '';
    }
    saveSettings();
  });

  function commitEdit() {
    // Save & exit edit mode (preview will re-fetch on next render)
    editingRows.delete(index);
    const r = urlList.querySelector(`[data-row-idx="${index}"]`);
    if (r) replaceRowContent(r, index);
    saveSettings();
  }
  function cancelEdit() {
    // Discard in-progress edits and restore from storage
    editingRows.delete(index);
    renderUrlBoxes();
  }

  const doneBtn = document.createElement('button');
  doneBtn.className = 'url-edit-done';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', commitEdit);

  wrap.appendChild(input);
  wrap.appendChild(doneBtn);
  row.appendChild(wrap);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'url-remove-btn';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    whitelistedSites.splice(index, 1);
    const nextMeta = {};
    Object.keys(urlMeta).forEach(k => {
      const ki = parseInt(k, 10);
      if (ki < index) nextMeta[ki] = urlMeta[ki];
      else if (ki > index) nextMeta[ki - 1] = urlMeta[ki];
    });
    urlMeta = nextMeta;
    editingRows.delete(index);
    const shifted = new Set();
    editingRows.forEach(i => { shifted.add(i > index ? i - 1 : i); });
    editingRows.clear();
    shifted.forEach(i => editingRows.add(i));
    renderUrlBoxes();
    saveSettings();
  });
  row.appendChild(removeBtn);
}

// ── Add URL ────────────────────────────────────────────────────
function addUrlBox() {
  whitelistedSites.push('');
  urlMeta[whitelistedSites.length - 1] = { title: '', isPlaylist: false, loading: false };
  const newIdx = whitelistedSites.length - 1;
  editingRows.add(newIdx);
  renderUrlBoxes();
  const row = urlList.querySelector(`[data-row-idx="${newIdx}"]`);
  const input = row && row.querySelector('input');
  if (input) { input.focus(); }
}

// ── Persistence ────────────────────────────────────────────────

function readSettings() {
  return {
    defaultPrayerTime: parseInt(inputs.defaultPrayerTime.value) || DEFAULTS.defaultPrayerTime,
    extendedPrayerTime: parseInt(inputs.extendedPrayerTime.value) || DEFAULTS.extendedPrayerTime,
    whitelistedSites: whitelistedSites.filter(id => safeString(id).trim().length > 0),
    exportSubfolder: inputs.exportSubfolder.value.trim(),
    blockMusicVideos: !!inputs.blockMusicVideos.checked,
    disableMusicPlayback: !!inputs.disableMusicPlayback.checked,
  };
}

function saveSettings() {
  const settings = readSettings();
  chrome.storage.local.set(settings, () => {
    showStatus('Settings saved!');
  });
}

function loadSettings() {
  chrome.storage.local.get(DEFAULTS, (settings) => {
    inputs.defaultPrayerTime.value = settings.defaultPrayerTime;
    inputs.extendedPrayerTime.value = settings.extendedPrayerTime;
    inputs.exportSubfolder.value = settings.exportSubfolder;
    inputs.blockMusicVideos.checked = settings.blockMusicVideos === true;
    inputs.disableMusicPlayback.checked = settings.disableMusicPlayback !== false;
    const sites = Array.isArray(settings.whitelistedSites)
      ? settings.whitelistedSites.filter(s => typeof s === 'string')
      : DEFAULTS.whitelistedSites;
    whitelistedSites = [...sites];
    urlMeta = {};
    editingRows.clear();
    renderUrlBoxes();
  });
}

function showStatus(msg) {
  saveStatus.textContent = msg;
  setTimeout(() => { saveStatus.textContent = ''; }, 2000);
}

// ── Wire up events ─────────────────────────────────────────────

Object.values(inputs).forEach(el => {
  el.addEventListener('input', saveSettings);
});

addUrlBtn.addEventListener('click', addUrlBox);

chooseDirBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker();
    chrome.storage.local.set({ customExportDirectoryHandle: handle }, () => {
      showStatus('Folder selected!');
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Folder selection failed:', err);
    }
  }
});

saveBtn.addEventListener('click', () => {
  saveSettings();
});

resetBtn.addEventListener('click', () => {
  inputs.defaultPrayerTime.value = DEFAULTS.defaultPrayerTime;
  inputs.extendedPrayerTime.value = DEFAULTS.extendedPrayerTime;
  inputs.exportSubfolder.value = DEFAULTS.exportSubfolder;
  inputs.blockMusicVideos.checked = DEFAULTS.blockMusicVideos;
  inputs.disableMusicPlayback.checked = DEFAULTS.disableMusicPlayback;
  whitelistedSites = [...DEFAULTS.whitelistedSites];
  urlMeta = {};
  editingRows.clear();
  renderUrlBoxes();
  saveSettings();
  showStatus('Reset to defaults');
});

// Initial load
loadSettings();