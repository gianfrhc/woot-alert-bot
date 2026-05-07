// ===== WOOT ALERT BOT — LIVE API =====

const state = {
  deals: [],
  alerts: [],
  seenOfferIds: new Set(),
  settings: {
    minDiscount: 30,
    minPrice: 0,
    maxPrice: 300,
    refreshInterval: 300,
    categories: ['All'],
    keywordButtons: [],
    blockedWords: [],
    ntfyAllowOpenBox: false,
    ntfyAllowRefurbished: false,
    soundEnabled: false,
    notificationsEnabled: true,
    ntfyEnabled: false,
    ntfyTopic: '',
    ntfyMinDiscount: 40,
    quietStart: '',
    quietEnd: '',
    discordEnabled: false,
    discordWebhook: '',
    apiKey: ''
  },
  activeKeywords: new Set(),
  timer: null,
  countdown: 0,
  isScanning: false,
  alertCount: 0,
  scanHistory: [],
  totalDealsAllTime: 0,
  hasRenderedOnce: false,
  lastScanTime: 0,
  searchTimeout: null,
  saveTimeout: null,
  _bellTimeout: null,
  favorites: new Set(),
  scannerActive: false,
  serverInterval: 120
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
  requestNotificationPermission();
  scanDeals();
  startAutoRefresh();
});

async function loadSettings() {
  // Try server first (shared across devices), fall back to localStorage
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const serverSettings = await res.json();
      if (serverSettings && Object.keys(serverSettings).length > 0) {
        // HIGH-04: Server masks apiKey — preserve local copy if server sends masked version
        const localApiKey = state.settings.apiKey;
        Object.assign(state.settings, serverSettings);
        if (serverSettings.apiKey && serverSettings.apiKey.includes('•')) {
          state.settings.apiKey = localApiKey || ''; // Keep unmasked local copy
        }
        // Restore activeKeywords from saved array
        if (serverSettings.activeKeywords && Array.isArray(serverSettings.activeKeywords)) {
          state.activeKeywords = new Set(serverSettings.activeKeywords);
        }
        console.log('[Settings] Loaded from server ✓');
      }
    }
  } catch (e) {
    console.warn('[Settings] Server unavailable, using localStorage');
    const saved = localStorage.getItem('woot-alert-settings');
    if (saved) {
      try { Object.assign(state.settings, JSON.parse(saved)); } catch(e) {}
    }
  }
  // DATA-02: Load seenOfferIds from server first, then merge localStorage
  try {
    const seenRes = await fetch('/api/seen-ids');
    if (seenRes.ok) {
      const serverIds = await seenRes.json();
      if (Array.isArray(serverIds)) {
        serverIds.forEach(id => state.seenOfferIds.add(id));
        console.log(`[SeenIds] Loaded ${serverIds.length} from server`);
      }
    }
  } catch (e) {
    console.warn('[SeenIds] Server unavailable, using localStorage only');
  }
  const seen = localStorage.getItem('woot-seen-ids');
  if (seen) {
    try { JSON.parse(seen).forEach(id => state.seenOfferIds.add(id)); } catch(e) {}
  }
  applySettingsToUI();
  // Load favorites
  const favs = localStorage.getItem('woot-favorites');
  if (favs) { try { JSON.parse(favs).forEach(id => state.favorites.add(id)); } catch(e) {} }
}

function saveSettings() {
  const payload = {
    ...state.settings,
    activeKeywords: [...state.activeKeywords]
  };
  localStorage.setItem('woot-alert-settings', JSON.stringify(payload));
  // Debounce server saves to avoid race conditions (F-28)
  clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(() => {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(res => {
      if (!res.ok) showToast('Sync failed — saved locally only', 'error');
    }).catch(e => {
      console.warn('[Settings] Server save failed:', e);
      showToast('Server unreachable — saved locally', 'info');
    });
  }, 500);
}

function saveSeenIds() {
  const arr = [...state.seenOfferIds].slice(-2000);
  localStorage.setItem('woot-seen-ids', JSON.stringify(arr));
  // CRIT-02: Don't POST to server — scanner server-side is the source of truth
  // Frontend only persists locally for its own UI dedup
}

function applySettingsToUI() {
  const s = state.settings;
  document.getElementById('min-discount').value = s.minDiscount;
  document.getElementById('min-discount-value').textContent = s.minDiscount + '%';
  document.getElementById('max-price').value = s.maxPrice;
  document.getElementById('max-price-value').textContent = '$' + s.maxPrice;
  document.getElementById('min-price').value = s.minPrice;
  document.getElementById('min-price-value').textContent = '$' + s.minPrice;
  document.getElementById('refresh-interval').value = s.refreshInterval;
  document.getElementById('api-key').value = s.apiKey;
  document.getElementById('toggle-sound').classList.toggle('active', s.soundEnabled);
  document.getElementById('toggle-notifications').classList.toggle('active', s.notificationsEnabled);
  document.getElementById('toggle-ntfy').classList.toggle('active', s.ntfyEnabled);
  document.getElementById('toggle-ntfy').setAttribute('aria-checked', s.ntfyEnabled);
  document.getElementById('ntfy-topic').value = s.ntfyTopic || '';
  document.getElementById('ntfy-min-discount').value = s.ntfyMinDiscount;
  document.getElementById('ntfy-min-discount-value').textContent = s.ntfyMinDiscount + '%';
  document.getElementById('quiet-start').value = s.quietStart || '';
  document.getElementById('quiet-end').value = s.quietEnd || '';
  // Show/hide ntfy sub-settings based on toggle
  const ntfyVisible = s.ntfyEnabled ? '' : 'none';
  document.getElementById('ntfy-settings-group').style.display = ntfyVisible;
  document.getElementById('ntfy-discount-group').style.display = ntfyVisible;
  document.getElementById('ntfy-condition-group').style.display = ntfyVisible;
  document.getElementById('ntfy-quiet-group').style.display = ntfyVisible;
  document.getElementById('ntfy-blocked-group').style.display = ntfyVisible;
  // Condition toggles
  document.getElementById('toggle-allow-openbox').classList.toggle('active', !!s.ntfyAllowOpenBox);
  document.getElementById('toggle-allow-openbox').setAttribute('aria-checked', !!s.ntfyAllowOpenBox);
  document.getElementById('toggle-allow-refurbished').classList.toggle('active', !!s.ntfyAllowRefurbished);
  document.getElementById('toggle-allow-refurbished').setAttribute('aria-checked', !!s.ntfyAllowRefurbished);
  // Discord
  document.getElementById('toggle-discord').classList.toggle('active', s.discordEnabled);
  document.getElementById('toggle-discord').setAttribute('aria-checked', s.discordEnabled);
  document.getElementById('discord-webhook').value = s.discordWebhook || '';
  document.getElementById('discord-settings-group').style.display = s.discordEnabled ? '' : 'none';
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', s.categories.includes(c.dataset.category));
  });
  renderKeywordTagsSettings();
  renderKeywordButtonsMain();
  renderBlockedWordsSettings();
}

// ===== EVENTS =====
function bindEvents() {
  document.getElementById('btn-refresh').addEventListener('click', () => scanDeals());
  document.getElementById('btn-settings').addEventListener('click', () => toggleSettings(true));
  document.getElementById('btn-close-settings').addEventListener('click', () => toggleSettings(false));
  document.getElementById('settings-overlay').addEventListener('click', () => toggleSettings(false));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromUI);
  document.getElementById('btn-reset-settings').addEventListener('click', resetSettings);
  document.getElementById('btn-clear-alerts').addEventListener('click', clearAlerts);
  document.getElementById('btn-export-csv').addEventListener('click', exportDealsCSV);

  // F-06: Escape closes settings
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('settings-panel').classList.contains('open')) {
      toggleSettings(false);
    }
  });

  document.getElementById('min-discount').addEventListener('input', e => {
    document.getElementById('min-discount-value').textContent = e.target.value + '%';
  });
  document.getElementById('max-price').addEventListener('input', e => {
    document.getElementById('max-price-value').textContent = '$' + e.target.value;
  });
  document.getElementById('min-price').addEventListener('input', e => {
    document.getElementById('min-price-value').textContent = '$' + e.target.value;
  });
  document.getElementById('ntfy-min-discount').addEventListener('input', e => {
    document.getElementById('ntfy-min-discount-value').textContent = e.target.value + '%';
  });

  ['toggle-sound','toggle-notifications','toggle-ntfy','toggle-discord','toggle-allow-openbox','toggle-allow-refurbished'].forEach(id => {
    const el = document.getElementById(id);
    const toggle = () => {
      el.classList.toggle('active');
      el.setAttribute('aria-checked', el.classList.contains('active'));
      // Show/hide ntfy sub-settings when ntfy toggle changes
      if (id === 'toggle-ntfy') {
        const vis = el.classList.contains('active') ? '' : 'none';
        document.getElementById('ntfy-settings-group').style.display = vis;
        document.getElementById('ntfy-discount-group').style.display = vis;
        document.getElementById('ntfy-condition-group').style.display = vis;
        document.getElementById('ntfy-quiet-group').style.display = vis;
        document.getElementById('ntfy-blocked-group').style.display = vis;
      }
      if (id === 'toggle-discord') {
        document.getElementById('discord-settings-group').style.display = el.classList.contains('active') ? '' : 'none';
      }
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }});
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', function() {
      if (this.dataset.category === 'All') {
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        this.classList.add('active');
      } else {
        document.querySelector('.chip[data-category="All"]').classList.remove('active');
        this.classList.toggle('active');
        if (!document.querySelector('.chip.active')) {
          document.querySelector('.chip[data-category="All"]').classList.add('active');
        }
      }
    });
  });

  // Debounced search
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(renderDeals, 200);
  });
  document.getElementById('sort-select').addEventListener('change', () => renderDeals());
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      this.classList.add('active');
      renderDeals();
    });
  });

  // Keyword button system
  document.getElementById('btn-add-keyword').addEventListener('click', () => addKeywordFromInput());
  document.getElementById('keyword-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addKeywordFromInput(); }
  });

  // Blocked words system
  document.getElementById('btn-add-blocked').addEventListener('click', () => addBlockedWordFromInput());
  document.getElementById('blocked-word-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addBlockedWordFromInput(); }
  });

  // Clickable stat cards
  bindStatCards();

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById('tab-' + tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // Discord test button
  document.getElementById('btn-test-discord').addEventListener('click', async () => {
    const url = document.getElementById('discord-webhook').value.trim();
    if (!url || !(url.startsWith('https://discord.com/api/webhooks/') || url.startsWith('https://discordapp.com/api/webhooks/'))) {
      showToast('Enter a valid Discord webhook URL first', 'error');
      return;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '✅ **Woot Alert Bot** — Test notification! Connection working.', username: 'Woot Bot', avatar_url: 'https://d3gqasl9vmjfd8.cloudfront.net/assets/woot_logo.png' })
      });
      if (res.ok || res.status === 204) showToast('Discord test sent! Check your channel', 'success');
      else showToast('Discord error: HTTP ' + res.status, 'error');
    } catch (e) {
      showToast('Discord send failed: ' + e.message, 'error');
    }
  });
}

function bindStatCards() {
  const cards = document.querySelectorAll('.stat-card');
  const labels = ['All active deals','Filter hot deals ≥50%','Jump to alerts','Scan now'];
  const actions = [
    () => {}, 
    () => { document.querySelector('.filter-chip[data-filter="hot"]')?.click(); },
    () => { document.getElementById('alerts-section').scrollIntoView({behavior:'smooth'}); },
    () => { scanDeals(); }
  ];
  cards.forEach((card, i) => {
    if (actions[i]) card.addEventListener('click', actions[i]);
    card.title = labels[i];
    // F-18: Accessibility
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', labels[i]);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions[i](); }});
  });
}

function toggleSettings(open) {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('open', open);
  if (open) {
    // F-07: Focus trap
    setTimeout(() => document.getElementById('min-discount')?.focus(), 350);
    panel._focusTrap = e => {
      if (e.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('input, select, button, [tabindex="0"]')].filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    panel.addEventListener('keydown', panel._focusTrap);
  } else {
    if (panel._focusTrap) panel.removeEventListener('keydown', panel._focusTrap);
    document.getElementById('btn-settings').focus();
  }
}

function saveSettingsFromUI() {
  const s = state.settings;
  s.minDiscount = parseInt(document.getElementById('min-discount').value);
  s.minPrice = parseInt(document.getElementById('min-price').value);
  s.maxPrice = parseInt(document.getElementById('max-price').value);
  s.refreshInterval = parseInt(document.getElementById('refresh-interval').value);
  s.apiKey = document.getElementById('api-key').value.trim();
  s.soundEnabled = document.getElementById('toggle-sound').classList.contains('active');
  s.notificationsEnabled = document.getElementById('toggle-notifications').classList.contains('active');
  s.ntfyEnabled = document.getElementById('toggle-ntfy').classList.contains('active');
  s.ntfyTopic = document.getElementById('ntfy-topic').value.trim();
  s.ntfyMinDiscount = parseInt(document.getElementById('ntfy-min-discount').value);
  s.quietStart = document.getElementById('quiet-start').value;
  s.quietEnd = document.getElementById('quiet-end').value;
  s.ntfyAllowOpenBox = document.getElementById('toggle-allow-openbox').classList.contains('active');
  s.ntfyAllowRefurbished = document.getElementById('toggle-allow-refurbished').classList.contains('active');
  s.discordEnabled = document.getElementById('toggle-discord').classList.contains('active');
  s.discordWebhook = document.getElementById('discord-webhook').value.trim();
  // F-11: Validate ntfy topic
  if (s.ntfyEnabled) {
    if (!s.ntfyTopic) { showToast('Please enter a ntfy.sh topic name', 'error'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(s.ntfyTopic)) { showToast('ntfy topic: only letters, numbers, - and _ allowed', 'error'); return; }
  }
  s.categories = [...document.querySelectorAll('.chip.active')].map(c => c.dataset.category);
  if (!s.categories.length) s.categories = ['All'];
  saveSettings();
  toggleSettings(false);
  showToast('Settings saved!', 'success');
  renderKeywordButtonsMain();
  startAutoRefresh();
  scanDeals();
}

function resetSettings() {
  if (!confirm('Reset all settings? This will delete your keywords, ntfy topic, and API key.')) return;
  state.settings = { minDiscount:30, minPrice:0, maxPrice:300, refreshInterval:300, categories:['All'], keywordButtons:[], blockedWords:[], ntfyAllowOpenBox:false, ntfyAllowRefurbished:false, soundEnabled:false, notificationsEnabled:true, ntfyEnabled:false, ntfyTopic:'', ntfyMinDiscount:40, quietStart:'', quietEnd:'', discordEnabled:false, discordWebhook:'', apiKey:'' };
  state.activeKeywords.clear();
  saveSettings();
  applySettingsToUI();
  showToast('Settings reset to defaults', 'success');
  renderDeals();
}

// ===== KEYWORD BUTTONS =====
function addKeywordFromInput() {
  const input = document.getElementById('keyword-input');
  const text = input.value.trim();
  if (!text) return;
  // F-10: Length validation
  if (text.length < 2) { showToast('Keyword must be at least 2 characters', 'error'); return; }
  if (text.length > 30) { showToast('Keyword must be 30 characters or less', 'error'); return; }
  if (state.settings.keywordButtons.some(k => k.toLowerCase() === text.toLowerCase())) {
    showToast('Keyword already exists', 'info');
    return;
  }
  state.settings.keywordButtons.push(text);
  input.value = '';
  saveSettings();
  renderKeywordTagsSettings();
  renderKeywordButtonsMain();
  showToast(`Keyword "${text}" added`, 'success');
}

function removeKeyword(keyword) {
  state.settings.keywordButtons = state.settings.keywordButtons.filter(k => k !== keyword);
  state.activeKeywords.delete(keyword.toLowerCase());
  saveSettings();
  renderKeywordTagsSettings();
  renderKeywordButtonsMain();
  renderDeals();
}

function toggleKeywordFilter(keyword) {
  const key = keyword.toLowerCase();
  if (state.activeKeywords.has(key)) {
    state.activeKeywords.delete(key);
  } else {
    state.activeKeywords.add(key);
  }
  saveSettings();
  renderKeywordButtonsMain();
  renderDeals();
}

function clearKeywordFilters() {
  state.activeKeywords.clear();
  saveSettings();
  renderKeywordButtonsMain();
  renderDeals();
}

function renderKeywordTagsSettings() {
  const container = document.getElementById('keyword-tags-settings');
  const keywords = state.settings.keywordButtons;
  // F-12: Empty placeholder
  if (!keywords.length) {
    container.innerHTML = '<span class="keyword-placeholder">No keywords added yet</span>';
    return;
  }
  // F-17/F-27: Event delegation instead of inline onclick
  container.innerHTML = keywords.map(kw =>
    `<span class="keyword-tag">${escHtml(kw)}<button class="tag-remove" data-kw="${escHtml(kw)}" title="Remove">×</button></span>`
  ).join('');
  container.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', () => removeKeyword(btn.dataset.kw));
  });
}

function renderKeywordButtonsMain() {
  const bar = document.getElementById('keyword-filter-bar');
  const container = document.getElementById('keyword-buttons-main');
  const keywords = state.settings.keywordButtons;

  if (!keywords.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  // F-17/F-27: Event delegation instead of inline onclick
  const btns = keywords.map(kw => {
    const isActive = state.activeKeywords.has(kw.toLowerCase());
    return `<button class="keyword-btn${isActive ? ' active' : ''}" data-kw="${escHtml(kw)}"
      title="Click to filter by '${escHtml(kw)}'">${escHtml(kw)}</button>`;
  }).join('');

  const clearBtn = state.activeKeywords.size > 0
    ? `<button class="keyword-btn-clear" id="btn-clear-keywords" title="Clear all keyword filters">✕ Clear</button>`
    : '';

  container.innerHTML = btns + clearBtn;
  container.querySelectorAll('.keyword-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleKeywordFilter(btn.dataset.kw));
  });
  const clearEl = document.getElementById('btn-clear-keywords');
  if (clearEl) clearEl.addEventListener('click', clearKeywordFilters);
}

// ===== BLOCKED WORDS =====
function addBlockedWordFromInput() {
  const input = document.getElementById('blocked-word-input');
  const text = input.value.trim().toLowerCase();
  if (!text) return;
  if (text.length < 2) { showToast('Blocked word must be at least 2 characters', 'error'); return; }
  if (text.length > 30) { showToast('Blocked word must be 30 characters or less', 'error'); return; }
  if (!state.settings.blockedWords) state.settings.blockedWords = [];
  if (state.settings.blockedWords.some(w => w.toLowerCase() === text)) {
    showToast('Word already blocked', 'info');
    return;
  }
  state.settings.blockedWords.push(text);
  input.value = '';
  saveSettings();
  renderBlockedWordsSettings();
  showToast(`"${text}" added to blocked words`, 'success');
}

function removeBlockedWord(word) {
  state.settings.blockedWords = (state.settings.blockedWords || []).filter(w => w !== word);
  saveSettings();
  renderBlockedWordsSettings();
}

function renderBlockedWordsSettings() {
  const container = document.getElementById('blocked-words-tags');
  if (!container) return;
  const words = state.settings.blockedWords || [];
  if (!words.length) {
    container.innerHTML = '<span class="keyword-placeholder">No blocked words yet</span>';
    return;
  }
  container.innerHTML = words.map(w =>
    `<span class="keyword-tag blocked-tag">${escHtml(w)}<button class="tag-remove" data-word="${escHtml(w)}" title="Remove">×</button></span>`
  ).join('');
  container.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', () => removeBlockedWord(btn.dataset.word));
  });
}

function isBlockedDeal(deal) {
  const blocked = state.settings.blockedWords || [];
  if (!blocked.length) return false;
  const titleLow = (deal.title || '').toLowerCase();
  const subtitleLow = (deal.subtitle || '').toLowerCase();
  return blocked.some(w => titleLow.includes(w) || subtitleLow.includes(w));
}

function isAllowedCondition(deal) {
  const cond = (deal.condition || '').toLowerCase().trim();
  // No condition or "New" → always allowed
  if (!cond || cond === 'new') return true;
  const s = state.settings;
  // Open Box variants
  if (cond.includes('open box') || cond.includes('openbox')) {
    return !!s.ntfyAllowOpenBox;
  }
  // Refurbished variants
  if (cond.includes('refurbished') || cond.includes('refurb')) {
    return !!s.ntfyAllowRefurbished;
  }
  // Unknown condition → allow by default
  return true;
}

// ===== SCANNING (fetches from server, which scans Woot API autonomously) =====
async function scanDeals() {
  if (state.isScanning) return;
  state.isScanning = true;
  updateStatus('scanning');
  showLoading(true);

  // Scan button feedback
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('scanning');
  btn.querySelector('span').textContent = 'Scanning...';

  const scanStart = Date.now();

  try {
    // Trigger a server-side scan (fire & forget — server scans autonomously)
    fetch('/api/scan', { method: 'POST' }).catch(() => {});

    // Wait a moment for server scan to complete, then fetch deals
    await new Promise(r => setTimeout(r, 2000));

    const res = await fetch('/api/deals');
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    const deals = data.deals || [];

    if (deals.length === 0) {
      showToast('No deals found — check API key in Settings', 'info');
    }

    // Track new deals for UI alerts (sound, desktop notifications)
    const isFirstLoad = state.seenOfferIds.size === 0;
    const newDeals = deals.filter(d => !state.seenOfferIds.has(d.id));
    deals.forEach(d => state.seenOfferIds.add(d.id));
    saveSeenIds();

    state.deals = deals;
    state.totalDealsAllTime += newDeals.length;

    // UI-only alerts (sound, desktop notification) — ntfy/Discord handled by server
    if (!isFirstLoad) checkAlerts(newDeals);
    state.hasRenderedOnce = false;
    renderDeals();
    state.hasRenderedOnce = true;
    updateStats();

    // If we got deals from the server, the scanner is definitely active
    if (deals.length > 0) state.scannerActive = true;

    // Sync countdown with server scanner schedule
    try {
      const statusRes = await fetch('/api/scan-status');
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.scanCount > 0 || status.dealsCount > 0) state.scannerActive = true;
        state.serverInterval = status.intervalSec || 120;
        if (status.nextScanIn > 0) {
          state.countdown = Math.min(status.nextScanIn, state.serverInterval);
        }
      }
    } catch(e) { /* scan-status unavailable, use local state */ }

    updateStatus('active');

    const scanDuration = ((Date.now() - scanStart) / 1000).toFixed(1);
    document.getElementById('stat-last-scan').textContent = data.lastScan
      ? new Date(data.lastScan).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
      : new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

    state.scanHistory.unshift({ time: new Date(), count: deals.length, newCount: newDeals.length, duration: scanDuration });
    if (state.scanHistory.length > 50) state.scanHistory.pop();

    showToast(`🔴 LIVE — ${deals.length} deals (${newDeals.length} new) in ${scanDuration}s`, 'success');

    // Button success flash
    btn.classList.remove('scanning');
    btn.classList.add('scan-done');
    btn.querySelector('span').textContent = '✓ Done';
    setTimeout(() => { btn.classList.remove('scan-done'); btn.querySelector('span').textContent = 'Scan Now'; }, 1500);

  } catch (err) {
    console.error('Scan error:', err);
    showToast('Scan failed: ' + err.message, 'error');
    updateStatus('error');
    btn.classList.remove('scanning');
    btn.querySelector('span').textContent = 'Scan Now';
  }

  state.isScanning = false;
  showLoading(false);
  resetCountdown();
}

// normalizeAPIItem and dedupeDeals moved to server.js — deals arrive pre-normalized

// Demo data removed — deals arrive pre-normalized from server API

// ===== ALERTS =====
// checkAlerts — UI-only alerts (sound, desktop notifications)
// ntfy.sh and Discord are now handled server-side autonomously
function checkAlerts(newDeals) {
  const s = state.settings;
  const activeKws = [...state.activeKeywords];

  function matchesKeywords(deal) {
    if (activeKws.length === 0) return true;
    const titleLow = deal.title.toLowerCase();
    const subtitleLow = (deal.subtitle || '').toLowerCase();
    return activeKws.some(kw => titleLow.includes(kw) || subtitleLow.includes(kw));
  }

  newDeals.forEach(deal => {
    let triggered = false;
    if (deal.discount >= s.minDiscount && deal.salePrice >= s.minPrice && deal.salePrice <= s.maxPrice && !deal.isSoldOut) {
      triggered = true;
    }
    if (triggered && !matchesKeywords(deal)) triggered = false;
    if (triggered) addAlert(deal);
  });
}

function addAlert(deal) {
  state.alertCount++;
  const alert = { deal, time: new Date() };
  state.alerts.unshift(alert);
  if (state.alerts.length > 100) state.alerts.pop();

  if (state.settings.soundEnabled) playAlertSound();
  if (state.settings.notificationsEnabled) sendNotification(deal);
  // ntfy.sh is now evaluated independently in checkAlerts()
  
  // F-29: Pulse bell icon on new alert (auto-stop after 10s)
  const logoIcon = document.querySelector('.logo-icon');
  if (logoIcon) {
    logoIcon.classList.add('has-alerts');
    clearTimeout(state._bellTimeout);
    state._bellTimeout = setTimeout(() => logoIcon.classList.remove('has-alerts'), 10000);
  }

  renderAlerts();
  document.getElementById('stat-alerts').textContent = state.alertCount;
}

function clearAlerts() {
  state.alerts = [];
  state.alertCount = 0;
  document.getElementById('stat-alerts').textContent = '0';
  // F-29: Stop bell pulse
  document.querySelector('.logo-icon')?.classList.remove('has-alerts');
  clearTimeout(state._bellTimeout);
  renderAlerts();
}

// PERF-04: Reuse AudioContext instead of creating one per alert
let _audioCtx = null;
function playAlertSound() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.setValueAtTime(880, _audioCtx.currentTime);
    osc.frequency.setValueAtTime(1100, _audioCtx.currentTime + 0.1);
    osc.frequency.setValueAtTime(880, _audioCtx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.15, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, _audioCtx.currentTime + 0.4);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.4);
  } catch(e) {}
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(deal) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('🔥 Woot Deal Alert!', {
      body: `${deal.title}\n$${deal.salePrice.toFixed(2)} (-${deal.discount}%)`,
      icon: deal.photo,
      tag: deal.id
    });
  }
}

// sendNtfyNotification and sendDiscordNotification moved to server.js
// Server sends notifications autonomously — no browser needed

// ===== RENDER =====
function renderDeals() {
  const grid = document.getElementById('deals-grid');
  const search = document.getElementById('search-input').value.toLowerCase();
  const sort = document.getElementById('sort-select').value;
  const filter = document.querySelector('.filter-chip.active')?.dataset.filter || 'all';

  let filtered = [...state.deals];

  // Hide sold out deals
  filtered = filtered.filter(d => !d.isSoldOut);

  // Hide deals matching blocked words
  filtered = filtered.filter(d => !isBlockedDeal(d));

  // Keyword button filter (OR logic) — only applies on 'all' and 'great' views
  // When using specific filters (hot, new, ending, warehouse, favorites),
  // show ALL matching deals regardless of keywords
  const skipKeywords = ['hot', 'new', 'ending', 'warehouse', 'favorites'].includes(filter);
  const definedKws = (state.settings.keywordButtons || []).map(k => k.toLowerCase());
  if (definedKws.length > 0 && !skipKeywords) {
    // If some keywords are toggled active → show only those
    // If none are active → show all keyword-matched deals
    const filterKws = state.activeKeywords.size > 0 ? [...state.activeKeywords] : definedKws;
    filtered = filtered.filter(d => {
      const titleLow = d.title.toLowerCase();
      const subtitleLow = (d.subtitle || '').toLowerCase();
      return filterKws.some(kw => titleLow.includes(kw) || subtitleLow.includes(kw));
    });
  }

  // Search
  if (search) filtered = filtered.filter(d => d.title.toLowerCase().includes(search));

  // Quick filters
  if (filter === 'hot') filtered = filtered.filter(d => d.discount >= 60);
  else if (filter === 'great') filtered = filtered.filter(d => d.discount >= 40);
  else if (filter === 'new') {
    const hourAgo = Date.now() - 3600000;
    filtered = filtered.filter(d => new Date(d.startDate).getTime() > hourAgo);
  } else if (filter === 'ending') {
    const soonMs = Date.now() + 4 * 3600000;
    filtered = filtered.filter(d => d.endDate && new Date(d.endDate).getTime() < soonMs);
  } else if (filter === 'warehouse') {
    filtered = filtered.filter(d => {
      const url = (d.url || '').toLowerCase();
      const title = (d.title || '').toLowerCase();
      const mkt = (d.marketingName || '').toLowerCase();
      return url.includes('sellout.woot.com') || url.includes('warehouse') || url.includes('clean-out')
        || title.includes('warehouse') || title.includes('clean out')
        || mkt.includes('clearance') || mkt.includes('warehouse');
    });
  } else if (filter === 'favorites') {
    filtered = filtered.filter(d => state.favorites.has(d.id));
  }

  // Sort
  if (sort === 'discount-desc') filtered.sort((a,b) => b.discount - a.discount);
  else if (sort === 'price-asc') filtered.sort((a,b) => a.salePrice - b.salePrice);
  else if (sort === 'price-desc') filtered.sort((a,b) => b.salePrice - a.salePrice);
  else if (sort === 'newest') filtered.sort((a,b) => new Date(b.startDate) - new Date(a.startDate));

  // Show/hide empty state
  document.getElementById('empty-state').style.display = filtered.length === 0 ? 'block' : 'none';

  // F-16: Fix deals count denominator (exclude sold out)
  const countEl = document.getElementById('deals-count');
  const availableTotal = state.deals.filter(d => !d.isSoldOut).length;
  if (countEl) countEl.textContent = `${filtered.length} of ${availableTotal} deals`;

  grid.innerHTML = filtered.map((deal, i) => {
    const isHot = deal.discount >= 50;
    const endMs = deal._endMs || (deal.endDate ? new Date(deal.endDate).getTime() : null);
    const isEnding = endMs && (endMs - Date.now()) < 4*3600000;
    const hoursLeft = endMs ? Math.max(0, Math.round((endMs - Date.now()) / 3600000)) : null;
    const timeLeftText = hoursLeft !== null ? formatTimeLeft(hoursLeft) : '';
    const catLabel = deal.primaryCategory || '';
    const conditionLabel = deal.condition || '';
    const animClass = !state.hasRenderedOnce ? 'animate-in' : '';

    // Format price range
    const priceRange = deal.salePriceMax > deal.salePrice
      ? `$${deal.salePrice.toFixed(2)} – $${deal.salePriceMax.toFixed(2)}`
      : `$${deal.salePrice.toFixed(2)}`;

    return `
    <div class="deal-card ${isHot ? 'hot-deal' : ''} ${animClass}" style="${!state.hasRenderedOnce ? 'animation-delay:'+Math.min(i*0.03,0.6)+'s' : ''}">
      <div class="deal-badges">
        ${deal.discount > 0 ? `<span class="badge ${deal.discount >= 60 ? 'badge-hot' : deal.discount >= 40 ? 'badge-discount' : 'badge-mild'}">${deal.discount}% OFF</span>` : ''}
        ${deal.isSoldOut ? '<span class="badge badge-soldout">Sold Out</span>' : ''}
        ${isEnding && !deal.isSoldOut ? '<span class="badge badge-ending">⏰ Ending Soon</span>' : ''}
        ${deal.isWootOff ? '<span class="badge badge-wootoff">⚡ Woot-Off!</span>' : ''}
        ${deal.isFeatured ? '<span class="badge badge-featured">★ Featured</span>' : ''}
      </div>
      <img class="deal-image" src="${deal.photo}" alt="${escHtml(deal.title)}" ${i < 8 ? '' : 'loading="lazy"'} onerror="this.src='https://placehold.co/400x300/1a1a2e/333?text=No+Image'">
      <div class="deal-body">
        <div class="deal-title"><a href="${deal.url}" target="_blank" rel="noopener">${escHtml(deal.title)}</a></div>
        <div class="deal-condition">
          ${conditionLabel ? `<span class="condition-tag">${escHtml(conditionLabel)}</span>` : ''}
          ${catLabel ? `<span class="category-tag">${escHtml(catLabel)}</span>` : ''}
        </div>
        <div class="deal-pricing">
          <span class="deal-sale-price">${priceRange}</span>
          ${deal.listPrice > 0 ? `<span class="deal-list-price">$${deal.listPrice.toFixed(2)}</span>` : ''}
          ${deal.discount > 0 ? `<span class="deal-savings">Save $${(deal.listPrice - deal.salePrice).toFixed(2)}</span>` : ''}
        </div>
      </div>
      <div class="deal-footer">
        <span class="deal-meta">${timeLeftText}</span>
        <div class="deal-actions">
          <button class="deal-fav ${state.favorites.has(deal.id) ? 'active' : ''}" data-deal-id="${deal.id}" title="${state.favorites.has(deal.id) ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Toggle favorite">${state.favorites.has(deal.id) ? '💖' : '🤍'}</button>
          ${deal.forumUrl ? `<a href="${deal.forumUrl}" target="_blank" rel="noopener" class="deal-forum" title="Forum Discussion">💬</a>` : ''}
          <a href="${deal.url}" target="_blank" rel="noopener" class="deal-cta" aria-label="View deal: ${escHtml(deal.title)} at ${priceRange}">View Deal →</a>
        </div>
      </div>
    </div>`;
  }).join('');

  // Event delegation for favorite buttons
  grid.querySelectorAll('.deal-fav').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.dealId);
    });
  });
}

function toggleFavorite(dealId) {
  if (state.favorites.has(dealId)) {
    state.favorites.delete(dealId);
    showToast('Removed from favorites', 'info');
  } else {
    state.favorites.add(dealId);
    showToast('Added to favorites! 💖', 'success');
  }
  saveFavorites();
  renderDeals();
}

function saveFavorites() {
  const arr = [...state.favorites].slice(-500);
  localStorage.setItem('woot-favorites', JSON.stringify(arr));
}

function renderAlerts() {
  const section = document.getElementById('alerts-section');
  const feed = document.getElementById('alerts-feed');
  section.style.display = state.alerts.length ? 'block' : 'none';
  feed.innerHTML = state.alerts.slice(0, 15).map(a => {
    const d = a.deal;
    const time = a.time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    return `
    <div class="alert-item">
      <div class="alert-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
      <div class="alert-info">
        <div class="alert-title"><a href="${d.url}" target="_blank" rel="noopener">${escHtml(d.title)}</a></div>
        <div class="alert-detail">$${d.salePrice.toFixed(2)} · ${d.discount}% off${d.listPrice > 0 ? ` · was $${d.listPrice.toFixed(2)}` : ''}</div>
      </div>
      <span class="alert-time">${time}</span>
    </div>`;
  }).join('');
}

function updateStats() {
  const available = state.deals.filter(d => !d.isSoldOut).length;
  document.getElementById('stat-total').textContent = available;
  const hotCount = state.deals.filter(d => d.discount >= 50 && !d.isSoldOut).length;
  document.getElementById('stat-hot').textContent = hotCount;
  document.getElementById('stat-alerts').textContent = state.alertCount;
}

function updateStatus(s) {
  const el = document.getElementById('status-indicator');
  const txt = document.getElementById('status-text');
  el.className = 'status-indicator' + (s === 'active' ? ' active' : s === 'error' ? ' error' : '');
  if (s === 'active') {
    txt.textContent = state.scannerActive ? '🔴 Live' : 'Connecting...';
  } else if (s === 'scanning') {
    txt.textContent = 'Scanning...';
  } else if (s === 'error') {
    txt.textContent = 'Error';
  } else {
    txt.textContent = 'Initializing...';
  }
}

function showLoading(show) {
  const el = document.getElementById('loading-state');
  if (el) el.style.display = show ? 'flex' : 'none';
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  // F-30: Limit to 4 visible toasts
  while (container.children.length >= 4) container.firstChild.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  const iconMap = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `<span class="toast-icon">${iconMap[type] || 'ℹ'}</span><span class="toast-message">${escHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ===== AUTO REFRESH =====
function startAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  // Use server interval if available, otherwise local setting
  const interval = state.serverInterval || state.settings.refreshInterval;
  if (interval <= 0) {
    document.getElementById('scan-timer').style.display = 'none';
    return;
  }
  document.getElementById('scan-timer').style.display = '';
  if (!state.countdown || state.countdown <= 0) state.countdown = interval;
  state.timer = setInterval(() => {
    state.countdown--;
    if (state.countdown <= 0) { scanDeals(); state.countdown = interval; }
    const m = Math.floor(state.countdown / 60);
    const s = state.countdown % 60;
    const countdownStr = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    document.getElementById('countdown').textContent = countdownStr;
    // Also update header countdown
    const hc = document.getElementById('header-countdown');
    if (hc) hc.textContent = countdownStr;
  }, 1000);
}

function resetCountdown() {
  // Use server-synced countdown if available, otherwise local interval
  const interval = state.serverInterval || state.settings.refreshInterval;
  if (!state.countdown || state.countdown <= 0) state.countdown = interval;
}

// F-23: Regex escHtml (no DOM allocation per call)
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function formatTimeLeft(hours) {
  if (hours > 48) return Math.round(hours / 24) + 'd left';
  if (hours > 1) return hours + 'h left';
  if (hours === 1) return '1h left';
  return '<1h left';
}

// ===== EXPORT CSV =====
function exportDealsCSV() {
  if (!state.deals.length) { showToast('No deals to export', 'info'); return; }
  const headers = ['Title','Sale Price','List Price','Discount %','Condition','Category','Sold Out','URL'];
  const rows = state.deals.map(d => [
    '"' + (d.title || '').replace(/"/g, '""') + '"',
    d.salePrice?.toFixed(2) || '',
    d.listPrice?.toFixed(2) || '',
    d.discount || 0,
    d.condition || '',
    d.primaryCategory || '',
    d.isSoldOut ? 'Yes' : 'No',
    d.url || ''
  ].join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `woot-deals-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${state.deals.length} deals to CSV`, 'success');
}

// Quiet hours now handled server-side only (scanner)
