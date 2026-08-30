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
// Shows remaining *playback* minutes (i.e. minutes while a video is
// currently playing), not wall-clock minutes since the prayer was submitted.
function updateTimerDisplay() {
  const SESSION_KEY = '_prayerSession';
  chrome.storage.local.get({ [SESSION_KEY]: {} }, (result) => {
    const state = result[SESSION_KEY] || {};
    if (!state.prayer_completed) {
      timerEl.textContent = '—';
      return;
    }
    const timeout = state.prayer_timeout_ms || 0;
    let played = state.prayer_played_ms || 0;
    // Include the in-progress play run, capped defensively
    if (state.prayer_playing_since) {
      const delta = Date.now() - state.prayer_playing_since;
      played += Math.min(Math.max(delta, 0), 5 * 60 * 1000);
    }
    const remaining = timeout - played;
    if (remaining <= 0) {
      timerEl.textContent = 'Expired';
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const isLiveRun = !!state.prayer_playing_since;
    timerEl.textContent = isLiveRun
      ? `${mins}m ${secs}s (playing)`
      : `${mins}m ${secs}s (paused)`;
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
