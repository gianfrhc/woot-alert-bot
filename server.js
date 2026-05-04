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

// ===== ATOMIC FILE WRITES (DATA-01) =====
function atomicWriteJSON(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filepath); // atomic on same filesystem
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
    if (fs.existsSync(SEEN_IDS_FILE)) return JSON.parse(fs.readFileSync(SEEN_IDS_FILE, 'utf8'));
  } catch (e) { console.error('[SeenIds] Load error:', e.message); }
  return [];
}

function saveSeenIds(ids) {
  const trimmed = Array.isArray(ids) ? ids.slice(-2000) : [];
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
  if (req.method === 'GET' && urlPath === '/api/settings') {
    const settings = loadSettings();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settings || {}));
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
      saveSettingsFile(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      console.log(`[${new Date().toLocaleTimeString()}] Settings saved (${data.keywordButtons?.length || 0} keywords)`);
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

  if (req.method === 'POST' && urlPath === '/api/ntfy-logs') {
    try {
      const body = await readBody(req);
      const entry = JSON.parse(body);
      const logs = loadNtfyLogs();
      logs.unshift(entry);
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

  if (req.method === 'POST' && urlPath === '/api/seen-ids') {
    try {
      const body = await readBody(req);
      const ids = JSON.parse(body);
      if (!Array.isArray(ids)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected an array of IDs' }));
        return;
      }
      saveSeenIds(ids);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // === PROTECTED: Static files ===
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const basename = path.basename(filePath);
  const blocked = ['auth.json', 'settings.json', 'ntfy-logs.json', 'sessions.json', 'seen-ids.json', 'server.js'];
  if (blocked.includes(basename)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 Woot Alert Bot Server (Hardened)`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${getLocalIP()}:${PORT}`);
  console.log(`  Auth:     ${AUTH_FILE} (hashed)`);
  console.log(`  Rate Limit: ${RATE_LIMIT_MAX} attempts / ${RATE_LIMIT_WINDOW/60000} min`);
  console.log(`  Sessions:   Persistent (${SESSIONS_FILE})`);
  console.log(`  Body Limit: ${MAX_BODY_SIZE / 1024}KB`);
  console.log(`  ──────────────────────────────────\n`);
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
