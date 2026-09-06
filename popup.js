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
// Shows remaining WALL-CLOCK minutes since the prayer was submitted
// (prayer_timestamp). The countdown always begins the moment a prayer
// is submitted — regardless of whether the video is currently playing.
// (Playback time is still used internally as the *block* trigger so a
// paused video doesn't burn through the budget on its own.)
function updateTimerDisplay() {
  const SESSION_KEY = '_prayerSession';
  chrome.storage.local.get({ [SESSION_KEY]: {} }, (result) => {
    const state = result[SESSION_KEY] || {};
    if (!state.prayer_completed) {
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
