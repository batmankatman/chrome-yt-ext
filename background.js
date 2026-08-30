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
// existing file; the Downloads fallback writes new entries to a new
// timestamped file so Prayers.txt is never overwritten).

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

  const blob = new Blob([txt], { type: 'text/plain' });
  const maxId = newEntries.reduce((m, p) => Math.max(m, p.id || 0), lastId);

  // If custom export folder is set, use File System Access API (append)
  if (customExportDirectoryHandle) {
    try {
      const permission = await customExportDirectoryHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const granted = await customExportDirectoryHandle.requestPermission({ mode: 'readwrite' });
        if (granted !== 'granted') {
          console.log('Permission denied for custom export folder, falling back to Downloads');
          return downloadNewEntries(blob, maxId);
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
      return downloadNewEntries(blob, maxId);
    }
  }

  // Fallback to Downloads folder (can't append, so write a new file)
  return downloadNewEntries(blob, maxId);
}

function downloadNewEntries(blob, maxId) {
  const reader = new FileReader();
  reader.onloadend = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = EXPORT_SUBFOLDER ? `${EXPORT_SUBFOLDER}/` : '';
    const fullPath = `${base}Prayers-${stamp}.txt`;

    chrome.downloads.download({
      url: reader.result,
      filename: fullPath,
      conflictAction: 'uniquify',
      saveAs: false
    }, () => {
      chrome.storage.local.set({ lastExportedId: maxId });
    });
  };
  reader.readAsDataURL(blob);
}

// ── Listen for export requests (from content script or popup) ────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'exportJournal') {
    exportJournal();
    sendResponse({ ok: true });
  }
  return true; // Keep the message channel open for async response
});
