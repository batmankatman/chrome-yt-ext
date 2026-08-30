// Background service worker for YouTube Prayer Blocker (Chrome)

let EXPORT_SUBFOLDER = 'Prayers';  // Changed default to 'Prayers'
const EXPORT_FILENAME = 'Prayers.txt';
let customExportDirectoryHandle = null;

// Load settings on startup
chrome.storage.local.get({ exportSubfolder: 'Prayers' }, (result) => {  // Changed default
  EXPORT_SUBFOLDER = result.exportSubfolder || 'Prayers';
});

// Load custom export directory handle if available
async function loadCustomExportHandle() {
  try {
    const result = await chrome.storage.local.get('customExportDirectoryHandle');
    if (result.customExportDirectoryHandle) {
      customExportDirectoryHandle = result.customExportDirectoryHandle;
    }
  } catch (e) {
    console.log('Could not load custom export handle:', e);
  }
}

loadCustomExportHandle();

// Listen for changes to exportSubfolder setting
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.exportSubfolder) {
    EXPORT_SUBFOLDER = changes.exportSubfolder.newValue || 'Prayers';
  }
  if (changes.customExportDirectoryHandle) {
    customExportDirectoryHandle = changes.customExportDirectoryHandle.newValue;
  }
});

// ── Export journal as a download ─────────────────────────
// Append-only: only entries not yet exported are written.
// Saves to {exportSubfolder}/Prayers.txt (FS API path appends to the
// existing file; the Downloads fallback reads any existing Prayers.txt
// and rewrites it with merged content so the file name stays stable).

async function exportJournal() {
  const result = await chrome.storage.local.get({
    prayerJournal: [],
    lastExportedId: 0
  });
  const prayers = result.prayerJournal || [];
  const lastId = result.lastExportedId || 0;

  // Only export entries we haven't exported yet
  const newEntries = prayers.filter(p => (p.id || 0) > lastId);
  if (!newEntries.length) return;

  // Oldest first so the file reads chronologically
  newEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  let txt = '';
  newEntries.forEach(p => {
    txt += `${p.date} at ${p.time}${p.type === 'essay' ? ' [Essay]' : ''}\n`;
    txt += '-'.repeat(50) + '\n';
    txt += p.text + '\n\n';
  });

  const maxId = newEntries.reduce((m, p) => Math.max(m, p.id || 0), lastId);

  // If custom export folder is set, use File System Access API (append)
  if (customExportDirectoryHandle) {
    try {
      const permission = await customExportDirectoryHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const granted = await customExportDirectoryHandle.requestPermission({ mode: 'readwrite' });
        if (granted !== 'granted') {
          console.log('Permission denied for custom export folder, falling back to Downloads');
          return downloadMergedToDownloads(txt, maxId);
        }
      }

      // Read existing content (if any) so we can append rather than overwrite
      let existing = '';
      try {
        const readHandle = await customExportDirectoryHandle.getFileHandle(EXPORT_FILENAME);
        const file = await readHandle.getFile();
        existing = await file.text();
      } catch (e) {
        // File doesn't exist yet — that's fine, we'll create it
      }

      const fileHandle = await customExportDirectoryHandle.getFileHandle(EXPORT_FILENAME, { create: true });
      const writable = await fileHandle.createWritable();
      const fullContent = existing ? existing + '\n' + txt : txt;
      await writable.write(fullContent);
      await writable.close();

      await chrome.storage.local.set({ lastExportedId: maxId });
      console.log('Prayer journal appended to custom folder');
      return;
    } catch (err) {
      console.error('Failed to write to custom folder, falling back to Downloads:', err);
      return downloadMergedToDownloads(txt, maxId);
    }
  }

  // Fallback to Downloads folder — append to existing Prayers.txt
  return downloadMergedToDownloads(txt, maxId);
}

// Try to find an existing Prayers.txt in Downloads, merge the new
// entries with its existing content, and write the merged result back
// to the same filename with conflictAction: 'overwrite'. This keeps
// the filename stable (no Prayers-{timestamp}.txt) and avoids losing
// previously exported entries.
async function downloadMergedToDownloads(txt, maxId) {
  try {
    const base = EXPORT_SUBFOLDER ? `${EXPORT_SUBFOLDER}/` : '';
    const filename = `${base}${EXPORT_FILENAME}`;
    const existing = await readExistingDownload(filename);
    const merged = existing ? existing + '\n' + txt : txt;
    const blob = new Blob([merged], { type: 'text/plain' });
    await downloadBlob(blob, filename, 'overwrite');
    await chrome.storage.local.set({ lastExportedId: maxId });
  } catch (err) {
    console.error('Failed to merge with existing Prayers.txt, writing new entries only:', err);
    // Last-resort: write a fresh file with just the new entries so
    // nothing is lost (the user can manually merge).
    const base = EXPORT_SUBFOLDER ? `${EXPORT_SUBFOLDER}/` : '';
    const filename = `${base}${EXPORT_FILENAME}`;
    const blob = new Blob([txt], { type: 'text/plain' });
    await downloadBlob(blob, filename, 'overwrite');
    await chrome.storage.local.set({ lastExportedId: maxId });
  }
}

// Search Chrome's download history for an existing file matching the
// given filename and read its contents (if the OS exposes them).
async function readExistingDownload(filename) {
  // The Downloads API's `filename` field is the full disk path on
  // Chrome OS / macOS / Linux / Windows, so we filter by endsWith to
  // match Prayers.txt inside the configured subfolder.
  const items = await new Promise((resolve) => {
    chrome.downloads.search({ filenameRegex: `/${escapeRegex(filename)}$` }, resolve);
  });
  if (!items || !items.length) return '';
  // Prefer the most recent successful download
  items.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  for (const item of items) {
    if (item.state !== 'complete') continue;
    if (!item.url) continue;
    try {
      // The download item exposes a `file` URL we can fetch
      // (chrome:// downloads expose file:// URLs to MV3 service workers).
      const r = await fetch(item.url);
        if (r.ok) return await r.text();
    } catch { /* try next */ }
  }
  return '';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function downloadBlob(blob, filename, conflictAction) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      chrome.downloads.download({
        url: reader.result,
        filename,
        conflictAction,
        saveAs: false
      }, (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err); else resolve(downloadId);
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── Listen for export requests (from content script or popup) ────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'exportJournal') {
    exportJournal();
    sendResponse({ ok: true });
  }
  return true; // Keep the message channel open for async response
});
