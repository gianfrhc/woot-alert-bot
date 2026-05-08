// ===== WOOT ALERT BOT — Node.js Server with Auth (Hardened) =====
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');
const NTFY_LOGS_FILE = path.join(__dirname, 'ntfy-logs.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SEEN_IDS_FILE = path.join(__dirname, 'seen-ids.json');
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// ===== SAFE FILE WRITES (DATA-01) =====
function atomicWriteJSON(filepath, data) {
  const json = JSON.stringify(data, null, 2);
  try {
    // Try atomic write-then-rename (safest on native filesystems)
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, filepath);
  } catch (e) {
    // Fallback: direct write (Docker bind mounts block rename with EBUSY)
    fs.writeFileSync(filepath, json, 'utf8');
  }
}

// ===== AUTH CONFIG (SEC-03: scrypt with random salt) =====
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      // Migrate plaintext password to scrypt hash
      if (auth.password && !auth.hash) {
        auth.hash = hashPasswordSync(auth.password);
        delete auth.password;
        atomicWriteJSON(AUTH_FILE, auth);
        console.log('  🔐 Password migrated to scrypt hash');
      }
      // Migrate old SHA-256 hash to scrypt (64 hex chars = SHA-256)
      if (auth.hash && !auth.hash.includes(':')) {
        console.log('  🔐 Old SHA-256 hash detected — will auto-migrate on next login');
        auth._legacySha256 = auth.hash;
      }
      if (auth.hash) return auth;
    }
  } catch (e) { console.error('[Auth] Load error:', e.message); }

  // First run: generate random password
  const password = crypto.randomBytes(4).toString('hex');
  const auth = { hash: hashPasswordSync(password) };
  atomicWriteJSON(AUTH_FILE, auth);
  console.log(`\n  🔑 First run — generated password: ${password}`);
  console.log(`  📁 Saved to: ${AUTH_FILE}`);
  console.log(`  ⚠️  This password is shown ONLY ONCE. It's stored as a scrypt hash.\n`);
  return auth;
}

// SEC-03: scrypt with random 16-byte salt (format: salt_hex:hash_hex)
function hashPasswordSync(pwd) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pwd, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// Legacy SHA-256 check (for migration)
function legacySha256(pwd) {
  return crypto.createHash('sha256').update(pwd + 'woot-salt-2026').digest('hex');
}

function verifyPassword(input, auth) {
  // New scrypt format: salt_hex:hash_hex
  if (auth.hash && auth.hash.includes(':')) {
    const [saltHex, hashHex] = auth.hash.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const storedHash = Buffer.from(hashHex, 'hex');
    const inputHash = crypto.scryptSync(input, salt, 64);
    return crypto.timingSafeEqual(inputHash, storedHash);
  }
  // Legacy SHA-256 migration path
  if (auth._legacySha256) {
    const inputHash = legacySha256(input);
    if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(auth._legacySha256))) {
      // Auto-migrate to scrypt on successful login
      auth.hash = hashPasswordSync(input);
      delete auth._legacySha256;
      atomicWriteJSON(AUTH_FILE, { hash: auth.hash });
      console.log('  🔐 Password auto-migrated from SHA-256 to scrypt');
      return true;
    }
    return false;
  }
  // Legacy plaintext fallback
  if (auth.hash) {
    const inputHash = legacySha256(input);
    return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(auth.hash));
  }
  return input === auth.password;
}

const authConfig = loadAuth();

// ===== SESSIONS (persistent) =====
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
let sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      // Only load non-expired sessions
      Object.entries(data).forEach(([token, expiry]) => {
        if (expiry > now) sessions.set(token, expiry);
      });
      console.log(`  📋 Restored ${sessions.size} active sessions`);
    }
  } catch (e) { console.error('[Sessions] Load error:', e.message); }
}

function saveSessions() {
  const obj = {};
  sessions.forEach((expiry, token) => { obj[token] = expiry; });
  try { atomicWriteJSON(SESSIONS_FILE, obj); } catch (e) { console.error('[Sessions] Save error:', e.message); }
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_DURATION);
  saveSessions();
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) {
    sessions.delete(token);
    saveSessions();
    return false;
  }
  return true;
}

loadSessions();

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, expiry] of sessions) {
    if (now > expiry) { sessions.delete(token); cleaned++; }
  }
  if (cleaned > 0) saveSessions();
}, 3600000);

// ===== RATE LIMITING =====
const loginAttempts = new Map(); // IP -> { count, firstAttempt }
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 5; // max attempts per window

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || (now - record.firstAttempt) > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return true; // allowed
  }
  if (record.count >= RATE_LIMIT_MAX) {
    const waitSec = Math.ceil((RATE_LIMIT_WINDOW - (now - record.firstAttempt)) / 1000);
    return waitSec; // blocked, return seconds to wait
  }
  record.count++;
  return true; // allowed
}

// Clean rate limit records every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if ((now - record.firstAttempt) > RATE_LIMIT_WINDOW) loginAttempts.delete(ip);
  }
}, 1800000);

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key] = val.join('=');
  });
  return cookies;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

// MIME types
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.webp': 'image/webp'
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) { console.error('[Settings] Load error:', e.message); }
  return null;
}

// DATA-03: Basic schema validation for settings
const SETTINGS_SCHEMA = {
  minDiscount: 'number', minPrice: 'number', maxPrice: 'number',
  refreshInterval: 'number', ntfyMinDiscount: 'number',
  categories: 'array', keywordButtons: 'array', blockedWords: 'array',
  activeKeywords: 'array',
  soundEnabled: 'boolean', notificationsEnabled: 'boolean',
  ntfyEnabled: 'boolean', discordEnabled: 'boolean',
  ntfyAllowOpenBox: 'boolean', ntfyAllowRefurbished: 'boolean',
  ntfyTopic: 'string', quietStart: 'string', quietEnd: 'string',
  discordWebhook: 'string', apiKey: 'string'
};

function validateSettings(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'Settings must be a JSON object';
  }
  for (const [key, expectedType] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(key in data)) continue; // optional fields
    const val = data[key];
    if (expectedType === 'array') {
      if (!Array.isArray(val)) return `${key} must be an array`;
    } else if (typeof val !== expectedType) {
      return `${key} must be a ${expectedType}, got ${typeof val}`;
    }
  }
  // Range validation
  if (data.minDiscount != null && (data.minDiscount < 0 || data.minDiscount > 100)) return 'minDiscount must be 0-100';
  if (data.maxPrice != null && data.maxPrice < 0) return 'maxPrice cannot be negative';
  if (data.refreshInterval != null && data.refreshInterval < 60) return 'refreshInterval minimum is 60s';
  if (data.ntfyMinDiscount != null && (data.ntfyMinDiscount < 0 || data.ntfyMinDiscount > 100)) return 'ntfyMinDiscount must be 0-100';
  return null; // valid
}

function saveSettingsFile(data) {
  atomicWriteJSON(SETTINGS_FILE, data);
}

function loadNtfyLogs() {
  try {
    if (fs.existsSync(NTFY_LOGS_FILE)) return JSON.parse(fs.readFileSync(NTFY_LOGS_FILE, 'utf8'));
  } catch (e) { console.error('[NtfyLogs] Load error:', e.message); }
  return [];
}

function saveNtfyLogs(logs) {
  const trimmed = logs.slice(0, 500);
  atomicWriteJSON(NTFY_LOGS_FILE, trimmed);
}

// DATA-02: seenOfferIds sync
function loadSeenIds() {
  try {
    // MED-04: Check if file is actually a directory (Docker bind mount bug)
    if (fs.existsSync(SEEN_IDS_FILE)) {
      const stat = fs.statSync(SEEN_IDS_FILE);
      if (stat.isDirectory()) {
        console.warn('[SeenIds] seen-ids.json is a directory — removing and recreating as file');
        fs.rmdirSync(SEEN_IDS_FILE, { recursive: true });
        fs.writeFileSync(SEEN_IDS_FILE, '[]', 'utf8');
        return [];
      }
      return JSON.parse(fs.readFileSync(SEEN_IDS_FILE, 'utf8'));
    }
  } catch (e) { console.error('[SeenIds] Load error:', e.message); }
  return [];
}

function saveSeenIds(ids) {
  const trimmed = Array.isArray(ids) ? ids.slice(-5000) : [];
  atomicWriteJSON(SEEN_IDS_FILE, trimmed);
}

// Body reader with size limit
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ===== SERVER =====
const server = http.createServer(async (req, res) => {
  // ARCH-03: Removed partial CORS headers — all requests are same-origin

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const cookies = parseCookies(req.headers.cookie);
  const isAuthenticated = isValidSession(cookies.session);
  const urlPath = req.url.split('?')[0];
  const clientIP = getClientIP(req);

  // === PUBLIC: Login page ===
  if (urlPath === '/login' || urlPath === '/login.html') {
    if (isAuthenticated) {
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }
    const loginHtml = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(loginHtml);
    return;
  }

  // === PUBLIC: Login API (rate limited) ===
  if (req.method === 'POST' && urlPath === '/api/login') {
    const rateCheck = checkRateLimit(clientIP);
    if (rateCheck !== true) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Too many attempts. Try again in ${rateCheck}s` }));
      console.log(`[${new Date().toLocaleTimeString()}] ⛔ Rate limited: ${clientIP}`);
      return;
    }
    try {
      const body = await readBody(req);
      const { password } = JSON.parse(body);
      const currentAuth = loadAuth();
      if (verifyPassword(password, currentAuth)) {
        const token = createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION / 1000}; SameSite=Strict`
        });
        res.end(JSON.stringify({ ok: true }));
        // Reset rate limit on success
        loginAttempts.delete(clientIP);
        console.log(`[${new Date().toLocaleTimeString()}] ✅ Login successful (${clientIP})`);
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid password' }));
        console.log(`[${new Date().toLocaleTimeString()}] ❌ Login failed (${clientIP})`);
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
    }
    return;
  }

  // === PUBLIC: Logout ===
  if (urlPath === '/logout') {
    if (cookies.session) { sessions.delete(cookies.session); saveSessions(); }
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0'
    });
    res.end();
    return;
  }

  // ===== AUTH WALL =====
  if (!isAuthenticated) {
    if (urlPath.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  // === PROTECTED: Settings API ===
  // HIGH-04: Mask API key in response
  if (req.method === 'GET' && urlPath === '/api/settings') {
    const settings = loadSettings() || {};
    const safe = { ...settings };
    if (safe.apiKey) safe.apiKey = safe.apiKey.substring(0, 8) + '••••••••';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/settings') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      // DATA-03: Validate before saving
      const validationError = validateSettings(data);
      if (validationError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: validationError }));
        return;
      }
      // HIGH-04: If frontend sends masked API key, preserve the real one from disk
      if (data.apiKey && data.apiKey.includes('•')) {
        const currentSettings = loadSettings() || {};
        data.apiKey = currentSettings.apiKey || '';
      }
      saveSettingsFile(data);
      // Restart scanner with new settings (interval, keywords, categories may have changed)
      if (typeof scannerStart === 'function') scannerStart();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      console.log(`[${new Date().toLocaleTimeString()}] Settings saved (${data.keywordButtons?.length || 0} keywords) — scanner restarted`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Invalid JSON' }));
    }
    return;
  }

  // === PROTECTED: ntfy Logs API ===
  if (req.method === 'GET' && urlPath === '/api/ntfy-logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadNtfyLogs()));
    return;
  }

  // HIGH-01: Validate ntfy-log entry schema
  if (req.method === 'POST' && urlPath === '/api/ntfy-logs') {
    try {
      const body = await readBody(req);
      const entry = JSON.parse(body);
      // Validate required fields and sanitize
      const sanitized = {
        time: typeof entry.time === 'string' ? entry.time.substring(0, 50) : new Date().toISOString(),
        title: typeof entry.title === 'string' ? entry.title.substring(0, 300) : 'Unknown',
        price: typeof entry.price === 'number' ? entry.price : 0,
        discount: typeof entry.discount === 'number' ? entry.discount : 0,
        url: typeof entry.url === 'string' ? entry.url.substring(0, 500) : '',
        topic: typeof entry.topic === 'string' ? entry.topic.substring(0, 100) : '',
        status: ['success', 'error'].includes(entry.status) ? entry.status : 'unknown',
        error: typeof entry.error === 'string' ? entry.error.substring(0, 200) : null
      };
      const logs = loadNtfyLogs();
      logs.unshift(sanitized);
      saveNtfyLogs(logs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  if (req.method === 'DELETE' && urlPath === '/api/ntfy-logs') {
    saveNtfyLogs([]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // === PROTECTED: seenOfferIds API (DATA-02) ===
  if (req.method === 'GET' && urlPath === '/api/seen-ids') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadSeenIds()));
    return;
  }

  // CRIT-01: Merge frontend IDs into server's in-memory Set (don't replace)
  if (req.method === 'POST' && urlPath === '/api/seen-ids') {
    try {
      const body = await readBody(req);
      const ids = JSON.parse(body);
      if (!Array.isArray(ids)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected an array of IDs' }));
        return;
      }
      // Merge into scanner's in-memory Set (server is source of truth)
      let merged = 0;
      ids.forEach(id => {
        if (typeof id === 'string' && id.length < 200 && !scanner.seenIds.has(id)) {
          scanner.seenIds.add(id);
          merged++;
        }
      });
      if (merged > 0) scannerPersistSeenIds();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, merged }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // === PROTECTED: Server-scanned deals ===
  if (req.method === 'GET' && urlPath === '/api/deals') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      deals: scanner.currentDeals,
      lastScan: scanner.lastScanTime ? new Date(scanner.lastScanTime).toISOString() : null,
      scanCount: scanner.scanCount,
      isScanning: scanner.isScanning,
      totalNotified: scanner.totalNotified
    }));
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/scan-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      lastScan: scanner.lastScanTime ? new Date(scanner.lastScanTime).toISOString() : null,
      scanCount: scanner.scanCount,
      isScanning: scanner.isScanning,
      lastError: scanner.lastError,
      dealsCount: scanner.currentDeals.length,
      intervalSec: scanner.intervalSec,
      totalNotified: scanner.totalNotified,
      nextScanIn: scanner.intervalSec - Math.floor((Date.now() - (scanner.lastScanTime || 0)) / 1000)
    }));
    return;
  }

  // === PROTECTED: Force scan now ===
  if (req.method === 'POST' && urlPath === '/api/scan') {
    if (scanner.isScanning) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scan already in progress' }));
      return;
    }
    // Run scan async, respond immediately
    scannerDoScan().catch(e => console.error('[Scanner] Manual scan error:', e));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Scan started' }));
    return;
  }

  // === PROTECTED: Static files (MUST be last route) ===
  // HIGH-03: Path traversal fix using path.resolve
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const basename = path.basename(filePath);
  const blocked = ['auth.json', 'settings.json', 'ntfy-logs.json', 'sessions.json', 'seen-ids.json', 'server.js', 'rpi_update.py', 'rpi_check.py'];
  if (blocked.includes(basename)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const resolvedPath = path.resolve(__dirname, '.' + filePath);
  if (!resolvedPath.startsWith(__dirname + path.sep) && resolvedPath !== __dirname) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(resolvedPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ===== SERVER-SIDE WOOT SCANNER =====
const WOOT_API_BASE = 'https://developer.woot.com';
const FEED_NAMES = ['All', 'Electronics', 'Computers', 'Home', 'Tools', 'Sports', 'Wootoff', 'Featured', 'Clearance', 'Shirts', 'Gourmet'];

const scanner = {
  currentDeals: [],
  seenIds: new Set(),     // In-memory seen IDs (loaded from disk once on boot)
  isScanning: false,
  lastScanTime: 0,
  scanCount: 0,
  lastError: null,
  intervalSec: 120,
  timer: null,
  isFirstScan: true,
  totalNotified: 0
};

// Load seen IDs from disk into memory (called once on boot)
function scannerInitSeenIds() {
  const diskIds = loadSeenIds();
  diskIds.forEach(id => scanner.seenIds.add(id));
  console.log(`  📋 Loaded ${scanner.seenIds.size} seen IDs from disk`);
}

// CRIT-03: Debounced persist — writes at most every 60s instead of every scan
let _persistTimer = null;
function scannerPersistSeenIds() {
  if (_persistTimer) return; // Already scheduled
  _persistTimer = setTimeout(() => {
    // HIGH-02: Cap in-memory Set to prevent memory leak
    if (scanner.seenIds.size > 10000) {
      const arr = [...scanner.seenIds].slice(-5000);
      scanner.seenIds = new Set(arr);
    }
    const arr = [...scanner.seenIds].slice(-5000);
    saveSeenIds(arr);
    _persistTimer = null;
  }, 60000); // Write at most once per minute
}

// Force immediate persist (for shutdown/settings save)
function scannerPersistSeenIdsNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (scanner.seenIds.size > 10000) {
    const arr = [...scanner.seenIds].slice(-5000);
    scanner.seenIds = new Set(arr);
  }
  const arr = [...scanner.seenIds].slice(-5000);
  saveSeenIds(arr);
}

// MED-02: HTTP fetch with 15s timeout (prevents scanner hang)
async function fetchJSON(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      if (res.status === 403) throw new Error('Invalid API Key (403 Forbidden)');
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      // Try stripping BOM
      const cleaned = text.replace(/^\xEF\xBB\xBF/, '').trim();
      return JSON.parse(cleaned);
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Request timeout (15s)');
    throw err;
  }
}

function normalizeAPIItem(item, marketingName) {
  const sp = item.SalePrice || {};
  const lp = item.ListPrice || {};
  const saleMin = sp.Minimum || 0;
  const saleMax = sp.Maximum || saleMin;
  const listMin = lp.Minimum || 0;
  const listMax = lp.Maximum || listMin;
  const discount = listMin > 0 ? Math.round((1 - saleMin / listMin) * 100) : 0;
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
    discount,
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

// Check if deal title/subtitle matches blocked words
function scannerIsBlocked(deal, blockedWords) {
  if (!blockedWords || !blockedWords.length) return false;
  const titleLow = (deal.title || '').toLowerCase();
  const subtitleLow = (deal.subtitle || '').toLowerCase();
  return blockedWords.some(w => titleLow.includes(w) || subtitleLow.includes(w));
}

// Check product condition filter
function scannerIsAllowedCondition(deal, settings) {
  const cond = (deal.condition || '').toLowerCase().trim();
  if (!cond || cond === 'new') return true;
  if (cond.includes('open box') || cond.includes('openbox')) {
    return !!settings.ntfyAllowOpenBox;
  }
  if (cond.includes('refurbished') || cond.includes('refurb')) {
    return !!settings.ntfyAllowRefurbished;
  }
  return true; // unknown condition → allow
}

// Check quiet hours
function scannerIsQuietHours(settings) {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = settings.quietStart.split(':').map(Number);
  const [eh, em] = settings.quietEnd.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end; // overnight range
}

// Send ntfy.sh notification (server-side)
async function scannerSendNtfy(deal, topic, settings) {
  try {
    const safeTitle = (deal.title || 'Deal')
      .replace(/[^\x20-\x7E]/g, '')
      .substring(0, 200) || 'Woot Deal';
    const titleHeader = `${safeTitle} - $${deal.salePrice.toFixed(2)}`;

    const body = `${deal.title}\nPrecio: $${deal.salePrice.toFixed(2)} Antes $${deal.listPrice.toFixed(2)}${deal.discount > 0 ? ` (${deal.discount}% OFF)` : ''}\n${deal.url}`;

    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Title': titleHeader,
        'Tags': 'moneybag,fire',
        'Priority': deal.discount >= 60 ? '5' : '4',
        'Click': deal.url
      },
      body
    });

    const logEntry = {
      time: new Date().toISOString(),
      title: deal.title,
      price: deal.salePrice,
      discount: deal.discount,
      url: deal.url,
      topic,
      status: res.ok ? 'success' : 'error',
      error: res.ok ? null : `HTTP ${res.status}`
    };

    // Save log
    const logs = loadNtfyLogs();
    logs.unshift(logEntry);
    saveNtfyLogs(logs);

    if (res.ok) {
      console.log(`  📲 ntfy → ${deal.title.substring(0, 50)}... ($${deal.salePrice.toFixed(2)})`);
    } else {
      console.warn(`  ⚠️ ntfy error: HTTP ${res.status} for ${deal.title.substring(0, 40)}`);
    }
    return res.ok;
  } catch (err) {
    console.warn(`  ❌ ntfy failed: ${err.message}`);
    const logs = loadNtfyLogs();
    logs.unshift({
      time: new Date().toISOString(),
      title: deal.title,
      price: deal.salePrice,
      discount: deal.discount,
      url: deal.url,
      topic,
      status: 'error',
      error: err.message
    });
    saveNtfyLogs(logs);
    return false;
  }
}

// Send Discord webhook notification (server-side)
async function scannerSendDiscord(deal, webhookUrl) {
  try {
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

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Woot Bot',
        avatar_url: 'https://d3gqasl9vmjfd8.cloudfront.net/assets/woot_logo.png',
        embeds: [embed]
      })
    });

    if (res.ok || res.status === 204) {
      console.log(`  💬 Discord → ${deal.title.substring(0, 50)}...`);
    } else {
      console.warn(`  ⚠️ Discord error: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`  ❌ Discord failed: ${err.message}`);
  }
}

// ===== MAIN SCANNER FUNCTION =====
// MED-03: try/finally ensures isScanning is always reset
async function scannerDoScan() {
  if (scanner.isScanning) return;
  scanner.isScanning = true;
  scanner.lastError = null;

  try {
    const settings = loadSettings() || {};
    const apiKey = settings.apiKey;

    if (!apiKey) {
      scanner.lastError = 'No API key configured';
      return;
    }

    const scanStart = Date.now();
    const selectedCats = settings.categories || ['All'];
    const feedsToFetch = selectedCats.includes('All') ? ['All'] : selectedCats;

    // Fetch all feeds in parallel
    const promises = feedsToFetch.map(async (cat) => {
      try {
        const data = await fetchJSON(`${WOOT_API_BASE}/feed/${cat}`, {
          'Accept': 'application/json',
          'x-api-key': apiKey
        });
        if (data.Items && Array.isArray(data.Items)) {
          return data.Items.map(item => normalizeAPIItem(item, data.MarketingName || cat));
        }
      } catch (e) {
        console.warn(`  [Scanner] Feed ${cat} failed: ${e.message}`);
      }
      return [];
    });

    const results = await Promise.allSettled(promises);
    let allDeals = [];
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) allDeals.push(...r.value);
    });

    const allFailed = results.every(r => r.status === 'rejected');
    if (allFailed && results.length > 0) {
      throw results[0].reason || new Error('All feeds failed');
    }

    allDeals = dedupeDeals(allDeals);
    scanner.currentDeals = allDeals;

    // Find new deals (using in-memory Set for accuracy)
    const newDeals = allDeals.filter(d => !scanner.seenIds.has(d.id));
    allDeals.forEach(d => scanner.seenIds.add(d.id));
    // Persist to disk (debounced — writes at most once per minute)
    scannerPersistSeenIds();

    scanner.scanCount++;
    scanner.lastScanTime = Date.now();
    const duration = ((Date.now() - scanStart) / 1000).toFixed(1);

    console.log(`[${new Date().toLocaleTimeString()}] 🔍 Scan #${scanner.scanCount}: ${allDeals.length} deals (${newDeals.length} new) in ${duration}s`);

    // === SEND NOTIFICATIONS (skip on first scan to avoid spam) ===
    if (scanner.isFirstScan) {
      scanner.isFirstScan = false;
      console.log(`  ℹ️  First scan — notifications suppressed (${newDeals.length} deals marked as seen)`);
    } else if (newDeals.length > 0) {
      const allDefinedKws = (settings.keywordButtons || []).map(k => k.toLowerCase());
      const blockedWords = (settings.blockedWords || []).map(w => w.toLowerCase());
      const isQuiet = scannerIsQuietHours(settings);
      let notifiedCount = 0;

      for (const deal of newDeals) {
        if (deal.isSoldOut) continue;
        if (isQuiet) continue;
        if (scannerIsBlocked(deal, blockedWords)) continue;
        if (!scannerIsAllowedCondition(deal, settings)) continue;

        // Keyword matching logic:
        // - If keywords defined: only notify if deal matches a keyword
        // - If no keywords defined: use ntfyMinDiscount threshold
        // Searches title, subtitle, URL, and categories for broader matching
        // (Woot API sometimes truncates product names, e.g. omitting "AMD Radeon")
        const hasDefinedKws = allDefinedKws.length > 0;
        const searchText = [
          deal.title, deal.subtitle || '',
          deal.url || '', (deal.categories || []).join(' ')
        ].join(' ').toLowerCase();
        const kwMatch = hasDefinedKws && allDefinedKws.some(kw => searchText.includes(kw));

        const shouldNotify = kwMatch || (!hasDefinedKws && deal.discount >= (settings.ntfyMinDiscount || 0));

        if (!shouldNotify) continue;

        // Send ntfy
        if (settings.ntfyEnabled && settings.ntfyTopic) {
          await scannerSendNtfy(deal, settings.ntfyTopic, settings);
          notifiedCount++;
        }

        // Send Discord
        if (settings.discordEnabled && settings.discordWebhook) {
          await scannerSendDiscord(deal, settings.discordWebhook);
          notifiedCount++;
        }
      }

      if (notifiedCount > 0) {
        scanner.totalNotified += notifiedCount;
        console.log(`  📣 Sent ${notifiedCount} notification(s)`);
      }
    }

  } catch (err) {
    scanner.lastError = err.message;
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Scan failed: ${err.message}`);
  } finally {
    scanner.isScanning = false;
  }
}

// Start/restart the scanner interval
function scannerStart(coldStart = false) {
  if (scanner.timer) clearInterval(scanner.timer);

  const settings = loadSettings() || {};
  scanner.intervalSec = Math.max(60, settings.refreshInterval || 120);

  console.log(`  ⏱️  Scanner interval: every ${scanner.intervalSec}s`);

  // Only do immediate scan on cold start (server boot)
  if (coldStart) {
    setTimeout(() => {
      scannerDoScan().catch(e => console.error('[Scanner] Initial scan error:', e));
    }, 2000);
  }

  // Recurring scans
  scanner.timer = setInterval(() => {
    scannerDoScan().catch(e => console.error('[Scanner] Scan error:', e));
  }, scanner.intervalSec * 1000);
}

// ===== START SERVER =====
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 Woot Alert Bot Server (Hardened + Server-Side Scanner)`);
  console.log(`  ─────────────────────────────────────────────────────`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${getLocalIP()}:${PORT}`);
  console.log(`  Auth:     ${AUTH_FILE} (hashed)`);
  console.log(`  Rate Limit: ${RATE_LIMIT_MAX} attempts / ${RATE_LIMIT_WINDOW/60000} min`);
  console.log(`  Sessions:   Persistent (${SESSIONS_FILE})`);
  console.log(`  Body Limit: ${MAX_BODY_SIZE / 1024}KB`);
  console.log(`  Scanner:    ✅ Autonomous (server-side)`);
  console.log(`  ─────────────────────────────────────────────────────\n`);

  // Load seen IDs into memory from disk, then start scanner
  scannerInitSeenIds();
  scannerStart(true);
});

function getLocalIP() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '0.0.0.0';
}
