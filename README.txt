YouTube Prayer Blocker – Chrome Extension
==========================================

PURPOSE
-------
Encourage intentional media consumption by requiring a written prayer
or reflection before watching non-music YouTube videos.


POLICIES & RULES
----------------

1. ACTIVATION SCOPE
   - The overlay activates ONLY on YouTube /watch pages with a video ID.
   - It does NOT activate on: the homepage, subscriptions, playlists
     feed, search results, Shorts, channels, or any non-video page.

2. MUSIC EXEMPTION
   - Music videos are automatically detected and exempted.
   - Detection method: a companion script (detector.js) runs in
     YouTube's own page context and reads the video category from
     ytInitialPlayerResponse.videoDetails.category. If the category
     is "Music", the video is exempt. As a fallback, the extension
     also checks the <meta itemprop="genre"> tag on the page.
   - This means music videos are ALWAYS exempt, whether standalone
     or inside a playlist. Other videos inside playlists are NOT
     exempt — only the music category matters.

3. PRAYER ENTRY (default mode)
   - Requires any non-empty text.
   - Grants 5 minutes of access to the current video.
   - After 5 minutes, the overlay re-appears.

4. ESSAY ENTRY (toggle mode)
   - Activated by clicking the "Essay" button before submitting.
   - Requires at least 50 words.
   - Grants 20 minutes of access to the current video.

5. TIMER RESET ON NEW VIDEO
   - Navigating to a different (non-music) video resets the timer
     and requires a new prayer, regardless of how much time remains.

6. ANTI-CHEAT MEASURES
   - Autoplay video previews on search, home, and feed pages are
     automatically paused. The extension intercepts play events and
     uses a MutationObserver to catch new preview elements.
   - A persistent guard checks every second that the overlay has not
     been removed. If YouTube's SPA navigation or DOM rebuild removes
     the overlay while the user should still be blocked, it is
     re-shown immediately.
   - The page is hidden via a CSS class (prayer-pending) injected at
     document_start, which survives YouTube's DOM rebuilds during
     hard refreshes.
   - The main video player is paused the moment the overlay appears.
   - The overlay blocks page scroll and covers the entire viewport
     at z-index 999999999.

7. KEYBOARD SHORTCUT
   - Cmd+Enter (⌘↵) submits the prayer/essay.

8. JOURNAL & EXPORT
   - Every prayer and essay is saved to chrome.storage.local with
     date, time, type, and full text.
   - After every submission, the full journal is automatically
     exported (overwritten) to:
       ~/Downloads/Consider_before_consuming/prayer-journal.txt
   - A manual export button is available in the Prayer Journal modal
     and in the extension popup.

9. POPUP DASHBOARD
   - Shows total prayer count and essay count.
   - Provides Export and Clear buttons.


FILE STRUCTURE
--------------
manifest.json       – Chrome MV3 extension manifest
content.js          – Main content script (overlay, journal, guards)
detector.js         – Runs in MAIN world; reads video category
styles.css          – Overlay and journal styling
background.js       – Service worker; handles file export via downloads API
popup.html          – Extension popup UI
popup.js            – Popup logic (stats, export, clear)
_locales/en/        – Localization messages
