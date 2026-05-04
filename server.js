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
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// ===== AUTH CONFIG =====
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      // Migrate plaintext password to hash if needed
      if (auth.password && !auth.hash) {
        auth.hash = hashPassword(auth.password);
        delete auth.password;
        fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
        console.log('  🔐 Password migrated to secure hash');
      }
      // If valid hash exists, use it
      if (auth.hash) return auth;
      // Otherwise fall through to generate new password
    }
  } catch (e) {}

  // First run: generate random password
  const password = crypto.randomBytes(4).toString('hex');
  const auth = { hash: hashPassword(password) };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
  console.log(`\n  🔑 First run — generated password: ${password}`);
  console.log(`  📁 Saved to: ${AUTH_FILE}`);
  console.log(`  ⚠️  This password is shown ONLY ONCE. It's stored as a hash.\n`);
  return auth;
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd + 'woot-salt-2026').digest('hex');
}

function verifyPassword(input, auth) {
  // Support both legacy plaintext and hashed passwords
  if (auth.hash) {
    const inputHash = hashPassword(input);
    return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(auth.hash));
  }
  // Legacy plaintext fallback
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
  } catch (e) {}
}

function saveSessions() {
  const obj = {};
  sessions.forEach((expiry, token) => { obj[token] = expiry; });
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8'); } catch (e) {}
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
  } catch (e) {}
  return null;
}

function saveSettingsFile(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadNtfyLogs() {
  try {
    if (fs.existsSync(NTFY_LOGS_FILE)) return JSON.parse(fs.readFileSync(NTFY_LOGS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveNtfyLogs(logs) {
  const trimmed = logs.slice(0, 500);
  fs.writeFileSync(NTFY_LOGS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
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
  // No wildcard CORS — only same-origin requests allowed
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  // === PROTECTED: Static files ===
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const basename = path.basename(filePath);
  const blocked = ['auth.json', 'settings.json', 'ntfy-logs.json', 'sessions.json', 'server.js'];
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
