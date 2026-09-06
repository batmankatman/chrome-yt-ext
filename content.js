// YouTube Prayer Blocker Content Script (Chrome Extension)

(function () {
  'use strict';

  // Default values
  let PRAYER_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes for regular prayer
  let ESSAY_TIMEOUT_MS = 20 * 60 * 1000;    // 20 minutes for essay
  let ESSAY_MIN_WORDS = 50;
  let ALLOWED_PLAYLISTS = new Set([
    'PLHcBUkwitvcO52am3hK9AQPr1CKk9adSP',
    'PLHcBUkwitvcMxESxOvZSQY_OZ1qWw9X1U',
    'PLHcBUkwitvcNfuhdyZIO8uldRlQYOndTS',
  ]);
  let EXPORT_SUBFOLDER = 'Prayers';
  // Prayer blocking for music videos. When true, music videos are
  // treated like any other blockable video (the prayer overlay applies).
  // Default OFF — the toggle is named "Block Music Videos" but its
  // semantic is now: ON = block, OFF = don't block.
  let BLOCK_MUSIC_VIDEOS = false;
  // Hide only the picture (audio keeps playing) for music videos.
  // Default ON.
  let DISABLE_MUSIC_PLAYBACK = true;

  // Load settings from storage
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({
        defaultPrayerTime: 5,
        extendedPrayerTime: 20,
        whitelistedSites: [
          'PLHcBUkwitvcO52am3hK9AQPr1CKk9adSP',
          'PLHcBUkwitvcMxESxOvZSQY_OZ1qWw9X1U',
          'PLHcBUkwitvcNfuhdyZIO8uldRlQYOndTS'
        ],
        exportSubfolder: 'Prayers',
        blockMusicVideos: false,
        disableMusicPlayback: true,
      }, (settings) => {
        PRAYER_TIMEOUT_MS = settings.defaultPrayerTime * 60 * 1000;
        ESSAY_TIMEOUT_MS = settings.extendedPrayerTime * 60 * 1000;
        ALLOWED_PLAYLISTS = new Set(settings.whitelistedSites);
        EXPORT_SUBFOLDER = settings.exportSubfolder;
        BLOCK_MUSIC_VIDEOS = settings.blockMusicVideos === true;
        DISABLE_MUSIC_PLAYBACK = settings.disableMusicPlayback !== false;
        resolve();
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function currentVideoId() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('v') || '';
    } catch { return ''; }
  }

  // Only block watch pages that aren't already whitelisted.
  // When BLOCK_MUSIC_VIDEOS is on, music videos are *also* blockable
  // (the toggle's semantic is "should the prayer overlay apply to
  // music videos?" — ON = yes, OFF = no).
  function isBlockablePage() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    // Must be a /watch page with a video ID
    if (path !== '/watch' || !params.get('v')) return false;
    // Skip allowed playlists
    if (ALLOWED_PLAYLISTS.has(params.get('list'))) return false;
    return true;
  }

  function isMusicVideo() {
    // Primary signal: detector.js sets data-yt-music to "yes" / "no" after
    // checking category, meta genre, title keywords, auto-generated status,
    // and the verified-artist music badge.
    const flag = document.documentElement.getAttribute('data-yt-music');
    if (flag === 'yes') return true;
    if (flag === 'no') return false;
    // Fallback (in case detector.js hasn't run yet): category + meta tag
    const cat = document.documentElement.getAttribute('data-yt-category');
    if (cat === 'music') return true;
    const genre = document.querySelector('meta[itemprop="genre"]');
    if (genre && genre.content.toLowerCase() === 'music') return true;
    // Defensive: if neither detector nor meta-genre has fired yet, do
    // not declare this a non-music video — the caller will wait.
    return null;
  }

  // Wait for detector.js to set the category attribute (up to 5s)
  function waitForCategory() {
    return new Promise((resolve) => {
      if (document.documentElement.getAttribute('data-yt-category')) {
        resolve();
        return;
      }

      const observer = new MutationObserver(() => {
        if (document.documentElement.getAttribute('data-yt-category')) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-yt-category', 'data-yt-music'] });

      // Timeout fallback (5s — gives detector.js time to wait for
      // ytInitialPlayerResponse to populate)
      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 5000);
    });
  }

  // ── State helpers (chrome.storage.local with namespaced key) ────

  const SESSION_KEY = '_prayerSession';

  function getSessionState() {
    return new Promise(resolve => {
      chrome.storage.local.get({ [SESSION_KEY]: {} }, r => {
        resolve(r[SESSION_KEY] || {});
      });
    });
  }

  function setSessionState(timeoutMs) {
    // The session tracks BOTH wall-clock and playback time:
    //   - prayer_timestamp        → wall-clock start (always counts, for UI)
    //   - prayer_timeout_ms       → total budget in ms (shared)
    //   - prayer_played_ms        → accumulated playback ms
    //   - prayer_playing_since    → in-progress play run (null when paused)
    //
    // The VISIBLE countdown (popup + status) is WALL-CLOCK from
    // prayer_timestamp — every prayer submission immediately starts a
    // visible countdown regardless of whether the video is playing.
    // The BLOCK trigger uses PLAYBACK time (prayer_played_ms) so a
    // video left paused in the background won't burn through the user's
    // budget by itself.
    chrome.storage.local.set({
      [SESSION_KEY]: {
        prayer_completed: true,
        prayer_timestamp: Date.now(),   // wall-clock start; UI countdown anchor
        prayer_video_id: currentVideoId(),
        prayer_timeout_ms: timeoutMs,
        prayer_played_ms: 0,           // accumulated playback ms
        prayer_playing_since: null,    // set when video plays, cleared on pause
      }
    });
  }

  // ── Playback tracking ────────────────────────────────
  // We listen to the main video element's play/pause events and accumulate
  // the elapsed playing time into session.prayer_played_ms. The countdown
  // is therefore "minutes while a video is currently playing", not minutes
  // since the prayer was submitted.

  let lastSyncTimer = null;

  function syncPlayedMs() {
    getSessionState().then(state => {
      if (!state.prayer_completed) return;
      if (!state.prayer_playing_since) return;
      const now = Date.now();
      const delta = now - (state.prayer_playing_since || now);
      if (delta <= 0) return;
      // Cap delta defensively in case the tab was suspended for a long time
      const capped = Math.min(delta, 5 * 60 * 1000);
      const next = {
        ...state,
        prayer_played_ms: (state.prayer_played_ms || 0) + capped,
        prayer_playing_since: now,
      };
      chrome.storage.local.set({ [SESSION_KEY]: next });
      // If we just crossed the threshold, re-evaluate blocking
      if (next.prayer_played_ms >= (next.prayer_timeout_ms || Infinity)) {
        clearSessionState();
        if (isBlockablePage() && !document.getElementById('prayer-overlay')) {
          showBlockingOverlay();
        }
      }
    });
  }

  function attachPlaybackListeners() {
    // Find the main video (the one in #movie_player). YouTube re-creates
    // the <video> on navigation, so we observe the DOM and rebind.
    const bindTo = (video) => {
      if (!video || video.__prayerBound) return;
      video.__prayerBound = true;

      const markPlaying = () => {
        getSessionState().then(state => {
          if (!state.prayer_completed) return;
          if (state.prayer_playing_since) return; // already running
          chrome.storage.local.set({
            [SESSION_KEY]: { ...state, prayer_playing_since: Date.now() }
          });
          // Periodic flush so long plays don't lose precision on tab close
          if (lastSyncTimer) clearInterval(lastSyncTimer);
          lastSyncTimer = setInterval(syncPlayedMs, 5000);
        });
      };

      const markPaused = () => {
        if (lastSyncTimer) { clearInterval(lastSyncTimer); lastSyncTimer = null; }
        syncPlayedMs();
        getSessionState().then(state => {
          if (!state.prayer_completed) return;
          if (!state.prayer_playing_since) return;
          const delta = Date.now() - state.prayer_playing_since;
          const capped = Math.min(Math.max(delta, 0), 5 * 60 * 1000);
          chrome.storage.local.set({
            [SESSION_KEY]: {
              ...state,
              prayer_played_ms: (state.prayer_played_ms || 0) + capped,
              prayer_playing_since: null,
            }
          });
        });
      };

      video.addEventListener('play', markPlaying);
      video.addEventListener('playing', markPlaying);
      video.addEventListener('pause', markPaused);
      video.addEventListener('ended', markPaused);
      video.addEventListener('seeking', () => { /* ignore — still playing */ });
      // Do NOT pause the timer on tab hide: when the user returns to a
      // YouTube tab the timer should keep going. The 5-minute cap in
      // syncPlayedMs already prevents runaway accumulation if the tab
      // was suspended for hours.
    };

    const tryBind = () => {
      const video = document.querySelector('#movie_player video');
      if (video) bindTo(video);
    };

    tryBind();
    // Watch for the video element being replaced on SPA navigation
    const obs = new MutationObserver(tryBind);
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  }

  function detachPlaybackListeners() {
    if (lastSyncTimer) { clearInterval(lastSyncTimer); lastSyncTimer = null; }
  }

  // ── On-page countdown chip ───────────────────────────
  // While a prayer session is active (overlay dismissed), show a small
  // countdown chip in the top-right of the page so the user can see the
  // timer tick down without having to open the popup. The countdown is
  // wall-clock (prayer_timestamp → prayer_timeout_ms). Clicking the chip
  // opens the prayer journal for quick access.

  let countdownInterval = null;

  function startCountdownChip() {
    if (document.getElementById('prayer-countdown-chip')) return;
    const chip = document.createElement('div');
    chip.id = 'prayer-countdown-chip';
    chip.innerHTML = '<span id="prayer-countdown-chip-icon">🙏</span><span id="prayer-countdown-chip-text">…</span>';
    chip.addEventListener('click', () => showPrayerJournal());
    document.documentElement.appendChild(chip);
    updateCountdownChip();
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(updateCountdownChip, 1000);
  }

  function stopCountdownChip() {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    const chip = document.getElementById('prayer-countdown-chip');
    if (chip) chip.remove();
  }

  function updateCountdownChip() {
    const chip = document.getElementById('prayer-countdown-chip');
    if (!chip) return;
    const text = document.getElementById('prayer-countdown-chip-text');
    chrome.storage.local.get({ [SESSION_KEY]: {} }, (result) => {
      const state = result[SESSION_KEY] || {};
      if (!state.prayer_completed) { stopCountdownChip(); return; }
      const timeout = state.prayer_timeout_ms || PRAYER_TIMEOUT_MS;
      const startedAt = state.prayer_timestamp || Date.now();
      const remaining = timeout - (Date.now() - startedAt);
      if (remaining <= 0) {
        text.textContent = 'Prayer time elapsed';
        chip.classList.add('expired');
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      text.textContent = `Prayer: ${mins}m ${secs.toString().padStart(2, '0')}s`;
      chip.classList.remove('expired');
    });
  }

  function clearSessionState() {
    chrome.storage.local.remove(SESSION_KEY);
  }

  // ── Save prayer to persistent storage ──────────────────

  function savePrayer(text, type) {
    const now = new Date();
    const prayer = {
      text,
      type, // 'prayer' or 'essay'
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString(),
      timestamp: Date.now()
    };

    chrome.storage.local.get({ prayerJournal: [] }, result => {
      const prayers = result.prayerJournal;
      // Assign a monotonically increasing ID based on the max existing ID,
      // so the background can track which entries have been exported
      // (append-only) even if exports are delayed or fail.
      const maxId = prayers.reduce((m, p) => Math.max(m, p.id || 0), 0);
      prayer.id = maxId + 1;
      prayers.unshift(prayer);
      chrome.storage.local.set({ prayerJournal: prayers }, () => {
        // Export to local file after every entry
        chrome.runtime.sendMessage({ action: 'exportJournal' });
      });
    });
  }

  // ── Should we block? ──────────────────────────────────
  // Block trigger uses PLAYBACK time: prayer_played_ms + in-progress run
  // vs prayer_timeout_ms. Wall-clock time is tracked separately for the
  // visible countdown but does NOT auto-block on its own (so a paused
  // video won't re-block by itself — the user must be actively engaged
  // with playback for the budget to burn).

  async function shouldBlock() {
    if (!isBlockablePage()) return false;

    const state = await getSessionState();
    if (!state.prayer_completed) return true;

    // Compute current played ms (add the in-progress run if currently playing)
    let playedMs = state.prayer_played_ms || 0;
    if (state.prayer_playing_since) {
      const delta = Date.now() - state.prayer_playing_since;
      // Cap defensively against tab-suspend jumps
      playedMs += Math.min(Math.max(delta, 0), 5 * 60 * 1000);
    }
    const timeout = state.prayer_timeout_ms || PRAYER_TIMEOUT_MS;

    // Timed out (by playback minutes)
    if (playedMs >= timeout) {
      clearSessionState();
      return true;
    }

    return false;
  }

  // ── Schedule next re-check ─────────────────────────────
  // The re-check is keyed off WALL-CLOCK time (prayer_timestamp), since
  // that's the user-visible countdown. The block decision inside
  // shouldBlock() still uses playback time, so a paused video can sit
  // there without auto-blocking on the wall clock alone.

  let recheckTimer = null;

  function scheduleRecheck() {
    if (recheckTimer) clearTimeout(recheckTimer);
    getSessionState().then(state => {
      if (!state.prayer_completed) return;
      const timeout = state.prayer_timeout_ms || PRAYER_TIMEOUT_MS;
      const startedAt = state.prayer_timestamp || Date.now();
      const remaining = timeout - (Date.now() - startedAt);
      if (remaining > 0) {
        recheckTimer = setTimeout(async () => {
          if (await shouldBlock()) showBlockingOverlay();
        }, remaining + 200); // small buffer
      }
    });
  }

  // ── Blocking overlay ───────────────────────────────────

  function showBlockingOverlay() {
    if (document.getElementById('prayer-overlay')) return;
    // A blocking overlay implies the countdown is no longer running —
    // remove the chip so it can't sit on top of the overlay.
    stopCountdownChip();

    const overlay = document.createElement('div');
    overlay.id = 'prayer-overlay';
    overlay.innerHTML = `
      <div class="prayer-container">
        <div class="prayer-content">
          <h2>Pause & Pray</h2>
          <p>Before engaging with this content, please take a moment for reflection.</p>
          <label for="prayer-input">Prayer before engaging:</label>
          <textarea id="prayer-input" placeholder="Enter your prayer or reflection here..." rows="4"></textarea>
          <div id="prayer-word-count" style="display:none; text-align:right; font-size:12px; color:#7070a0; margin-top:-16px; margin-bottom:12px;"></div>
          <div class="prayer-btn-row">
            <button id="continue-btn" class="prayer-primary-btn">Continue <span class="btn-subtitle">(${Math.round(PRAYER_TIMEOUT_MS / 60000)} min)</span><span class="btn-subtitle">(Cmd+Enter)</span></button>
            <button id="essay-btn" class="prayer-essay-btn">Essay <span class="btn-subtitle">(${Math.round(ESSAY_TIMEOUT_MS / 60000)} min, ${ESSAY_MIN_WORDS}+ words)</span><span class="btn-subtitle">(Cmd+&#x21E7;+Enter)</span></button>
          </div>
          <button id="prayer-journal-btn">📖 Prayer Journal</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    // Pause the main video player while overlay is up
    const mainVideo = document.querySelector('#movie_player video');
    if (mainVideo) mainVideo.pause();

    // Start guard to prevent overlay removal
    startOverlayGuard();

    const input = document.getElementById('prayer-input');
    const continueBtn = document.getElementById('continue-btn');
    const essayBtn = document.getElementById('essay-btn');
    const journalBtn = document.getElementById('prayer-journal-btn');
    const wcDisplay = document.getElementById('prayer-word-count');

    function updateWordCount() {
      const wc = wordCount(input.value);
      wcDisplay.style.display = wc > 0 ? 'block' : 'none';
      wcDisplay.textContent = `${wc} / ${ESSAY_MIN_WORDS} words`;
      wcDisplay.style.color = wc >= ESSAY_MIN_WORDS ? '#4caf50' : '#7070a0';
    }

    input.addEventListener('input', updateWordCount);

    function submitPrayer() {
      const text = input.value.trim();
      if (!text) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
        input.focus();
        return;
      }
      savePrayer(text, 'prayer');
      setSessionState(PRAYER_TIMEOUT_MS);
      document.documentElement.style.overflow = '';
      overlay.remove();
      stopOverlayGuard();
      startCountdownChip();
      scheduleRecheck();
      attachPlaybackListeners();
    }

    function submitEssay() {
      const text = input.value.trim();
      if (!text) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
        input.focus();
        return;
      }
      if (wordCount(text) < ESSAY_MIN_WORDS) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
        wcDisplay.style.display = 'block';
        wcDisplay.style.color = '#ff6b6b';
        input.focus();
        return;
      }
      savePrayer(text, 'essay');
      setSessionState(ESSAY_TIMEOUT_MS);
      document.documentElement.style.overflow = '';
      overlay.remove();
      stopOverlayGuard();
      startCountdownChip();
      scheduleRecheck();
      attachPlaybackListeners();
    }

    continueBtn.addEventListener('click', submitPrayer);
    essayBtn.addEventListener('click', submitEssay);

    journalBtn.addEventListener('click', () => showPrayerJournal());

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.metaKey && e.shiftKey) { submitEssay(); return; }
      if (e.key === 'Enter' && e.metaKey) submitPrayer();
    });

    setTimeout(() => input.focus(), 100);
  }

  // ── Prayer journal modal ───────────────────────────────

  function showPrayerJournal() {
    const modal = document.createElement('div');
    modal.className = 'prayer-journal-modal';

    const content = document.createElement('div');
    content.className = 'prayer-journal-content';
    content.innerHTML = `
      <button id="close-journal" class="journal-close-btn">✕</button>
      <h3 class="journal-title">Prayer Journal</h3>
      <button id="export-journal" class="journal-export-btn">📥 Export Journal</button>
      <div id="journal-entries" class="journal-entries">Loading...</div>
    `;
    modal.appendChild(content);
    document.body.appendChild(modal);

    chrome.storage.local.get({ prayerJournal: [] }, result => {
      const prayers = result.prayerJournal;
      const div = document.getElementById('journal-entries');
      if (!prayers.length) {
        div.innerHTML = '<div class="journal-empty">No prayers yet. Start your journal today!</div>';
      } else {
        div.innerHTML = prayers.map(p => `
          <div class="journal-entry">
            <div class="journal-entry-meta">${escapeHtml(p.date)} at ${escapeHtml(p.time)}${p.type === 'essay' ? ' <span class="journal-badge">Essay</span>' : ''}</div>
            <div class="journal-entry-text">${escapeHtml(p.text)}</div>
          </div>
        `).join('');
      }
    });

    document.getElementById('close-journal').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    document.getElementById('export-journal').addEventListener('click', () => {
      chrome.storage.local.get({ prayerJournal: [] }, result => {
        const prayers = result.prayerJournal;
        if (!prayers.length) { alert('No prayers to export yet!'); return; }

        let txt = 'Prayer Journal Export\n' + '='.repeat(50) + '\n\n';
        prayers.forEach(p => {
          txt += `${p.date} at ${p.time}${p.type === 'essay' ? ' [Essay]' : ''}\n`;
          txt += '-'.repeat(50) + '\n';
          txt += p.text + '\n\n';
        });

        const blob = new Blob([txt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'prayer-journal.txt';
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  // ── URL change detection (YouTube is an SPA) ──────────

  let lastUrl = location.href;

  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;

    // Always tear down the previous page's state immediately so a music
    // video's hidden picture never leaks into a non-music video.
    stopMusicDisabler();

    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);

    // Not a watch page — remove overlay if present, disable previews
    if (path !== '/watch' || !params.get('v')) {
      removeOverlay();
      disableAutoplayPreviews();
      detachPlaybackListeners();
      stopCountdownChip();
      return;
    }

    // Wait for detector.js to update category, then decide
    setTimeout(async () => {
      await waitForCategory();

      // Music disabler runs IN PARALLEL with the prayer overlay: if the
      // user is on a music video and has the disabler ON, the picture
      // is hidden (audio keeps playing) whether or not the prayer
      // overlay is also being shown. Otherwise it is explicitly stopped
      // so the next video's picture is fully visible.
      if (DISABLE_MUSIC_PLAYBACK && isMusicVideo()) {
        ensureMusicDisabler();
      } else {
        stopMusicDisabler();
      }

      if (await shouldBlock()) {
        showBlockingOverlay();
      } else {
        removeOverlay();
        attachPlaybackListeners();
        // If a prayer session is still active (timer budget remaining),
        // show the countdown chip so the user can see the timer ticking.
        getSessionState().then(state => {
          if (state.prayer_completed) startCountdownChip();
        });
      }
    }, 400); // small delay so detector.js can update
  }

  function removeOverlay() {
    const existing = document.getElementById('prayer-overlay');
    if (existing) { existing.remove(); document.documentElement.style.overflow = ''; }
  }

  // ── Music-video playback disabler ──────────────────────
  // When DISABLE_MUSIC_PLAYBACK is on and the current page is a music
  // video, we hide only the VIDEO (picture) while leaving the AUDIO
  // playing — per the user's request. The <video> element itself is
  // never paused, muted, or volume-changed; we only inject CSS that
  // visually hides the player. A small notice confirms the state.

  let musicDisablerActive = false;
  let musicDisablerObserver = null;
  let musicDisablerInterval = null;

  function ensureMusicDisabler() {
    if (!DISABLE_MUSIC_PLAYBACK) { stopMusicDisabler(); return; }
    if (!isBlockablePage() && !isOnWatch()) return;
    if (!isMusicVideo()) { stopMusicDisabler(); return; }
    if (musicDisablerActive) return;
    musicDisablerActive = true;

    // Show a small notice (separate from the prayer overlay)
    showMusicBlockedNotice();

    // Hide only the visual player; audio keeps playing
    applyDisableVisuals();

    // Re-apply visuals on every DOM rebuild so YouTube's SPA nav can't
    // bring the video back without us noticing
    if (!musicDisablerObserver && document.body) {
      musicDisablerObserver = new MutationObserver(applyDisableVisuals);
      musicDisablerObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Defensive periodic re-apply
    if (!musicDisablerInterval) {
      musicDisablerInterval = setInterval(() => {
        if (!isMusicVideo() || !DISABLE_MUSIC_PLAYBACK) {
          stopMusicDisabler();
          return;
        }
        applyDisableVisuals();
      }, 1500);
    }
  }

  function isOnWatch() {
    return window.location.pathname === '/watch' && !!new URLSearchParams(window.location.search).get('v');
  }

  function applyDisableVisuals() {
    if (!musicDisablerActive) return;
    // Inject the hide style if missing. We hide ONLY the picture — the
    // <video> element is collapsed, but its audio track keeps decoding.
    // The title, channel, description, and player controls remain
    // visible (the .html5-video-player container holds the controls;
    // we keep it rendered so playback controls stay accessible).
    let dim = document.getElementById('prayer-music-dim');
    if (!dim) {
      dim = document.createElement('style');
      dim.id = 'prayer-music-dim';
      dim.textContent = [
        // Collapse the video frame so the picture is gone, but leave
        // the controls/chrome (so the user can still pause etc.).
        '#movie_player video,',
        'ytd-watch-flexy #player-container-outer video,',
        'ytd-watch-flexy #player-container-inner video,',
        'ytd-miniplayer-player video {',
        '  visibility: hidden !important;',
        '  width: 1px !important; height: 1px !important;',
        '  position: absolute !important; left: -9999px !important;',
        '}'
      ].join('\n');
      document.documentElement.appendChild(dim);
    }
  }

  function showMusicBlockedNotice() {
    if (document.getElementById('prayer-music-notice')) return;
    const el = document.createElement('div');
    el.id = 'prayer-music-notice';
    el.textContent = '🎵 Video Hidden (Audio Only)';
    // Anchor inside the movie_player so it stays locked to the player
    // box even when the page scrolls. The element is absolutely
    // positioned within the player; it ignores pointer events so it
    // never blocks interaction with the controls underneath.
    el.style.cssText = [
      'position:absolute',
      'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'z-index:50',
      'background:linear-gradient(135deg,#4d66d9,#5c3582)',
      'color:white',
      'padding:14px 20px',
      'border-radius:12px',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'font-size:15px', 'font-weight:600',
      'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
      'pointer-events:none',
      'white-space:nowrap'
    ].join(';');

    // Inject into the player so it scrolls WITH the video frame.
    // If the player isn't in the DOM yet, fall back to documentElement.
    const host = document.querySelector('#movie_player')
              || document.getElementById('player')
              || document.documentElement;
    // Make sure the host can host an absolutely-positioned child
    const cs = window.getComputedStyle(host);
    if (cs.position === 'static') {
      host.style.position = 'relative';
    }
    host.appendChild(el);
  }

  function stopMusicDisabler() {
    if (!musicDisablerActive) return;
    musicDisablerActive = false;
    if (musicDisablerObserver) { musicDisablerObserver.disconnect(); musicDisablerObserver = null; }
    if (musicDisablerInterval) { clearInterval(musicDisablerInterval); musicDisablerInterval = null; }
    const dim = document.getElementById('prayer-music-dim');
    if (dim) dim.remove();
    const notice = document.getElementById('prayer-music-notice');
    if (notice) notice.remove();
  }

  // Watch the data-yt-music attribute so SPA navigations that flip the
  // music flag re-evaluate the disabler without a full page reload.
  function watchMusicFlag() {
    const target = document.documentElement;
    const obs = new MutationObserver(() => {
      if (DISABLE_MUSIC_PLAYBACK) {
        // Either direction: ensure correct state
        if (isMusicVideo()) ensureMusicDisabler();
        else stopMusicDisabler();
      }
    });
    obs.observe(target, { attributes: true, attributeFilter: ['data-yt-music', 'data-yt-category'] });
  }

  new MutationObserver(onUrlChange).observe(document, { subtree: true, childList: true });

  // ── Visibility / focus re-checks ──────────────────────

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && await shouldBlock()) {
      showBlockingOverlay();
    }
  });

  window.addEventListener('focus', async () => {
    if (await shouldBlock() && !document.getElementById('prayer-overlay')) {
      showBlockingOverlay();
    }
  });

  // ── React to settings changes (so the switches take effect live) ──

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    if (changes.blockMusicVideos) {
      BLOCK_MUSIC_VIDEOS = changes.blockMusicVideos.newValue === true;
    }
    if (changes.disableMusicPlayback) {
      DISABLE_MUSIC_PLAYBACK = changes.disableMusicPlayback.newValue !== false;
      if (DISABLE_MUSIC_PLAYBACK) ensureMusicDisabler();
      else stopMusicDisabler();
    }
  });

  // ── Initial load ──────────────────────────────────────

  async function init() {
    // Load settings first
    await loadSettings();

    // Watch the music-flag attribute so SPA navigations trigger the
    // playback-disabler when needed.
    watchMusicFlag();

    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);

    // Quick exit for non-watch pages
    if (path !== '/watch' || !params.get('v')) {
      disableAutoplayPreviews();
      return;
    }

    // Inject a <style> to hide the page immediately (survives DOM rebuilds)
    const hideStyle = document.createElement('style');
    hideStyle.id = 'prayer-hide-style';
    hideStyle.textContent = 'html.prayer-pending { visibility: hidden !important; }';
    document.documentElement.appendChild(hideStyle);
    document.documentElement.classList.add('prayer-pending');

    // Wait for detector.js to provide the category
    await waitForCategory();

    // Activate the music-video playback disabler (if enabled) for any
    // music video, regardless of whether the prayer overlay will also
    // appear. The disabler only hides the picture; audio keeps playing.
    if (DISABLE_MUSIC_PLAYBACK && isMusicVideo()) {
      ensureMusicDisabler();
    } else {
      stopMusicDisabler();
    }

    // Decide prayer-block path. Music videos are skipped from the
    // overlay only when BLOCK_MUSIC_VIDEOS is on; with the default
    // setting (ON), the prayer overlay never appears for music videos.
    if (await shouldBlock()) {
      const show = () => {
        showBlockingOverlay();
        revealPage();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', show);
      } else {
        show();
      }
    } else {
      revealPage();
      scheduleRecheck();
      attachPlaybackListeners();
      // Active prayer session without an overlay → show the countdown chip
      const state = await getSessionState();
      if (state.prayer_completed) startCountdownChip();
    }
  }

  function revealPage() {
    document.documentElement.classList.remove('prayer-pending');
    const s = document.getElementById('prayer-hide-style');
    if (s) s.remove();
    document.documentElement.style.visibility = '';
  }

  // ── Persistent guard: re-show overlay if removed unexpectedly ──

  let guardInterval = null;

  function startOverlayGuard() {
    if (guardInterval) return;
    guardInterval = setInterval(async () => {
      // Only guard on blockable pages
      if (!isBlockablePage()) {
        stopOverlayGuard();
        return;
      }
      // If overlay is gone but we should still be blocking, re-show it
      if (!document.getElementById('prayer-overlay') && await shouldBlock()) {
        showBlockingOverlay();
      }
    }, 1000);
  }

  function stopOverlayGuard() {
    if (guardInterval) { clearInterval(guardInterval); guardInterval = null; }
  }

  // ── Anti-cheat: disable autoplay video previews on non-watch pages ──

  function disableAutoplayPreviews() {
    // Continuously pause any preview/inline videos on search, home, feeds
    const pauseAll = () => {
      document.querySelectorAll('video').forEach(v => {
        // Don't touch the main player on /watch pages
        if (window.location.pathname === '/watch' && v.closest('#movie_player')) return;
        if (!v.paused) {
          v.pause();
          v.removeAttribute('autoplay');
        }
      });
    };

    // Run immediately and observe for new video elements
    pauseAll();
    const obs = new MutationObserver(pauseAll);
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        obs.observe(document.body, { childList: true, subtree: true });
      });
    }

    // Also intercept play events
    document.addEventListener('play', e => {
      if (window.location.pathname !== '/watch' && e.target.tagName === 'VIDEO') {
        e.target.pause();
      }
    }, true);
  }

  init();
})();
