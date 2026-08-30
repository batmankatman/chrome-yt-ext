// detector.js — runs in the MAIN world (page context)
// Reads the video category from YouTube's internal data and exposes it
// to the content script via a data attribute on <html>.

(function () {
  'use strict';

  function reportCategory() {
    try {
      const cat = window.ytInitialPlayerResponse?.videoDetails?.category || '';
      document.documentElement.setAttribute('data-yt-category', cat.toLowerCase());
    } catch { /* ignore */ }
  }

  // YouTube SPA navigation events
  document.addEventListener('yt-navigate-finish', () => setTimeout(reportCategory, 300));
  document.addEventListener('yt-page-data-updated', reportCategory);

  // Initial page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportCategory);
  } else {
    reportCategory();
  }
})();
