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
  serverInterval: 120,
  activeCategories: new Set(['PC', 'TECH']),  // Dynamic tag filter — PC & TECH selected by default
  unreadAlerts: 0  // Badge counter for unread notifications
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await loadSettings();
  bindEvents();
  requestNotificationPermission();
  scanDeals();
  startAutoRefresh();
  connectSSE();
  initBackToTop();
  initPullToRefresh();
});

// Back to Top FAB
function initBackToTop() {
  const fab = document.getElementById('fab-top');
  if (!fab) return;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        fab.classList.toggle('visible', window.scrollY > 400);
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
  fab.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Pull to Refresh (mobile PWA)
function initPullToRefresh() {
  const indicator = document.getElementById('ptr-indicator');
  const spinner = indicator?.querySelector('.ptr-spinner');
  const text = indicator?.querySelector('.ptr-text');
  if (!indicator) return;

  const THRESHOLD = 60;
  let startY = 0;
  let pulling = false;
  let refreshing = false;

  document.addEventListener('touchstart', (e) => {
    if (refreshing || window.scrollY > 5) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    if (dy <= 0) return;

    const progress = Math.min(dy / THRESHOLD, 1);
    const height = Math.min(dy * 0.5, 50);
    indicator.style.height = height + 'px';
    indicator.style.padding = height > 10 ? '8px 0' : '0';
    indicator.classList.add('pulling');

    // Rotate spinner based on pull progress
    if (spinner) spinner.style.transform = `rotate(${progress * 360}deg)`;
    if (text) text.textContent = progress >= 1 ? 'Release to refresh' : 'Pull down to refresh';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling || refreshing) return;
    pulling = false;

    const currentHeight = parseFloat(indicator.style.height) || 0;
    if (currentHeight >= THRESHOLD * 0.4) {
      // Trigger refresh
      refreshing = true;
      indicator.classList.remove('pulling');
      indicator.classList.add('refreshing');
      indicator.style.height = '';
      indicator.style.padding = '';
      if (text) text.textContent = 'Refreshing...';
      if (spinner) spinner.style.transform = '';

      scanDeals().finally(() => {
        setTimeout(() => {
          refreshing = false;
          indicator.classList.remove('refreshing');
          if (text) text.textContent = 'Release to refresh';
        }, 600);
      });
    } else {
      // Cancel — snap back
      indicator.classList.remove('pulling');
      indicator.style.height = '0';
      indicator.style.padding = '0';
      if (spinner) spinner.style.transform = '';
    }
  }, { passive: true });
}

async function loadSettings() {
  // Try server first (shared across devices), fall back to localStorage
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const serverSettings = await res.json();
      if (serverSettings && Object.keys(serverSettings).length > 0) {
        // HIGH-04: Server masks apiKey — show masked version so user knows it's saved
        Object.assign(state.settings, serverSettings);
        if (serverSettings.apiKey && serverSettings.apiKey.includes('•')) {
          state._apiKeyMasked = true; // Track that we're showing a masked key
        } else {
          state._apiKeyMasked = false;
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
  // Migrate favorites to server
  loadFavoritesFromServer();
}

// ===== DARK / LIGHT MODE =====
function initTheme() {
  const saved = localStorage.getItem('woot-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('woot-theme', next);
  // Update meta theme-color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === 'light' ? '#f5f5f7' : '#6366f1';
}

// ===== SERVER FAVORITES =====
async function loadFavoritesFromServer() {
  try {
    const res = await fetch('/api/favorites');
    if (res.ok) {
      const serverFavs = await res.json();
      if (Array.isArray(serverFavs)) {
        serverFavs.forEach(id => state.favorites.add(id));
        // Migrate localStorage favs to server
        const localFavs = [...state.favorites];
        const toSync = localFavs.filter(id => !serverFavs.includes(id));
        for (const id of toSync.slice(0, 50)) {
          fetch('/api/favorites', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) }).catch(() => {});
        }
      }
    }
  } catch(e) {}
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
  // API Key: show masked version or actual key
  const apiKeyInput = document.getElementById('api-key');
  apiKeyInput.value = s.apiKey || '';
  updateApiKeyStatus(s.apiKey);
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
  // Telegram
  document.getElementById('toggle-telegram').classList.toggle('active', !!s.telegramEnabled);
  document.getElementById('toggle-telegram').setAttribute('aria-checked', !!s.telegramEnabled);
  document.getElementById('telegram-bot-token').value = s.telegramBotToken || '';
  document.getElementById('telegram-chat-id').value = s.telegramChatId || '';
  const tgVis = s.telegramEnabled ? '' : 'none';
  document.getElementById('telegram-settings-group').style.display = tgVis;
  document.getElementById('telegram-chatid-group').style.display = tgVis;
  // Email
  document.getElementById('toggle-email').classList.toggle('active', !!s.emailEnabled);
  document.getElementById('toggle-email').setAttribute('aria-checked', !!s.emailEnabled);
  document.getElementById('email-address').value = s.emailAddress || '';
  document.getElementById('email-app-password').value = s.emailAppPassword || '';
  document.getElementById('email-recipient').value = s.emailRecipient || '';
  const emailVis = s.emailEnabled ? '' : 'none';
  document.getElementById('email-address-group').style.display = emailVis;
  document.getElementById('email-password-group').style.display = emailVis;
  document.getElementById('email-recipient-group').style.display = emailVis;
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', s.categories.includes(c.dataset.category));
  });
  renderKeywordTagsSettings();
  renderKeywordButtonsMain();
  renderBlockedWordsSettings();
}

// ===== API KEY STATUS =====
function updateApiKeyStatus(apiKey) {
  const statusEl = document.getElementById('api-key-status');
  if (!statusEl) return;
  if (apiKey && apiKey.length > 0) {
    statusEl.className = 'api-key-status configured';
    statusEl.innerHTML = '✅ API Key configured';
  } else {
    statusEl.className = 'api-key-status missing';
    statusEl.innerHTML = '⚠️ No API Key — scanner disabled';
  }
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('api-key');
  const btn = document.getElementById('btn-toggle-api-key');
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.textContent = '🙈';
  } else {
    input.type = 'password';
    if (btn) btn.textContent = '👁';
  }
}

// ===== EVENTS =====
function bindEvents() {
  document.getElementById('btn-refresh').addEventListener('click', () => scanDeals());
  // FAB scan button (mobile)
  const fabScan = document.getElementById('fab-scan');
  if (fabScan) fabScan.addEventListener('click', () => scanDeals());
  document.getElementById('btn-settings').addEventListener('click', () => toggleSettings(true));
  document.getElementById('btn-close-settings').addEventListener('click', () => toggleSettings(false));
  document.getElementById('settings-overlay').addEventListener('click', () => toggleSettings(false));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromUI);
  document.getElementById('btn-reset-settings').addEventListener('click', resetSettings);
  document.getElementById('btn-clear-alerts').addEventListener('click', clearAlerts);
  document.getElementById('btn-export-csv').addEventListener('click', exportDealsCSV);
  // Bell badge: click to mark alerts as read
  const logoBell = document.getElementById('logo-bell');
  if (logoBell) logoBell.addEventListener('click', () => {
    state.unreadAlerts = 0;
    updateAlertBadge();
    logoBell.classList.remove('has-alerts');
    clearTimeout(state._bellTimeout);
  });
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // View toggle: grid ↔ list
  const viewToggle = document.getElementById('btn-view-toggle');
  if (viewToggle) {
    // Restore saved preference
    if (localStorage.getItem('woot-view-mode') === 'list') {
      document.getElementById('deals-grid')?.classList.add('list-view');
      document.body.classList.add('list-mode');
    }
    viewToggle.addEventListener('click', () => {
      const grid = document.getElementById('deals-grid');
      if (!grid) return;
      const isList = grid.classList.toggle('list-view');
      document.body.classList.toggle('list-mode', isList);
      localStorage.setItem('woot-view-mode', isList ? 'list' : 'grid');
    });
  }

  // API Key: show/hide toggle + clear masked key on edit
  const apiKeyToggle = document.getElementById('btn-toggle-api-key');
  if (apiKeyToggle) apiKeyToggle.addEventListener('click', toggleApiKeyVisibility);
  const apiKeyInput = document.getElementById('api-key');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('focus', () => {
      // When user clicks on the masked key field, clear it so they can type a new one
      if (state._apiKeyMasked && apiKeyInput.value.includes('•')) {
        apiKeyInput.value = '';
        apiKeyInput.type = 'text'; // Show what they're typing
        const btn = document.getElementById('btn-toggle-api-key');
        if (btn) btn.textContent = '🙈';
      }
    });
    apiKeyInput.addEventListener('input', () => {
      updateApiKeyStatus(apiKeyInput.value);
    });
  }

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

  ['toggle-sound','toggle-notifications','toggle-ntfy','toggle-discord','toggle-allow-openbox','toggle-allow-refurbished','toggle-telegram','toggle-email'].forEach(id => {
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
      if (id === 'toggle-telegram') {
        const vis = el.classList.contains('active') ? '' : 'none';
        document.getElementById('telegram-settings-group').style.display = vis;
        document.getElementById('telegram-chatid-group').style.display = vis;
      }
      if (id === 'toggle-email') {
        const vis = el.classList.contains('active') ? '' : 'none';
        document.getElementById('email-address-group').style.display = vis;
        document.getElementById('email-password-group').style.display = vis;
        document.getElementById('email-recipient-group').style.display = vis;
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
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(renderDeals, 300);
    // Show/hide clear button
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = searchInput.value ? 'flex' : 'none';
  });
  // Search clear button
  const searchClear = document.getElementById('search-clear');
  if (searchClear) searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    renderDeals();
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

  // Show/hide for Telegram token and Email password
  const tgToggle = document.getElementById('btn-toggle-tg-token');
  if (tgToggle) tgToggle.addEventListener('click', () => {
    const inp = document.getElementById('telegram-bot-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    tgToggle.textContent = inp.type === 'password' ? '👁' : '🙈';
  });
  const emailToggle = document.getElementById('btn-toggle-email-pass');
  if (emailToggle) emailToggle.addEventListener('click', () => {
    const inp = document.getElementById('email-app-password');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    emailToggle.textContent = inp.type === 'password' ? '👁' : '🙈';
  });

  // Clear masked secrets on focus (same pattern as API key)
  ['telegram-bot-token', 'email-app-password'].forEach(id => {
    const inp = document.getElementById(id);
    if (inp) inp.addEventListener('focus', () => {
      if (inp.value.includes('•')) {
        inp.value = '';
        inp.type = 'text';
      }
    });
  });

  // Test buttons
  const testTg = document.getElementById('btn-test-telegram');
  if (testTg) testTg.addEventListener('click', async () => {
    const token = document.getElementById('telegram-bot-token').value.trim();
    const chatId = document.getElementById('telegram-chat-id').value.trim();
    if (!token || !chatId) { showToast('Enter Bot Token and Chat ID first', 'error'); return; }
    testTg.disabled = true; testTg.textContent = '⏳...';
    try {
      const res = await fetch('/api/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: token, chatId })
      });
      const data = await res.json();
      showToast(data.ok ? '✅ Telegram test sent!' : `❌ ${data.error || 'Failed'}`, data.ok ? 'success' : 'error');
    } catch (e) { showToast('Failed to test Telegram', 'error'); }
    testTg.disabled = false; testTg.textContent = '🧪 Test';
  });

  const testEmail = document.getElementById('btn-test-email');
  if (testEmail) testEmail.addEventListener('click', async () => {
    const addr = document.getElementById('email-address').value.trim();
    const pass = document.getElementById('email-app-password').value.trim();
    const recipient = document.getElementById('email-recipient').value.trim();
    if (!addr || !pass) { showToast('Enter Gmail address and App Password first', 'error'); return; }
    testEmail.disabled = true; testEmail.textContent = '⏳...';
    try {
      const res = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailAddress: addr, emailAppPassword: pass, emailRecipient: recipient })
      });
      const data = await res.json();
      showToast(data.ok ? '✅ Test email sent!' : `❌ ${data.error || 'Failed'}`, data.ok ? 'success' : 'error');
    } catch (e) { showToast('Failed to test email', 'error'); }
    testEmail.disabled = false; testEmail.textContent = '🧪 Test';
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
  // API Key: only update if user actually changed it (not the masked version)
  const apiKeyVal = document.getElementById('api-key').value.trim();
  if (apiKeyVal && !apiKeyVal.includes('•')) {
    s.apiKey = apiKeyVal; // User entered a new key
    state._apiKeyMasked = false;
  } else if (!apiKeyVal) {
    s.apiKey = ''; // User cleared the key
    state._apiKeyMasked = false;
  }
  // If it contains •, leave s.apiKey as-is (the server will preserve the real key)
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
  // Telegram
  s.telegramEnabled = document.getElementById('toggle-telegram').classList.contains('active');
  const tgTokenVal = document.getElementById('telegram-bot-token').value.trim();
  if (tgTokenVal && !tgTokenVal.includes('•')) s.telegramBotToken = tgTokenVal;
  else if (!tgTokenVal) s.telegramBotToken = '';
  s.telegramChatId = document.getElementById('telegram-chat-id').value.trim();
  // Email
  s.emailEnabled = document.getElementById('toggle-email').classList.contains('active');
  s.emailAddress = document.getElementById('email-address').value.trim();
  const emailPassVal = document.getElementById('email-app-password').value.trim();
  if (emailPassVal && !emailPassVal.includes('•')) s.emailAppPassword = emailPassVal;
  else if (!emailPassVal) s.emailAppPassword = '';
  s.emailRecipient = document.getElementById('email-recipient').value.trim();
  // F-11: Validate ntfy topic
  if (s.ntfyEnabled) {
    if (!s.ntfyTopic) { showToast('Please enter a ntfy.sh topic name', 'error'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(s.ntfyTopic)) { showToast('ntfy topic: only letters, numbers, - and _ allowed', 'error'); return; }
  }
  // Validate Telegram
  if (s.telegramEnabled) {
    if (!s.telegramBotToken && !document.getElementById('telegram-bot-token').value.includes('•')) {
      showToast('Please enter a Telegram Bot Token', 'error'); return;
    }
    if (!s.telegramChatId) { showToast('Please enter a Telegram Chat ID', 'error'); return; }
  }
  // Validate Email
  if (s.emailEnabled) {
    if (!s.emailAddress) { showToast('Please enter a Gmail address', 'error'); return; }
    if (!s.emailAppPassword && !document.getElementById('email-app-password').value.includes('•')) {
      showToast('Please enter a Gmail App Password', 'error'); return;
    }
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
  const raw = input.value.trim();
  if (!raw) return;
  // Support comma-separated input: "amd, intel, ryzen" → 3 keywords
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  let added = 0;
  for (const text of items) {
    if (text.length < 2) { showToast(`"${text}" must be at least 2 characters`, 'error'); continue; }
    if (text.length > 30) { showToast(`"${text}" must be 30 characters or less`, 'error'); continue; }
    if (state.settings.keywordButtons.some(k => k.toLowerCase() === text.toLowerCase())) {
      if (items.length === 1) showToast('Keyword already exists', 'info');
      continue;
    }
    state.settings.keywordButtons.push(text);
    added++;
  }
  input.value = '';
  if (added > 0) {
    saveSettings();
    renderKeywordTagsSettings();
    renderKeywordButtonsMain();
    showToast(`${added} keyword${added > 1 ? 's' : ''} added`, 'success');
  }
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

function selectAllKeywords() {
  const keywords = state.settings.keywordButtons || [];
  keywords.forEach(kw => state.activeKeywords.add(kw.toLowerCase()));
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

  const allActive = keywords.every(kw => state.activeKeywords.has(kw.toLowerCase()));
  const selectAllBtn = !allActive
    ? `<button class="keyword-btn-clear keyword-btn-selectall" id="btn-select-all-keywords" title="Select all keywords">✓ All</button>`
    : '';
  const clearBtn = state.activeKeywords.size > 0
    ? `<button class="keyword-btn-clear" id="btn-clear-keywords" title="Clear all keyword filters">✕ Clear</button>`
    : '';

  container.innerHTML = btns + selectAllBtn + clearBtn;
  container.querySelectorAll('.keyword-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleKeywordFilter(btn.dataset.kw));
  });
  const selectAllEl = document.getElementById('btn-select-all-keywords');
  if (selectAllEl) selectAllEl.addEventListener('click', selectAllKeywords);
  const clearEl = document.getElementById('btn-clear-keywords');
  if (clearEl) clearEl.addEventListener('click', clearKeywordFilters);
}

// ===== BLOCKED WORDS =====
function addBlockedWordFromInput() {
  const input = document.getElementById('blocked-word-input');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;
  // Support comma-separated input: "tablet, celular, case" → 3 blocked words
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!state.settings.blockedWords) state.settings.blockedWords = [];
  let added = 0;
  for (const text of items) {
    if (text.length < 2) { showToast(`"${text}" must be at least 2 characters`, 'error'); continue; }
    if (text.length > 30) { showToast(`"${text}" must be 30 characters or less`, 'error'); continue; }
    if (state.settings.blockedWords.some(w => w.toLowerCase() === text)) {
      if (items.length === 1) showToast('Word already blocked', 'info');
      continue;
    }
    state.settings.blockedWords.push(text);
    added++;
  }
  input.value = '';
  if (added > 0) {
    saveSettings();
    renderBlockedWordsSettings();
    showToast(`${added} blocked word${added > 1 ? 's' : ''} added`, 'success');
  }
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

// ===== DYNAMIC TAG FILTER =====
// Uses deal.primaryCategory — the actual tag shown on each card (PC, TOOLS, SPORT, HOME, TECH, etc.)
const TAG_EMOJIS = {
  'pc': '💻', 'tech': '🔌', 'electronics': '🔌', 'home': '🏠', 'tools': '🔧',
  'sport': '⚽', 'shirts': '👕', 'gourmet': '🍽️', 'wine': '🍷', 'kids': '🧸',
  'kitchen': '🍳', 'garden': '🌿', 'auto': '🚗', 'office': '🖨️', 'health': '💊',
  'accessories': '🎒', 'audio': '🎧', 'gaming': '🎮', 'outdoor': '🏕️', 'pets': '🐾',
  'industrial': '🏭', 'photography': '📷', 'wearable': '⌚', 'phone': '📱',
};

// Tag count history for sparklines (last 10 snapshots per tag)
const tagHistory = {}; // { tagName: [count1, count2, ...] }
const TAG_HISTORY_MAX = 10;

function recordTagHistory(tagCounts) {
  for (const [tag, count] of Object.entries(tagCounts)) {
    if (!tagHistory[tag]) tagHistory[tag] = [];
    const h = tagHistory[tag];
    // Only push if changed or first entry
    if (h.length === 0 || h[h.length - 1] !== count) {
      h.push(count);
      if (h.length > TAG_HISTORY_MAX) h.shift();
    }
  }
}

function miniSparklineSVG(points) {
  if (!points || points.length < 2) return '';
  const w = 36, h = 12;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const trend = points[points.length - 1] - points[0];
  const color = trend > 0 ? '#10b981' : trend < 0 ? '#ef4444' : '#6b7280';
  return `<svg class="tag-sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${coords}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function getDealTag(deal) {
  const tag = (deal.primaryCategory || '').trim();
  return tag || null;
}

function renderCategoryFilterBar() {
  const bar = document.getElementById('category-filter-bar');
  const container = document.getElementById('category-filter-buttons');
  if (!bar || !container) return;

  // Count deals per tag (exclude sold out & blocked)
  const tagCounts = {};
  state.deals.forEach(d => {
    if (d.isSoldOut || isBlockedDeal(d)) return;
    const tag = getDealTag(d);
    if (tag) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  });

  const tags = Object.keys(tagCounts).filter(t => tagCounts[t] > 0);

  if (tags.length <= 1) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  // Sort: pin PC & TECH first, then by count descending
  const pinned = ['PC', 'TECH'];
  tags.sort((a, b) => {
    const aPin = pinned.indexOf(a);
    const bPin = pinned.indexOf(b);
    if (aPin !== -1 && bPin !== -1) return aPin - bPin;
    if (aPin !== -1) return -1;
    if (bPin !== -1) return 1;
    return tagCounts[b] - tagCounts[a];
  });

  // Record for sparkline history
  recordTagHistory(tagCounts);

  const btns = tags.map(tag => {
    const emoji = TAG_EMOJIS[tag.toLowerCase()] || '🏷️';
    const isActive = state.activeCategories.has(tag);
    const colorKey = tag.toLowerCase().replace(/[^a-z]/g, '');
    const sparkline = miniSparklineSVG(tagHistory[tag]);
    return `<button class="cat-filter-btn${isActive ? ' active' : ''}" data-cat-key="${escHtml(tag)}" data-cat-color="${colorKey}"
      title="Show only '${escHtml(tag)}' tagged deals (${tagCounts[tag]})">${emoji} ${escHtml(tag)} <span class="cat-count">${tagCounts[tag]}</span>${sparkline}</button>`;
  }).join('');

  const clearBtn = state.activeCategories.size > 0
    ? `<button class="cat-filter-btn-clear" id="btn-clear-categories" title="Clear tag filter">✕ Clear</button>`
    : '';

  container.innerHTML = btns + clearBtn;

  // Bind events
  container.querySelectorAll('.cat-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleCategoryFilter(btn.dataset.catKey));
  });
  const clearEl = document.getElementById('btn-clear-categories');
  if (clearEl) clearEl.addEventListener('click', clearCategoryFilters);
}

function toggleCategoryFilter(catKey) {
  if (state.activeCategories.has(catKey)) {
    state.activeCategories.delete(catKey);
  } else {
    state.activeCategories.add(catKey);
  }
  renderCategoryFilterBar();
  renderDeals();
}

function clearCategoryFilters() {
  state.activeCategories.clear();
  renderCategoryFilterBar();
  renderDeals();
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
      // Check if rate limited before showing generic message
      try {
        const statusRes = await fetch('/api/scan-status');
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (status.rateLimited) {
            showToast(`⚠️ Rate limited by Woot API — backing off ${Math.round(status.backoffSec / 60)}min`, 'error');
          } else {
            showToast('No deals found — check API key in Settings', 'info');
          }
        } else {
          showToast('No deals found — check API key in Settings', 'info');
        }
      } catch(e) {
        showToast('No deals found — check API key in Settings', 'info');
      }
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

// ===== SSE LIVE UPDATES =====
let _sseSource = null;
function connectSSE() {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
  try {
    _sseSource = new EventSource('/api/events');
    _sseSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') {
          state.serverInterval = data.intervalSec || 120;
          if (data.nextScanIn > 0) state.countdown = Math.min(data.nextScanIn, state.serverInterval);
          console.log('[SSE] Connected —', data.dealCount, 'deals');
        } else if (data.type === 'scan-complete') {
          state.serverInterval = data.nextScanIn || state.serverInterval;
          state.countdown = data.nextScanIn || state.serverInterval;
          state.scannerActive = true;
          // Handle rate limiting
          if (data.rateLimited) {
            updateStatus('ratelimited');
            showToast(`⚠️ Woot API rate limited — retrying in ${Math.round(data.backoffSec / 60)}min`, 'error');
            console.warn(`[SSE] Rate limited. Backoff: ${data.backoffSec}s`);
          } else {
            // Auto-refresh deals if there are new ones
            if (data.newCount > 0 || state.deals.length === 0) {
              fetchDealsQuiet();
            }
            updateStatus('active');
          }
          // Update last scan time display
          if (data.lastScan) {
            document.getElementById('stat-last-scan').textContent = new Date(data.lastScan).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
          }
        } else if (data.type === 'scan-error') {
          console.warn('[SSE] Scan error:', data.error);
        }
      } catch(err) {}
    };
    _sseSource.onerror = () => {
      console.warn('[SSE] Connection lost, reconnecting...');
    };
  } catch(e) {
    console.warn('[SSE] EventSource not supported');
  }
}

// Quiet fetch (no button animation, no toast)
async function fetchDealsQuiet() {
  try {
    const res = await fetch('/api/deals');
    if (!res.ok) return;
    const data = await res.json();
    const deals = data.deals || [];
    const isFirstLoad = state.seenOfferIds.size === 0;
    const newDeals = deals.filter(d => !state.seenOfferIds.has(d.id));
    deals.forEach(d => state.seenOfferIds.add(d.id));
    saveSeenIds();
    state.deals = deals;
    if (!isFirstLoad && newDeals.length > 0) checkAlerts(newDeals);
    renderDeals();
    updateStats();
  } catch(e) {}
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
    const searchText = [deal.title, deal.subtitle || '', deal.url || '', (deal.categories || []).join(' ')].join(' ').toLowerCase();
    return activeKws.some(kw => searchText.includes(kw));
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
  state.unreadAlerts++;
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

  updateAlertBadge();
  renderAlerts();
  document.getElementById('stat-alerts').textContent = state.alertCount;
}

function clearAlerts() {
  state.alerts = [];
  state.alertCount = 0;
  state.unreadAlerts = 0;
  document.getElementById('stat-alerts').textContent = '0';
  updateAlertBadge();
  // F-29: Stop bell pulse
  document.querySelector('.logo-icon')?.classList.remove('has-alerts');
  clearTimeout(state._bellTimeout);
  renderAlerts();
}

// Update the red badge counter on the bell icon
function updateAlertBadge() {
  const badge = document.getElementById('alert-badge');
  if (!badge) return;
  if (state.unreadAlerts > 0) {
    badge.textContent = state.unreadAlerts > 99 ? '99+' : state.unreadAlerts;
    badge.classList.add('visible');
    // Re-trigger pop animation
    badge.style.animation = 'none';
    badge.offsetHeight; // force reflow
    badge.style.animation = '';
  } else {
    badge.classList.remove('visible');
  }
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
  const skipKeywords = ['hot', 'new', 'ending', 'warehouse', 'favorites', 'electronics', 'computers', 'clearance'].includes(filter);
  if (state.activeKeywords.size > 0 && !skipKeywords) {
    // Only filter when user has explicitly toggled keywords active
    const filterKws = [...state.activeKeywords];
    filtered = filtered.filter(d => {
      const searchText = [d.title, d.subtitle || '', d.url || '', (d.categories || []).join(' ')].join(' ').toLowerCase();
      return filterKws.some(kw => searchText.includes(kw));
    });
  }

  // Search filter (fuzzy multi-token)
  if (search) {
    const tokens = search.split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      filtered = filtered.map(d => {
        const haystack = [d.title, d.subtitle || '', d.primaryCategory || ''].join(' ').toLowerCase();
        let score = 0;
        const matchedTokens = [];
        tokens.forEach(tok => {
          if (haystack.includes(tok)) { score += 2; matchedTokens.push(tok); }
          else {
            // Fuzzy: check each word in haystack for edit distance <= 2
            const words = haystack.split(/\s+/);
            const fuzzy = words.some(w => levenshtein(w, tok) <= 2 && tok.length > 2);
            if (fuzzy) { score += 1; matchedTokens.push(tok); }
          }
        });
        return { deal: d, score, matchedTokens, pct: matchedTokens.length / tokens.length };
      }).filter(r => r.pct >= 0.5)
        .sort((a, b) => b.score - a.score)
        .map(r => { r.deal._matchedTokens = r.matchedTokens; return r.deal; });
    }
  }

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
  } else if (filter === 'electronics') {
    filtered = filtered.filter(d => {
      const cats = (d.categories || []).join(' ').toLowerCase();
      const url = (d.url || '').toLowerCase();
      const mkt = (d.marketingName || '').toLowerCase();
      return cats.includes('electronics') || url.includes('electronics.woot.com')
        || mkt.includes('electronics');
    });
  } else if (filter === 'computers') {
    filtered = filtered.filter(d => {
      const cats = (d.categories || []).join(' ').toLowerCase();
      const url = (d.url || '').toLowerCase();
      const title = (d.title || '').toLowerCase();
      const mkt = (d.marketingName || '').toLowerCase();
      return cats.includes('computer') || cats.includes('laptop') || cats.includes('desktop')
        || url.includes('computers.woot.com')
        || mkt.includes('computer')
        || title.includes('laptop') || title.includes('desktop') || title.includes('notebook');
    });
  } else if (filter === 'clearance') {
    filtered = filtered.filter(d => {
      const url = (d.url || '').toLowerCase();
      const mkt = (d.marketingName || '').toLowerCase();
      const title = (d.title || '').toLowerCase();
      return url.includes('sellout.woot.com') || url.includes('clearance')
        || mkt.includes('clearance') || mkt.includes('sellout')
        || title.includes('clearance');
    });
  }

  // Dynamic tag filter (additional AND filter from tag bar)
  if (state.activeCategories.size > 0) {
    filtered = filtered.filter(d => {
      const tag = getDealTag(d);
      return tag && state.activeCategories.has(tag);
    });
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

  // === VIRTUAL SCROLLING: Batch rendering ===
  const BATCH_SIZE = 40;
  state._filteredDeals = filtered; // Store for batch loading
  state._renderedCount = 0;

  // Clear grid and render first batch
  grid.innerHTML = '';
  renderNextBatch(grid, BATCH_SIZE);

  // Setup IntersectionObserver sentinel for infinite scroll
  setupScrollSentinel(grid);

  // Update dynamic category filter bar
  renderCategoryFilterBar();
}

// Render a single deal card HTML
function renderDealCard(deal, i) {
  const isHot = deal.discount >= 50;
  const endMs = deal._endMs || (deal.endDate ? new Date(deal.endDate).getTime() : null);
  const isEnding = endMs && (endMs - Date.now()) < 4*3600000;
  const hoursLeft = endMs ? Math.max(0, Math.round((endMs - Date.now()) / 3600000)) : null;
  const msLeft = endMs ? Math.max(0, endMs - Date.now()) : null;
  const timeLeftText = hoursLeft !== null ? formatTimeLeft(hoursLeft) : '';
  const catLabel = deal.primaryCategory || '';
  const conditionLabel = deal.condition || '';
  const animClass = !state.hasRenderedOnce ? 'animate-in' : '';

  const condLow = conditionLabel.toLowerCase();
  const condClass = condLow.includes('new') && !condLow.includes('recondition') && !condLow.includes('refurb') ? 'cond-new'
    : condLow.includes('open box') ? 'cond-openbox'
    : condLow.includes('refurb') ? 'cond-refurbished'
    : condLow.includes('recondition') || condLow.includes('factory') ? 'cond-reconditioned'
    : '';

  const catLow = catLabel.toLowerCase();
  const url = (deal.url || '').toLowerCase();
  const catClass = url.includes('electronics.woot.com') || catLow.includes('electronics') ? 'cat-electronics'
    : url.includes('computers.woot.com') || catLow.includes('computer') ? 'cat-computers'
    : url.includes('sellout.woot.com') || catLow.includes('clearance') ? 'cat-clearance'
    : catLow.includes('warehouse') ? 'cat-warehouse'
    : url.includes('home.woot.com') || catLow.includes('home') ? 'cat-home'
    : url.includes('tools.woot.com') || catLow.includes('tools') ? 'cat-tools'
    : url.includes('sport.woot.com') || catLow.includes('sport') ? 'cat-sport'
    : '';

  const timeClass = msLeft === null ? ''
    : msLeft < 3600000 ? 'time-critical'
    : msLeft < 24*3600000 ? 'time-urgent'
    : msLeft < 72*3600000 ? 'time-warning'
    : 'time-safe';

  const dealAge = Date.now() - new Date(deal.startDate).getTime();
  const isNewDeal = state.hasRenderedOnce && dealAge < 120000;

  const priceRange = deal.salePriceMax > deal.salePrice
    ? `$${deal.salePrice.toFixed(2)} – $${deal.salePriceMax.toFixed(2)}`
    : `$${deal.salePrice.toFixed(2)}`;

  const discountTier = deal.discount >= 80 ? 'discount-epic'
    : deal.discount >= 60 ? 'discount-hot'
    : deal.discount >= 40 ? 'discount-good'
    : '';

  return `
  <div class="deal-card ${isHot ? 'hot-deal' : ''} ${discountTier} ${condClass} ${animClass} ${isNewDeal ? 'new-deal-pulse' : ''}" style="${!state.hasRenderedOnce ? 'animation-delay:'+Math.min(i*0.03,0.6)+'s' : ''}">
    <div class="deal-badges">
      ${deal.discount > 0 ? `<span class="badge ${deal.discount >= 60 ? 'badge-hot' : deal.discount >= 40 ? 'badge-discount' : 'badge-mild'}">${deal.discount}% OFF</span>` : ''}
      ${deal.isSoldOut ? '<span class="badge badge-soldout">Sold Out</span>' : ''}
      ${isEnding && !deal.isSoldOut ? '<span class="badge badge-ending">⏰ Ending Soon</span>' : ''}
      ${deal.isWootOff ? '<span class="badge badge-wootoff">⚡ Woot-Off!</span>' : ''}
      ${deal.isFeatured ? '<span class="badge badge-featured">★ Featured</span>' : ''}
    </div>
    <img class="deal-image" src="${deal.photo}" alt="${escHtml(deal.title)}" ${i < 8 ? '' : 'loading="lazy"'} onerror="this.src='https://placehold.co/400x300/1a1a2e/333?text=No+Image'">
    <div class="deal-body">
      <div class="deal-title"><a href="${deal.url}" target="_blank" rel="noopener">${deal._matchedTokens ? highlightMatches(escHtml(deal.title), deal._matchedTokens) : escHtml(deal.title)}</a></div>
      <div class="deal-condition">
        ${conditionLabel ? `<span class="condition-tag ${condClass}">${escHtml(conditionLabel)}</span>` : ''}
        ${catLabel ? `<span class="category-tag ${catClass}">${escHtml(catLabel)}</span>` : ''}
      </div>
      <div class="deal-pricing">
        <span class="deal-sale-price">${priceRange}</span>
        ${deal.listPrice > 0 ? `<span class="deal-list-price">$${deal.listPrice.toFixed(2)}</span>` : ''}
        ${deal.discount > 0 ? `<span class="deal-savings">Save $${(deal.listPrice - deal.salePrice).toFixed(2)}</span>` : ''}
      </div>
      <div class="sparkline-slot" data-deal-id="${deal.id}"></div>
    </div>
    <div class="deal-footer">
      <span class="deal-meta ${timeClass}">${timeLeftText}</span>
      <div class="deal-actions">
        <button class="deal-fav ${state.favorites.has(deal.id) ? 'active' : ''}" data-deal-id="${deal.id}" title="${state.favorites.has(deal.id) ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Toggle favorite">${state.favorites.has(deal.id) ? '💖' : '🤍'}</button>
        ${deal.forumUrl ? `<a href="${deal.forumUrl}" target="_blank" rel="noopener" class="deal-forum" title="Forum Discussion">💬</a>` : ''}
        <a href="${deal.url}" target="_blank" rel="noopener" class="deal-cta" aria-label="View deal: ${escHtml(deal.title)} at ${priceRange}">View Deal →</a>
      </div>
    </div>
  </div>`;
}

// Render next batch of deal cards
function renderNextBatch(grid, count) {
  const deals = state._filteredDeals;
  if (!deals || state._renderedCount >= deals.length) return;

  const start = state._renderedCount;
  const end = Math.min(start + count, deals.length);
  const fragment = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderDealCard(deals[i], i);
    const card = wrapper.firstElementChild;
    // Bind favorite button
    const favBtn = card.querySelector('.deal-fav');
    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(favBtn.dataset.dealId);
      });
    }
    fragment.appendChild(card);
  }

  // Remove old sentinel before appending
  const oldSentinel = grid.querySelector('.scroll-sentinel');
  if (oldSentinel) oldSentinel.remove();

  grid.appendChild(fragment);
  state._renderedCount = end;

  // Lazy-load sparklines for this batch
  const batchIds = deals.slice(start, end).map(d => d.id);
  if (batchIds.length > 0) fetchSparklines(batchIds);
}

// IntersectionObserver sentinel for infinite scroll
let _scrollObserver = null;
function setupScrollSentinel(grid) {
  // Cleanup previous observer
  if (_scrollObserver) _scrollObserver.disconnect();

  const deals = state._filteredDeals;
  if (!deals || state._renderedCount >= deals.length) return;

  // Create sentinel element
  const sentinel = document.createElement('div');
  sentinel.className = 'scroll-sentinel';
  sentinel.innerHTML = `<div class="scroll-sentinel-inner">
    <div class="sentinel-spinner"></div>
    <span>Loading more deals… (${state._renderedCount}/${deals.length})</span>
  </div>`;
  grid.appendChild(sentinel);

  _scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state._renderedCount < deals.length) {
      renderNextBatch(grid, 40);
      // Update or re-create sentinel
      setupScrollSentinel(grid);
    }
  }, { rootMargin: '400px' });

  _scrollObserver.observe(sentinel);
}


function toggleFavorite(dealId) {
  if (state.favorites.has(dealId)) {
    state.favorites.delete(dealId);
    fetch(`/api/favorites/${encodeURIComponent(dealId)}`, { method: 'DELETE' }).catch(() => {});
    showToast('Removed from favorites', 'info');
  } else {
    state.favorites.add(dealId);
    fetch('/api/favorites', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: dealId}) }).catch(() => {});
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
  el.className = 'status-indicator' + (s === 'active' ? ' active' : s === 'error' ? ' error' : s === 'ratelimited' ? ' ratelimited' : '');
  if (s === 'active') {
    txt.textContent = state.scannerActive ? '🔴 Live' : 'Connecting...';
  } else if (s === 'scanning') {
    txt.textContent = 'Scanning...';
  } else if (s === 'ratelimited') {
    txt.textContent = '⚠️ Rate Limited';
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

// Highlight matched search tokens in already-escaped text
function highlightMatches(escapedText, tokens) {
  if (!tokens || tokens.length === 0) return escapedText;
  // Sort by length desc to match longest tokens first
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  return escapedText.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function formatTimeLeft(hours) {
  if (hours > 48) return Math.round(hours / 24) + 'd left';
  if (hours > 1) return hours + 'h left';
  if (hours === 1) return '1h left';
  return '⚡ <1h left';
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

// ===== FUZZY SEARCH (Levenshtein distance) =====
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i-1] === a[j-1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i-1][j]+1, matrix[i][j-1]+1, matrix[i-1][j-1]+cost);
    }
  }
  return matrix[b.length][a.length];
}

// ===== SPARKLINE RENDERING =====
function renderSparkline(points) {
  if (!points || points.length < 2) return '';
  const prices = points.map(p => p.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 80, h = 28, pad = 2;
  const coords = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (p - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = prices[prices.length - 1];
  const first = prices[0];
  const color = last <= first ? 'var(--success)' : 'var(--danger)';
  const areaCoords = coords.join(' ') + ` ${w-pad},${h} ${pad},${h}`;
  return `<svg class="deal-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${areaCoords}" fill="${color}" opacity="0.15"/>
    <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${coords[coords.length-1].split(',')[0]}" cy="${coords[coords.length-1].split(',')[1]}" r="2" fill="${color}"/>
  </svg><span class="sparkline-labels"><span>$${min.toFixed(0)}</span><span>$${max.toFixed(0)}</span></span>`;
}

// Fetch sparklines for visible deals
let _sparklineCache = {};
async function fetchSparklines(dealIds) {
  const uncached = dealIds.filter(id => !_sparklineCache[id]);
  if (uncached.length === 0) return;
  try {
    const res = await fetch(`/api/price-history?ids=${uncached.slice(0, 30).join(',')}`);
    if (!res.ok) return;
    const data = await res.json();
    Object.assign(_sparklineCache, data);
    // Inject sparklines into rendered cards
    uncached.forEach(id => {
      const el = document.querySelector(`.sparkline-slot[data-deal-id="${id}"]`);
      if (el && _sparklineCache[id] && _sparklineCache[id].length >= 2) {
        el.innerHTML = renderSparkline(_sparklineCache[id]);
      }
    });
  } catch(e) {}
}
