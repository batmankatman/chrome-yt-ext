// Clear
clearBtn.addEventListener('click', () => {
  if (confirm('Delete all prayer journal entries? This cannot be undone.')) {
    chrome.storage.local.set({ prayerJournal: [] }, () => {
      totalEl.textContent = '0';
      essayEl.textContent = '0';
      statusEl.textContent = 'Journal cleared';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    });
  }
});

// Settings modal
settingsBtn.addEventListener('click', () => {
  // Load current settings into the modal
  chrome.storage.local.get({
    defaultPrayerTime: 5,
    extendedPrayerTime: 20,
    whitelistedSites: [
      'PLHcBUkwitvcO52am3hK9AQPr1CKk9adSP',
      'PLHcBUkwitvcMxESxOvZSQY_OZ1qWw9X1U',
      'PLHcBUkwitvcNfuhdyZIO8uldRlQYOndTS'
    ],
    exportSubfolder: 'Prayers',
    customExportPath: ''
  }, (settings) => {
    document.getElementById('default-prayer-time').value = settings.defaultPrayerTime;
    document.getElementById('extended-prayer-time').value = settings.extendedPrayerTime;
    
    // Convert playlist IDs to full YouTube URLs for display
    const whitelistedUrls = settings.whitelistedSites.map(id => {
      if (id.startsWith('PL')) {
        return `https://www.youtube.com/playlist?list=${id}`;
      }
      return id; // Already a URL or other ID
    });
    document.getElementById('whitelisted-sites').value = whitelistedUrls.join('\n');
    document.getElementById('export-subfolder').value = settings.exportSubfolder;
    
    // Load custom export path if set
    const customPathInput = document.getElementById('custom-export-path');
    const customPathHint = document.getElementById('custom-path-hint');
    if (settings.customExportPath) {
      customPathInput.value = settings.customExportPath;
      customPathHint.textContent = `Selected: ${settings.customExportPath}. Prayers.txt will be saved directly in this folder.`;
      customPathHint.style.color = '#4caf50';
    } else {
      customPathInput.value = 'No custom folder selected (uses Downloads/Prayers)';
      customPathHint.textContent = 'Select a folder to save Prayers.txt directly there instead of Downloads';
      customPathHint.style.color = '#8080a0';
    }
  });
  settingsModal.style.display = 'block';
});

// Clear journal from settings
document.getElementById('clear-journal-settings').addEventListener('click', () => {
  if (confirm('Delete all prayer journal entries? This cannot be undone.')) {
    chrome.storage.local.set({ prayerJournal: [] }, () => {
      totalEl.textContent = '0';
      essayEl.textContent = '0';
      statusEl.textContent = 'Journal cleared from settings';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
      // Close settings modal after clearing
      settingsModal.style.display = 'none';
    });
  }
});

// About modal
aboutBtn.addEventListener('click', () => {
  aboutModal.style.display = 'block';
});

// Close modals
closeButtons.forEach(button => {
  button.addEventListener('click', () => {
    const modal = button.closest('.modal');
    modal.style.display = 'none';
  });
});

// Close when clicking outside modal content
window.addEventListener('click', (event) => {
  if (event.target === settingsModal) {
    settingsModal.style.display = 'none';
  }
  if (event.target === aboutModal) {
    aboutModal.style.display = 'none';
  }
});

// Save settings
saveSettingsBtn.addEventListener('click', () => {
  const defaultPrayerTime = parseInt(document.getElementById('default-prayer-time').value) || 5;
  const extendedPrayerTime = parseInt(document.getElementById('extended-prayer-time').value) || 20;
  const whitelistedSitesText = document.getElementById('whitelisted-sites').value;
  // Convert full YouTube URLs back to just the ID part for storage
  const whitelistedSites = whitelistedSitesText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(url => {
      // Extract ID from YouTube URL
      if (url.includes('youtube.com/playlist?list=')) {
        return url.split('list=')[1].split('&')[0];
      }
      if (url.includes('youtube.com/watch?v=')) {
        return url.split('v=')[1].split('&')[0];
      }
      return url; // Not a YouTube URL, keep as is
    });
  const exportSubfolder = document.getElementById('export-subfolder').value.trim();
  const customExportPath = document.getElementById('custom-export-path').value;

  const settingsToSave = {
    defaultPrayerTime,
    extendedPrayerTime,
    whitelistedSites,
    exportSubfolder
  };

  // Only save custom export path if one was selected
  if (customExportPath && customExportPath !== 'No custom folder selected (uses Downloads/Prayers)') {
    settingsToSave.customExportPath = customExportPath;
  }

  chrome.storage.local.set(settingsToSave, () => {
    statusEl.textContent = 'Settings saved!';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
    // Close the modal after saving
    settingsModal.style.display = 'none';
  });
});

// Select folder button
document.getElementById('select-folder-btn').addEventListener('click', async () => {
  try {
    // Use File System Access API to let user pick a folder
    const directoryHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'downloads'
    });
    
    // Store the folder handle in IndexedDB or as a serialized string
    // For Chrome extensions, we need to store the handle reference
    // We'll store the name and a reference
    const folderName = directoryHandle.name;
    const displayPath = folderName;
    
    document.getElementById('custom-export-path').value = displayPath;
    document.getElementById('custom-path-hint').textContent = `Selected: ${displayPath}. Prayers.txt will be saved directly in this folder.`;
    document.getElementById('custom-path-hint').style.color = '#4caf50';
    
    // Store the directory handle for later use
    // Note: Directory handles can't be serialized to storage directly
    // We'll store it in a way that background.js can access
    try {
      await chrome.storage.local.set({ 
        customExportDirectoryHandle: directoryHandle 
      });
    } catch (e) {
      console.log('Could not store handle directly, storing reference');
    }
    
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Folder selection failed:', err);
      document.getElementById('custom-path-hint').textContent = 'Failed to select folder. Please try again.';
      document.getElementById('custom-path-hint').style.color = '#ff6b6b';
    }
  }
});