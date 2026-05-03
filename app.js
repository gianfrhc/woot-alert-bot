// ===== WOOT ALERT BOT — LIVE API =====
const WOOT_API = 'https://developer.woot.com';
const FEED_NAMES = ['All', 'Electronics', 'Computers', 'Home', 'Tools', 'Sports', 'Wootoff', 'Featured', 'Clearance', 'Shirts', 'Gourmet'];

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
  favorites: new Set()
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
        Object.assign(state.settings, serverSettings);
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
  document.getElementById('ntfy-quiet-group').style.display = ntfyVisible;
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

  ['toggle-sound','toggle-notifications','toggle-ntfy','toggle-discord'].forEach(id => {
    const el = document.getElementById(id);
    const toggle = () => {
      el.classList.toggle('active');
      el.setAttribute('aria-checked', el.classList.contains('active'));
      // Show/hide ntfy sub-settings when ntfy toggle changes
      if (id === 'toggle-ntfy') {
        const vis = el.classList.contains('active') ? '' : 'none';
        document.getElementById('ntfy-settings-group').style.display = vis;
        document.getElementById('ntfy-discount-group').style.display = vis;
        document.getElementById('ntfy-quiet-group').style.display = vis;
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
    if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
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
  state.settings = { minDiscount:30, minPrice:0, maxPrice:300, refreshInterval:300, categories:['All'], keywordButtons:[], soundEnabled:false, notificationsEnabled:true, ntfyEnabled:false, ntfyTopic:'', ntfyMinDiscount:40, quietStart:'', quietEnd:'', discordEnabled:false, discordWebhook:'', apiKey:'' };
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

// ===== SCANNING =====
async function scanDeals() {
  if (state.isScanning) return;
  // Cooldown: 30s between scans
  const now = Date.now();
  if (now - state.lastScanTime < 30000 && state.lastScanTime > 0) {
    const wait = Math.ceil((30000 - (now - state.lastScanTime)) / 1000);
    showToast(`Please wait ${wait}s before scanning again`, 'info');
    return;
  }
  state.isScanning = true;
  state.lastScanTime = now;
  updateStatus('scanning');
  showLoading(true);

  // Scan button feedback
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('scanning');
  btn.querySelector('span').textContent = 'Scanning...';

  const scanStart = Date.now();

  try {
    let deals = [];
    if (state.settings.apiKey) {
      deals = await fetchFromAPI();
    }
    if (deals.length === 0 && !state.settings.apiKey) {
      showToast('No API key configured — go to Settings to add your Woot API key', 'info');
      updateStatus('error');
      btn.classList.remove('scanning');
      btn.querySelector('span').textContent = 'Scan Now';
      state.isScanning = false;
      showLoading(false);
      return;
    } else if (deals.length === 0 && state.settings.apiKey) {
      showToast('API returned 0 deals — check your API key or try again', 'info');
    }

    const isFirstScan = state.seenOfferIds.size === 0;
    const newDeals = deals.filter(d => !state.seenOfferIds.has(d.id));
    deals.forEach(d => state.seenOfferIds.add(d.id));
    saveSeenIds();

    state.deals = deals;
    state.totalDealsAllTime += newDeals.length;

    if (!isFirstScan) checkAlerts(newDeals);
    state.hasRenderedOnce = false; // Allow animation on fresh scan
    renderDeals();
    state.hasRenderedOnce = true;
    updateStats();
    updateStatus('active');

    const scanDuration = ((Date.now() - scanStart) / 1000).toFixed(1);
    document.getElementById('stat-last-scan').textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

    state.scanHistory.unshift({ time: new Date(), count: deals.length, newCount: newDeals.length, duration: scanDuration });
    if (state.scanHistory.length > 50) state.scanHistory.pop();

    const sourceTxt = state.settings.apiKey ? '🔴 LIVE' : '🎭 Demo';
    showToast(`${sourceTxt} — ${deals.length} deals (${newDeals.length} new) in ${scanDuration}s`, 'success');

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

async function fetchFromAPI() {
  const selectedCats = state.settings.categories;
  // If "All" is selected, just fetch "All" feed; otherwise fetch each selected category
  const feedsToFetch = selectedCats.includes('All') ? ['All'] : selectedCats;

  let allDeals = [];

  // Fetch feeds in parallel for speed
  const promises = feedsToFetch.map(async (cat) => {
    try {
      const res = await fetch(`${WOOT_API}/feed/${cat}`, {
        headers: {
          'Accept': 'application/json',
          'x-api-key': state.settings.apiKey
        }
      });
      if (!res.ok) {
        if (res.status === 403) throw new Error('Invalid API Key (403 Forbidden)');
        console.warn(`API ${cat} returned ${res.status}`);
        return [];
      }
      // Robust JSON parsing — some feeds may return malformed JSON
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.warn(`API ${cat}: JSON parse failed, trying to clean response...`, parseErr.message);
        // Try stripping BOM or non-printable chars
        const cleaned = text.replace(/^\xEF\xBB\xBF/, '').trim();
        try {
          data = JSON.parse(cleaned);
        } catch(e2) {
          console.warn(`API ${cat}: Could not parse response (${text.length} chars)`);
          return [];
        }
      }
      if (data.Items && Array.isArray(data.Items)) {
        return data.Items.map(item => normalizeAPIItem(item, data.MarketingName || cat));
      }
    } catch(e) {
      console.warn(`API fetch ${cat} failed:`, e);
      // Don't throw — let other feeds succeed
    }
    return [];
  });

  const results = await Promise.allSettled(promises);
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value) allDeals.push(...r.value);
  });

  // Check if ALL failed
  const allFailed = results.every(r => r.status === 'rejected');
  if (allFailed && results.length > 0) {
    throw results[0].reason;
  }

  return dedupeDeals(allDeals);
}

function normalizeAPIItem(item, marketingName) {
  const sp = item.SalePrice || {};
  const lp = item.ListPrice || {};
  const saleMin = sp.Minimum || 0;
  const saleMax = sp.Maximum || saleMin;
  const listMin = lp.Minimum || 0;
  const listMax = lp.Maximum || listMin;
  const discount = listMin > 0 ? Math.round((1 - saleMin / listMin) * 100) : 0;

  // Derive clean category from the Categories array
  const cats = item.Categories || [];
  const primaryCat = cats.length > 0 ? cats[0] : (marketingName || 'Other');

  return {
    id: item.OfferId,
    title: item.Title || 'Untitled',
    subtitle: item.Subtitle || '',
    url: item.Url || 'https://www.woot.com',
    photo: item.Photo || '',
    salePrice: saleMin,
    salePriceMax: saleMax,
    listPrice: listMin,
    listPriceMax: listMax,
    discount: discount,
    condition: item.Condition || null,
    categories: cats,
    primaryCategory: primaryCat,
    marketingName: marketingName,
    isSoldOut: item.IsSoldOut || false,
    isFeatured: item.IsFeatured || false,
    isWootOff: item.IsWootOff || false,
    isFulfilledByAmazon: item.IsFulfilledByAmazon || false,
    startDate: item.StartDate,
    endDate: item.EndDate,
    _endMs: item.EndDate ? new Date(item.EndDate).getTime() : null,
    forumUrl: item.ForumUrl || null
  };
}

function dedupeDeals(deals) {
  const seen = new Set();
  return deals.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

// ===== DEMO DATA =====
function generateDemoDeals() {
  const products = [
    { title:'Samsung 65" 4K Smart TV QLED', sale:449.99, list:799.99, cat:'ELECTRONICS', img:'https://placehold.co/400x300/1a1a2e/6366f1?text=Samsung+TV' },
    { title:'Apple AirPods Pro (2nd Gen) USB-C', sale:189.99, list:249.99, cat:'ELECTRONICS', img:'https://placehold.co/400x300/1a1a2e/10b981?text=AirPods+Pro' },
    { title:'Dyson V15 Detect Cordless Vacuum', sale:399.99, list:749.99, cat:'HOME', img:'https://placehold.co/400x300/1a1a2e/f59e0b?text=Dyson+V15' },
    { title:'ASUS ROG Strix Gaming Laptop RTX 4060', sale:899.99, list:1399.99, cat:'COMPUTERS', img:'https://placehold.co/400x300/1a1a2e/ef4444?text=ASUS+ROG' },
    { title:'Sony WH-1000XM5 Noise Cancelling Headphones', sale:248.00, list:399.99, cat:'ELECTRONICS', img:'https://placehold.co/400x300/1a1a2e/a855f7?text=Sony+XM5' },
    { title:'Ninja Foodi 10-in-1 XL Pro Air Fry Oven', sale:149.99, list:299.99, cat:'HOME', img:'https://placehold.co/400x300/1a1a2e/f97316?text=Ninja+Foodi' },
    { title:'DeWalt 20V MAX Drill/Driver Combo Kit', sale:129.99, list:249.99, cat:'TOOLS', img:'https://placehold.co/400x300/1a1a2e/eab308?text=DeWalt+Kit' },
    { title:'Kindle Paperwhite 16GB (2024)', sale:94.99, list:149.99, cat:'ELECTRONICS', img:'https://placehold.co/400x300/1a1a2e/6366f1?text=Kindle' },
  ];
  
  return products.map((p, i) => {
    const discount = Math.round((1 - p.sale / p.list) * 100);
    const hoursAgo = Math.floor(Math.random() * 24);
    const start = new Date(Date.now() - hoursAgo * 3600000);
    const end = new Date(Date.now() + (24 - hoursAgo) * 3600000);
    return {
      id: 'demo-' + i + '-' + Date.now(),
      title: p.title,
      subtitle: '',
      url: 'https://www.woot.com',
      photo: p.img,
      salePrice: p.sale,
      salePriceMax: p.sale,
      listPrice: p.list,
      listPriceMax: p.list,
      discount,
      condition: Math.random() > 0.3 ? 'New' : 'Refurbished',
      categories: [p.cat],
      primaryCategory: p.cat,
      marketingName: p.cat,
      isSoldOut: false,
      isFeatured: Math.random() > 0.7,
      isWootOff: false,
      isFulfilledByAmazon: false,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      forumUrl: null
    };
  });
}

// ===== ALERTS =====
function checkAlerts(newDeals) {
  const s = state.settings;
  // Use ACTIVE (selected) keywords for filtering — not all keyword buttons
  const activeKws = [...state.activeKeywords];

  // Helper: check if deal matches active keywords (OR logic)
  function matchesKeywords(deal) {
    if (activeKws.length === 0) return true; // No keywords active = match all
    const titleLow = deal.title.toLowerCase();
    const subtitleLow = (deal.subtitle || '').toLowerCase();
    return activeKws.some(kw => titleLow.includes(kw) || subtitleLow.includes(kw));
  }

  newDeals.forEach(deal => {
    // === General alerts (sound, desktop notification, alert feed) ===
    let triggered = false;
    if (deal.discount >= s.minDiscount && deal.salePrice >= s.minPrice && deal.salePrice <= s.maxPrice && !deal.isSoldOut) {
      triggered = true;
    }
    if (triggered && !matchesKeywords(deal)) triggered = false;
    if (triggered) addAlert(deal);

    // === ntfy.sh — Independent evaluation ===
    // Keyword match → always notify (even 0% discount)
    // No keywords active → use ntfyMinDiscount threshold
    // Respects quiet hours
    if (s.ntfyEnabled && s.ntfyTopic && !deal.isSoldOut && !isQuietHours()) {
      const hasActiveKws = activeKws.length > 0;
      const kwMatch = hasActiveKws && matchesKeywords(deal);
      if (kwMatch) {
        // Keyword matched → notify regardless of discount
        sendNtfyNotification(deal);
      } else if (!hasActiveKws && deal.discount >= s.ntfyMinDiscount) {
        // No keywords active → use discount threshold
        sendNtfyNotification(deal);
      }
    }

    // === Discord Webhook — Mirrors ntfy.sh logic ===
    if (s.discordEnabled && s.discordWebhook && !deal.isSoldOut && !isQuietHours()) {
      const hasActiveKws = activeKws.length > 0;
      const kwMatch = hasActiveKws && matchesKeywords(deal);
      if (kwMatch || (!hasActiveKws && deal.discount >= s.ntfyMinDiscount)) {
        sendDiscordNotification(deal);
      }
    }
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

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
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

async function sendNtfyNotification(deal) {
  const topic = state.settings.ntfyTopic;
  if (!topic) return;
  const logEntry = {
    time: new Date().toISOString(),
    title: deal.title,
    price: deal.salePrice,
    discount: deal.discount,
    url: deal.url,
    topic: topic,
    status: 'success',
    error: null
  };
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Title': `${deal.title} - $${deal.salePrice.toFixed(2)}`,
        'Tags': 'moneybag,fire',
        'Priority': deal.discount >= 60 ? '5' : '4',
        'Click': deal.url
      },
      body: `Precio: $${deal.salePrice.toFixed(2)} Antes $${deal.listPrice.toFixed(2)}${deal.discount > 0 ? ` (${deal.discount}% OFF)` : ''}\n${deal.url}`
    });
    if (!res.ok) {
      logEntry.status = 'error';
      logEntry.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    console.warn('ntfy.sh send failed:', err);
    logEntry.status = 'error';
    logEntry.error = err.message || 'Network error';
  }
  // Save log to server (fire-and-forget)
  fetch('/api/ntfy-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(logEntry)
  }).catch(() => {});
}

// ===== DISCORD WEBHOOK =====
async function sendDiscordNotification(deal) {
  const url = state.settings.discordWebhook;
  if (!url) return;
  const embed = {
    title: deal.title,
    url: deal.url,
    color: deal.discount >= 60 ? 0xef4444 : deal.discount >= 40 ? 0xf59e0b : 0x6366f1,
    fields: [
      { name: '💰 Price', value: `**$${deal.salePrice.toFixed(2)}**${deal.listPrice > 0 ? ` ~~$${deal.listPrice.toFixed(2)}~~` : ''}`, inline: true },
      { name: '🔥 Discount', value: `**${deal.discount}% OFF**`, inline: true },
      { name: '📦 Condition', value: deal.condition || 'N/A', inline: true }
    ],
    thumbnail: deal.photo ? { url: deal.photo } : undefined,
    footer: { text: `Woot Alert Bot • ${deal.primaryCategory || 'Deal'}` },
    timestamp: new Date().toISOString()
  };
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Woot Bot',
        avatar_url: 'https://d3gqasl9vmjfd8.cloudfront.net/assets/woot_logo.png',
        embeds: [embed]
      })
    });
  } catch (e) {
    console.warn('Discord send failed:', e);
  }
}

// ===== RENDER =====
function renderDeals() {
  const grid = document.getElementById('deals-grid');
  const search = document.getElementById('search-input').value.toLowerCase();
  const sort = document.getElementById('sort-select').value;
  const filter = document.querySelector('.filter-chip.active')?.dataset.filter || 'all';

  let filtered = [...state.deals];

  // Hide sold out deals
  filtered = filtered.filter(d => !d.isSoldOut);

  // Keyword button filter (OR logic) — only applies on 'all' and 'great' views
  // When using specific filters (hot, new, ending, warehouse, favorites),
  // show ALL matching deals regardless of keywords
  const skipKeywords = ['hot', 'new', 'ending', 'warehouse', 'favorites'].includes(filter);
  if (state.activeKeywords.size > 0 && !skipKeywords) {
    const activeKws = [...state.activeKeywords];
    filtered = filtered.filter(d => {
      const titleLow = d.title.toLowerCase();
      const subtitleLow = (d.subtitle || '').toLowerCase();
      return activeKws.some(kw => titleLow.includes(kw) || subtitleLow.includes(kw));
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
    txt.textContent = state.settings.apiKey ? '🔴 Live' : 'Demo Mode';
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
  const interval = state.settings.refreshInterval;
  if (interval <= 0) {
    document.getElementById('scan-timer').style.display = 'none';
    return;
  }
  document.getElementById('scan-timer').style.display = '';
  state.countdown = interval;
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

function resetCountdown() { state.countdown = state.settings.refreshInterval; }

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

// ===== QUIET HOURS =====
function isQuietHours() {
  const s = state.settings;
  if (!s.quietStart || !s.quietEnd) return false;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const current = h * 60 + m;
  const [sh, sm] = s.quietStart.split(':').map(Number);
  const [eh, em] = s.quietEnd.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  // Handle overnight range (e.g., 23:00 - 07:00)
  if (start <= end) {
    return current >= start && current < end;
  } else {
    return current >= start || current < end;
  }
}
