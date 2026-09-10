  // Popup dashboard for Prayer Blocker

// ── DOM element references ────────────────────────────────
const totalEl = document.getElementById('total-count');
const essayEl = document.getElementById('essay-count');
const timerEl = document.getElementById('timer-remaining');
const statusEl = document.getElementById('status');
const settingsBtn = document.getElementById('settings-btn');

// ── Load and display counts ───────────────────────────────
function updateCounts() {
  chrome.storage.local.get({ prayerJournal: [] }, (result) => {
    const prayers = result.prayerJournal || [];
    const total = prayers.length;
    const essays = prayers.filter(p => p.type === 'essay').length;
    totalEl.textContent = total;
    essayEl.textContent = essays;
  });
}

// ── Timer remaining display ───────────────────────────────
// Prayer days roll over at 3:00 AM local time. This matches content.js
// so the popup cannot display a stale session after the daily reset.
function prayerDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(date.getHours() - 3);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function updateTimerDisplay() {
  const SESSION_KEY = '_prayerSession';
  chrome.storage.local.get({ [SESSION_KEY]: {} }, (result) => {
    const state = result[SESSION_KEY] || {};
    if (!state.prayer_completed || state.prayer_day_key !== prayerDayKey()) {
      if (state.prayer_completed && state.prayer_day_key !== prayerDayKey()) {
        chrome.storage.local.remove(SESSION_KEY);
      }
      timerEl.textContent = '—';
      return;
    }
    const timeout = state.prayer_timeout_ms || 0;
    const startedAt = state.prayer_timestamp || Date.now();
    const remaining = timeout - (Date.now() - startedAt);
    if (remaining <= 0) {
      timerEl.textContent = 'Expired';
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}m ${secs}s`;
  });
}

// ── Settings — open full-page settings tab
  settingsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  });

// Refresh counts and timer when storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.prayerJournal) updateCounts();
    if (changes._prayerSession) updateTimerDisplay();
  }
});

// Initial load
updateCounts();
updateTimerDisplay();
// Refresh timer every second while popup is open
setInterval(updateTimerDisplay, 1000);
