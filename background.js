// Background service worker for YouTube Prayer Blocker (Chrome)

let EXPORT_SUBFOLDER = 'Prayers';
const EXPORT_FILENAME = 'Prayers.txt';
let customExportDirectoryHandle = null;

// Load settings on startup
chrome.storage.local.get({ exportSubfolder: 'Prayers' }, (result) => {
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

// ── Build the full Prayers.txt content from the journal ─────────
//
// `prayerJournal` is the single source of truth. Every export rebuilds
// the whole file from it and overwrites Prayers.txt on disk, so the
// filename is always stable (no Prayers-{timestamp}.txt shenanigans
// on Chrome). lastExportedId is tracked only to short-circuit when
// nothing has changed.

function buildJournalText(prayers) {
  // Oldest first so the file reads chronologically
  const sorted = [...prayers].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let txt = '';
  sorted.forEach(p => {
    txt += `${p.date} at ${p.time}${p.type === 'essay' ? ' [Essay]' : ''}\n`;
    txt += '-'.repeat(50) + '\n';
    txt += p.text + '\n\n';
  });
  return txt;
}

async function exportJournal() {
  const result = await chrome.storage.local.get({
    prayerJournal: [],
    lastExportedId: 0
  });
  const prayers = result.prayerJournal || [];

  // Skip the write only if the journal is empty (nothing to write) or
  // if nothing has changed since the last export. We rebuild the whole
  // file every time we write, so the on-disk content always matches
  // the journal exactly.
  const lastId = result.lastExportedId || 0;
  const newestId = prayers.reduce((m, p) => Math.max(m, p.id || 0), 0);
  if (!prayers.length) return;
  if (newestId <= lastId) return;

  const txt = buildJournalText(prayers);

  // Prefer the File System Access API folder if the user chose one
  if (customExportDirectoryHandle) {
    try {
      const permission = await customExportDirectoryHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const granted = await customExportDirectoryHandle.requestPermission({ mode: 'readwrite' });
        if (granted !== 'granted') {
          console.log('Permission denied for custom export folder, falling back to Downloads');
          return overwriteDownloads(txt, newestId);
        }
      }
      const fileHandle = await customExportDirectoryHandle.getFileHandle(EXPORT_FILENAME, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(txt);
      await writable.close();
      await chrome.storage.local.set({ lastExportedId: newestId });
      console.log('Prayer journal written to custom folder');
      return;
    } catch (err) {
      console.error('Failed to write to custom folder, falling back to Downloads:', err);
      return overwriteDownloads(txt, newestId);
    }
  }

  // Fallback: write directly to Downloads as a stable filename
  return overwriteDownloads(txt, newestId);
}

// Always write to {EXPORT_SUBFOLDER}/Prayers.txt with overwrite so the
// filename is stable. This avoids the timestamped Prayers-{stamp}.txt
// filenames Chrome was producing under the old per-entry append path.
async function overwriteDownloads(txt, newestId) {
  const base = EXPORT_SUBFOLDER ? `${EXPORT_SUBFOLDER}/` : '';
  const filename = `${base}${EXPORT_FILENAME}`;
  const blob = new Blob([txt], { type: 'text/plain' });
  await downloadBlob(blob, filename, 'overwrite');
  await chrome.storage.local.set({ lastExportedId: newestId });
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