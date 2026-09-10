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
// `prayerJournal` supplies the new entries. When a folder handle is
// available, every export reads Prayers.txt first and appends only
// entries not already present, preserving the existing file contents.

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

function journalEntryKey(entry) {
  return `${entry.date || ''}|${entry.time || ''}|${entry.type || 'prayer'}|${String(entry.text || '').trim()}`;
}

function parseJournalText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const headerRe = /^(.+?)\s+at\s+(.+?)(?:\s+\[Essay\])?\s*$/;
  const entries = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index];
    const match = header.match(headerRe);
    if (!match) {
      index += 1;
      continue;
    }

    const entry = {
      date: match[1],
      time: match[2],
      type: /\[Essay\]/.test(header) ? 'essay' : 'prayer',
      text: ''
    };
    index += 1;
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index < lines.length && /^-+$/.test(lines[index].trim())) index += 1;

    const body = [];
    while (index < lines.length && lines[index].trim() && !headerRe.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    entry.text = body.join('\n').trim();
    if (entry.text) entries.push(entry);
  }

  return entries;
}

function appendMissingEntries(existingText, prayers) {
  const existingEntries = parseJournalText(existingText);
  const existingKeys = new Set(existingEntries.map(journalEntryKey));
  const missing = prayers.filter(prayer => !existingKeys.has(journalEntryKey(prayer)));
  if (!missing.length) return existingText;

  let output = String(existingText || '');
  if (output && !output.endsWith('\n')) output += '\n';
  if (output && !output.endsWith('\n\n')) output += '\n';
  output += buildJournalText(missing);
  return output;
}

async function exportJournal() {
  const result = await chrome.storage.local.get({ prayerJournal: [] });
  const prayers = result.prayerJournal || [];

  // Read the target file on every export. This is intentional: it may
  // have been updated by Vivaldi or edited outside the extension.
  if (!prayers.length) return;

  const txt = buildJournalText(prayers);

  // Prefer the File System Access API folder if the user chose one
  if (customExportDirectoryHandle) {
    try {
      const permission = await customExportDirectoryHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const granted = await customExportDirectoryHandle.requestPermission({ mode: 'readwrite' });
        if (granted !== 'granted') {
          console.log('Permission denied for custom export folder; export cancelled');
          return;
        }
      }
      const fileHandle = await customExportDirectoryHandle.getFileHandle(EXPORT_FILENAME, { create: true });
      const existingFile = await fileHandle.getFile();
      const existingText = await existingFile.text();
      const mergedText = appendMissingEntries(existingText, prayers);
      const writable = await fileHandle.createWritable();
      await writable.write(mergedText);
      await writable.close();
      console.log('Prayer journal written to custom folder');
      return;
    } catch (err) {
      console.error('Failed to read or write the selected Prayers.txt:', err);
      return;
    }
  }

  // Fallback: write directly to Downloads as a stable filename
  return overwriteDownloads(txt);
}

// Fallback used when the File System Access API folder is NOT chosen.
//
// The downloads API can write a stable filename, but it cannot read an
// existing Downloads file. For true read/merge/preserve behavior, the
// user must choose the folder containing Prayers.txt in Settings first.
// This fallback is retained for first-run installs where no handle has
// been granted yet; it should not be used to merge an existing journal.
//
// If a user wants to merge entries from a different computer's journal
// (or recover a `Prayers.txt` that has drifted out of sync), they can
// use the "Import an existing Prayers.txt" affordance in settings.html
// BEFORE the next export runs.
async function overwriteDownloads(txt) {
  const base = EXPORT_SUBFOLDER ? `${EXPORT_SUBFOLDER}/` : '';
  const filename = `${base}${EXPORT_FILENAME}`;
  const blob = new Blob([txt], { type: 'text/plain' });
  await downloadBlob(blob, filename, 'overwrite');
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