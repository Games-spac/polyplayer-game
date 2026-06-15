'use strict';

// ============================================================
//  POLYPLAYER — server.js
//  Zero npm dependencies. Requires Node.js v22+
//  Run: node server.js
// ============================================================

const http        = require('http');
const crypto      = require('crypto');
const path        = require('path');
const fs          = require('fs');
const { DatabaseSync } = require('node:sqlite');

// ============================================================
//  CONFIG
// ============================================================
const PORT          = process.env.PORT || 3000;
const SESSION_DAYS  = 30;
const HMAC_SECRET   = process.env.HMAC_SECRET || 'polyplayer-secret-change-in-production';
const DB_PATH       = process.env.DB_PATH     || './polyplayer.db';
const WELCOME_COINS = 10;
const CHAT_MAX_LEN  = 200;
const CHAT_HISTORY  = 50;

// Basic profanity filter — extend this list as needed
const BAD_WORDS = ['fuck','shit','ass','bitch','dick','cunt','nigger','faggot','retard'];

// ============================================================
//  DATABASE SETUP
// ============================================================
const db = new DatabaseSync(DB_PATH);

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT    UNIQUE NOT NULL,
      display_name TEXT    NOT NULL,
      password_hash TEXT   NOT NULL,
      password_salt TEXT   NOT NULL,
      avatar       TEXT    DEFAULT '🐺',
      coins        INTEGER DEFAULT 0,
      is_admin     INTEGER DEFAULT 0,
      created_at   TEXT    DEFAULT (datetime('now')),
      last_login   TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT    UNIQUE NOT NULL,
      expires_at TEXT    NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      amount      INTEGER NOT NULL,
      type        TEXT    NOT NULL,
      description TEXT,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS games (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id      TEXT    UNIQUE NOT NULL,
      name         TEXT    NOT NULL,
      stake        INTEGER DEFAULT 3,
      min_players  INTEGER DEFAULT 2,
      max_players  INTEGER DEFAULT 2,
      needs_rt     INTEGER DEFAULT 1,
      is_active    INTEGER DEFAULT 1,
      created_at   TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lobbies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id     TEXT    NOT NULL,
      status      TEXT    DEFAULT 'waiting',
      pot         INTEGER DEFAULT 0,
      winner_id   INTEGER,
      created_at  TEXT    DEFAULT (datetime('now')),
      started_at  TEXT,
      ended_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS lobby_members (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id  INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      stake     INTEGER DEFAULT 0,
      joined_at TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY(lobby_id) REFERENCES lobbies(id),
      FOREIGN KEY(user_id)  REFERENCES users(id)
    );
  `);

  // Seed admin account
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('admin123', salt);
    db.prepare(`
      INSERT INTO users (username, display_name, password_hash, password_salt, coins, is_admin)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('admin', 'Administrator', hash, salt, 999999);
    console.log('[DB] Admin account created. Username: admin  Password: admin123');
  }

  // Seed Tac-Grid game
  const tacgrid = db.prepare('SELECT id FROM games WHERE game_id = ?').get('tac-grid');
  if (!tacgrid) {
    db.prepare(`
      INSERT INTO games (game_id, name, stake, min_players, max_players, needs_rt, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('tac-grid', 'Tac-Grid', 3, 2, 2, 1, 1);
    console.log('[DB] Tac-Grid game registered.');
  }

  console.log('[DB] Database ready.');
}

// ============================================================
//  CRYPTO HELPERS
// ============================================================
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateToken(userId) {
  const payload  = `${userId}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const sig      = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 4) return null;
  const sig     = parts.pop();
  const payload = parts.join('.');
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  return payload.split('.')[0]; // userId
}

// ============================================================
//  SESSION HELPERS
// ============================================================
function createSession(userId) {
  const token   = generateToken(userId);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expires);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const userId = verifyToken(token);
  if (!userId) return null;
  const session = db.prepare(`
    SELECT s.*, u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.id = ?
  `).get(token, userId);
  return session || null;
}

function getTokenFromRequest(req) {
  // Try Authorization header first
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // Try cookie
  const cookie = req.headers['cookie'] || '';
  const match  = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

// ============================================================
//  TRANSACTION HELPER
// ============================================================
function recordTx(userId, amount, type, description) {
  db.prepare(`
    INSERT INTO transactions (user_id, amount, type, description)
    VALUES (?, ?, ?, ?)
  `).run(userId, amount, type, description || '');
}

// ============================================================
//  PROFANITY FILTER
// ============================================================
function filterMessage(text) {
  let filtered = text;
  BAD_WORDS.forEach(w => {
    const re = new RegExp(w, 'gi');
    filtered = filtered.replace(re, '*'.repeat(w.length));
  });
  return filtered;
}

// ============================================================
//  IN-MEMORY CHAT STORE  (lobby chats + match chats)
// ============================================================
// chatRooms[roomId] = [ { user, avatar, message, ts }, ... ]
const chatRooms = {};

function getRoomHistory(roomId) {
  return chatRooms[roomId] || [];
}

function addChatMessage(roomId, user, avatar, message) {
  if (!chatRooms[roomId]) chatRooms[roomId] = [];
  const msg = { user, avatar, message: filterMessage(message.slice(0, CHAT_MAX_LEN)), ts: Date.now() };
  chatRooms[roomId].push(msg);
  if (chatRooms[roomId].length > CHAT_HISTORY) chatRooms[roomId].shift();
  return msg;
}

// ============================================================
//  HTTP HELPERS
// ============================================================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end',  () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(json);
}

function ok(res, data = {})     { send(res, 200, { ok: true,  ...data }); }
function fail(res, msg, code=400) { send(res, code, { ok: false, error: msg }); }

// ============================================================
//  ROUTER
// ============================================================
const routes = [];

function route(method, pattern, handler, requireAuth = false, requireAdmin = false) {
  routes.push({ method, pattern, handler, requireAuth, requireAdmin });
}

async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    return res.end();
  }

  const url    = new URL(req.url, `http://localhost`);
  const path_  = url.pathname;
  const method = req.method.toUpperCase();

  // Serve index.html for root
  if (method === 'GET' && (path_ === '/' || path_ === '/index.html')) {
    const html = fs.readFileSync('./index.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Match API routes
  for (const r of routes) {
    if (r.method !== method) continue;

    let params = {};
    let match  = false;

    if (typeof r.pattern === 'string') {
      match = path_ === r.pattern;
    } else {
      // regex with named groups
      const m = path_.match(r.pattern);
      if (m) { match = true; params = m.groups || {}; }
    }

    if (!match) continue;

    // Auth guard
    if (r.requireAuth || r.requireAdmin) {
      const token = getTokenFromRequest(req);
      const user  = getSessionUser(token);
      if (!user) return fail(res, 'Unauthorized', 401);
      if (r.requireAdmin && !user.is_admin) return fail(res, 'Forbidden', 403);
      req.user   = user;
      req.params = params;
    } else {
      req.params = params;
    }

    try {
      const body = (method === 'POST' || method === 'PUT') ? await parseBody(req) : {};
      req.body   = body;
      await r.handler(req, res);
    } catch (err) {
      console.error('[ERROR]', err);
      fail(res, 'Internal server error', 500);
    }
    return;
  }

  // 404
  send(res, 404, { ok: false, error: 'Not found' });
}

// ============================================================
//  AUTH ROUTES
// ============================================================

// POST /api/register
route('POST', '/api/register', async (req, res) => {
  const { username, password, display_name } = req.body;

  if (!username || !password) return fail(res, 'Username and password required.');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail(res, 'Username must be 3-20 characters: letters, numbers, underscores only.');
  if (password.length < 6) return fail(res, 'Password must be at least 6 characters.');

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return fail(res, 'Username already taken.');

  const salt  = crypto.randomBytes(16).toString('hex');
  const hash  = hashPassword(password, salt);
  const dname = (display_name || username).slice(0, 30);

  const result = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, password_salt, coins)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, dname, hash, salt, WELCOME_COINS);

  recordTx(result.lastInsertRowid, WELCOME_COINS, 'signup_bonus', 'Welcome bonus coins');

  const token = createSession(result.lastInsertRowid);
  ok(res, { token, username, display_name: dname, coins: WELCOME_COINS, avatar: '🐺', is_admin: 0 });
});

// POST /api/login
route('POST', '/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return fail(res, 'Username and password required.');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return fail(res, 'Invalid username or password.');

  const hash = hashPassword(password, user.password_salt);
  if (hash !== user.password_hash) return fail(res, 'Invalid username or password.');

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  const token = createSession(user.id);
  ok(res, {
    token,
    username:     user.username,
    display_name: user.display_name,
    coins:        user.coins,
    avatar:       user.avatar,
    is_admin:     user.is_admin,
  });
});

// POST /api/logout
route('POST', '/api/logout', async (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  ok(res, { message: 'Logged out.' });
});

// GET /api/me
route('GET', '/api/me', async (req, res) => {
  const token = getTokenFromRequest(req);
  const user  = getSessionUser(token);
  if (!user) return fail(res, 'Unauthorized', 401);
  ok(res, {
    username:     user.username,
    display_name: user.display_name,
    coins:        user.coins,
    avatar:       user.avatar,
    is_admin:     user.is_admin,
  });
}, true);

// ============================================================
//  WALLET ROUTES
// ============================================================

// GET /api/wallet
route('GET', '/api/wallet', async (req, res) => {
  const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id);
  const txs  = db.prepare(`
    SELECT amount, type, description, created_at FROM transactions
    WHERE user_id = ? ORDER BY id DESC LIMIT 50
  `).all(req.user.id);
  ok(res, { coins: user.coins, transactions: txs });
}, true);

// PUT /api/profile
route('PUT', '/api/profile', async (req, res) => {
  const { display_name, avatar } = req.body;
  const validAvatars = ['🦊','🐺','🐍','🤖','👻','🦅','👾','⚡','🐻','🦁','🐯','🦂'];
  if (display_name) {
    if (display_name.length < 1 || display_name.length > 30) return fail(res, 'Display name must be 1-30 characters.');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.slice(0,30), req.user.id);
  }
  if (avatar) {
    if (!validAvatars.includes(avatar)) return fail(res, 'Invalid avatar.');
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
  }
  const updated = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(req.user.id);
  ok(res, updated);
}, true);

// ============================================================
//  GAMES ROUTES
// ============================================================

// GET /api/games
route('GET', '/api/games', async (req, res) => {
  const games = db.prepare('SELECT * FROM games WHERE is_active = 1 ORDER BY id').all();
  ok(res, { games });
}, true);

// ============================================================
//  LOBBY ROUTES
// ============================================================

// POST /api/lobby/join  { game_id }
route('POST', '/api/lobby/join', async (req, res) => {
  const { game_id } = req.body;
  if (!game_id) return fail(res, 'game_id required.');

  const game = db.prepare('SELECT * FROM games WHERE game_id = ? AND is_active = 1').get(game_id);
  if (!game) return fail(res, 'Game not found or inactive.');

  const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id);
  if (user.coins < game.stake) return fail(res, `Not enough coins. Need ${game.stake}, you have ${user.coins}.`);

  // Check if player is already in a waiting lobby for this game
  const already = db.prepare(`
    SELECT lm.id FROM lobby_members lm
    JOIN lobbies l ON l.id = lm.lobby_id
    WHERE lm.user_id = ? AND l.game_id = ? AND l.status = 'waiting'
  `).get(req.user.id, game_id);
  if (already) return fail(res, 'You are already in a lobby for this game.');

  // Find or create a waiting lobby
  let lobby = db.prepare(`
    SELECT * FROM lobbies WHERE game_id = ? AND status = 'waiting' LIMIT 1
  `).get(game_id);

  if (!lobby) {
    const result = db.prepare(`
      INSERT INTO lobbies (game_id, status, pot) VALUES (?, 'waiting', 0)
    `).run(game_id);
    lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(result.lastInsertRowid);
  }

  // Deduct stake
  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(game.stake, req.user.id);
  recordTx(req.user.id, -game.stake, 'stake_deducted', `Stake for ${game.name}`);
  db.prepare('UPDATE lobbies SET pot = pot + ? WHERE id = ?').run(game.stake, lobby.id);
  db.prepare('INSERT INTO lobby_members (lobby_id, user_id, stake) VALUES (?, ?, ?)').run(lobby.id, req.user.id, game.stake);

  // Get member count
  const memberCount = db.prepare('SELECT COUNT(*) as cnt FROM lobby_members WHERE lobby_id = ?').get(lobby.id).cnt;
  const newCoins    = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id).coins;

  // Check if lobby is full → start match
  let started = false;
  if (memberCount >= game.min_players) {
    db.prepare("UPDATE lobbies SET status = 'active', started_at = datetime('now') WHERE id = ?").run(lobby.id);
    started = true;
    broadcastToLobby(lobby.id, { type: 'match_start', lobby_id: lobby.id, game_id });
  } else {
    broadcastToLobby(lobby.id, { type: 'player_joined', count: memberCount, needed: game.min_players });
  }

  ok(res, {
    lobby_id:    lobby.id,
    game_id,
    stake:       game.stake,
    pot:         lobby.pot + game.stake,
    members:     memberCount,
    min_players: game.min_players,
    started,
    coins:       newCoins,
  });
}, true);

// POST /api/lobby/leave  { lobby_id }
route('POST', '/api/lobby/leave', async (req, res) => {
  const { lobby_id } = req.body;
  if (!lobby_id) return fail(res, 'lobby_id required.');

  const lobby = db.prepare("SELECT * FROM lobbies WHERE id = ? AND status = 'waiting'").get(lobby_id);
  if (!lobby) return fail(res, 'Lobby not found or already started.');

  const member = db.prepare('SELECT * FROM lobby_members WHERE lobby_id = ? AND user_id = ?').get(lobby_id, req.user.id);
  if (!member) return fail(res, 'You are not in this lobby.');

  // Refund stake
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(member.stake, req.user.id);
  recordTx(req.user.id, member.stake, 'refund', 'Left lobby before match started');
  db.prepare('DELETE FROM lobby_members WHERE id = ?').run(member.id);
  db.prepare('UPDATE lobbies SET pot = pot - ? WHERE id = ?').run(member.stake, lobby_id);

  const memberCount = db.prepare('SELECT COUNT(*) as cnt FROM lobby_members WHERE lobby_id = ?').get(lobby_id).cnt;
  if (memberCount === 0) {
    db.prepare("UPDATE lobbies SET status = 'cancelled' WHERE id = ?").run(lobby_id);
  }

  broadcastToLobby(lobby_id, { type: 'player_left', count: memberCount });

  const newCoins = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id).coins;
  ok(res, { refunded: member.stake, coins: newCoins });
}, true);

// GET /api/lobby/:id
route('GET', /^\/api\/lobby\/(?<lobby_id>\d+)$/, async (req, res) => {
  const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.lobby_id);
  if (!lobby) return fail(res, 'Lobby not found.', 404);

  const members = db.prepare(`
    SELECT u.username, u.display_name, u.avatar
    FROM lobby_members lm JOIN users u ON u.id = lm.user_id
    WHERE lm.lobby_id = ?
  `).all(req.params.lobby_id);

  const game = db.prepare('SELECT * FROM games WHERE game_id = ?').get(lobby.game_id);
  ok(res, { lobby, members, game });
}, true);

// POST /api/match/result  { lobby_id, winner_username }
// Called by the game client when match ends
route('POST', '/api/match/result', async (req, res) => {
  const { lobby_id, winner_username } = req.body;
  if (!lobby_id || !winner_username) return fail(res, 'lobby_id and winner_username required.');

  const lobby = db.prepare("SELECT * FROM lobbies WHERE id = ? AND status = 'active'").get(lobby_id);
  if (!lobby) return fail(res, 'Active lobby not found.');

  const winner = db.prepare('SELECT * FROM users WHERE username = ?').get(winner_username);
  if (!winner) return fail(res, 'Winner not found.');

  // Verify winner was in this lobby
  const inLobby = db.prepare('SELECT id FROM lobby_members WHERE lobby_id = ? AND user_id = ?').get(lobby_id, winner.id);
  if (!inLobby) return fail(res, 'Winner was not in this lobby.');

  // Pay out pot to winner
  const pot = lobby.pot;
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(pot, winner.id);
  recordTx(winner.id, pot, 'payout', `Won match in lobby #${lobby_id}`);
  db.prepare("UPDATE lobbies SET status = 'finished', winner_id = ?, ended_at = datetime('now') WHERE id = ?").run(winner.id, lobby_id);

  broadcastToLobby(lobby_id, { type: 'match_over', winner: winner_username, pot });

  ok(res, { winner: winner_username, pot, coins: db.prepare('SELECT coins FROM users WHERE id = ?').get(winner.id).coins });
}, true);

// ============================================================
//  CHAT ROUTES (REST fallback — WebSocket is primary)
// ============================================================

// GET /api/chat/:room_id
route('GET', /^\/api\/chat\/(?<room_id>[^/]+)$/, async (req, res) => {
  ok(res, { messages: getRoomHistory(req.params.room_id) });
}, true);

// ============================================================
//  ADMIN ROUTES
// ============================================================

// GET /api/admin/users
route('GET', '/api/admin/users', async (req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name, coins, avatar, last_login, created_at
    FROM users WHERE is_admin = 0 ORDER BY id
  `).all();
  ok(res, { users });
}, true, true);

// POST /api/admin/coins  { user_id, amount, reason }
route('POST', '/api/admin/coins', async (req, res) => {
  const { user_id, amount, reason } = req.body;
  if (!user_id || amount === undefined) return fail(res, 'user_id and amount required.');

  const amt = parseInt(amount);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return fail(res, 'User not found.');

  const newBal = user.coins + amt;
  if (newBal < 0) return fail(res, 'Cannot reduce coins below 0.');

  db.prepare('UPDATE users SET coins = ? WHERE id = ?').run(newBal, user_id);
  const type = amt >= 0 ? 'admin_credit' : 'admin_debit';
  recordTx(user_id, amt, type, reason || `Admin adjustment by ${req.user.username}`);

  ok(res, { user_id, new_balance: newBal, amount: amt });
}, true, true);

// GET /api/admin/games
route('GET', '/api/admin/games', async (req, res) => {
  const games = db.prepare('SELECT * FROM games ORDER BY id').all();
  ok(res, { games });
}, true, true);

// POST /api/admin/games  — register new game
route('POST', '/api/admin/games', async (req, res) => {
  const { game_id, name, stake, min_players, max_players, needs_rt } = req.body;
  if (!game_id || !name) return fail(res, 'game_id and name required.');

  const exists = db.prepare('SELECT id FROM games WHERE game_id = ?').get(game_id);
  if (exists) return fail(res, 'game_id already registered.');

  db.prepare(`
    INSERT INTO games (game_id, name, stake, min_players, max_players, needs_rt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(game_id, name, stake||3, min_players||2, max_players||2, needs_rt?1:0);

  ok(res, { message: `Game "${name}" registered.` });
}, true, true);

// PUT /api/admin/games/:game_id
route('PUT', /^\/api\/admin\/games\/(?<game_id>[^/]+)$/, async (req, res) => {
  const { stake, is_active, name } = req.body;
  const game = db.prepare('SELECT * FROM games WHERE game_id = ?').get(req.params.game_id);
  if (!game) return fail(res, 'Game not found.', 404);

  if (stake    !== undefined) db.prepare('UPDATE games SET stake    = ? WHERE game_id = ?').run(parseInt(stake), req.params.game_id);
  if (is_active!== undefined) db.prepare('UPDATE games SET is_active= ? WHERE game_id = ?').run(is_active?1:0, req.params.game_id);
  if (name     !== undefined) db.prepare('UPDATE games SET name     = ? WHERE game_id = ?').run(name, req.params.game_id);

  ok(res, { updated: true });
}, true, true);

// GET /api/admin/matches
route('GET', '/api/admin/matches', async (req, res) => {
  const matches = db.prepare(`
    SELECT l.id, l.game_id, g.name as game_name, l.pot, l.status,
           u.username as winner, l.created_at, l.ended_at
    FROM lobbies l
    LEFT JOIN games g ON g.game_id = l.game_id
    LEFT JOIN users u ON u.id = l.winner_id
    ORDER BY l.id DESC LIMIT 100
  `).all();
  ok(res, { matches });
}, true, true);

// GET /api/admin/chat/:room_id
route('GET', /^\/api\/admin\/chat\/(?<room_id>[^/]+)$/, async (req, res) => {
  ok(res, { messages: getRoomHistory(req.params.room_id) });
}, true, true);

// ============================================================
//  WEBSOCKET — Lobby real-time + Chat
// ============================================================
// wsClients[lobby_id] = Set of ws connections
const wsClients = {};

function broadcastToLobby(lobbyId, data) {
  const room = wsClients[String(lobbyId)];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function handleWebSocket(req, socket, head, server) {
  // Manual WebSocket handshake (no ws library — pure Node.js)
  const key      = req.headers['sec-websocket-key'];
  const accept   = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const url      = new URL(req.url, 'http://localhost');
  const lobbyId  = url.searchParams.get('lobby_id') || 'global';
  const token    = url.searchParams.get('token');
  const user     = getSessionUser(token);

  if (!wsClients[lobbyId]) wsClients[lobbyId] = new Set();
  wsClients[lobbyId].add(socket);

  // Send chat history on connect
  const history = getRoomHistory(lobbyId);
  if (history.length) {
    const frame = encodeFrame(JSON.stringify({ type: 'history', messages: history }));
    socket.write(frame);
  }

  // If user info available, announce join
  if (user) {
    const joinMsg = { type: 'system', message: `${user.display_name} joined.`, ts: Date.now() };
    broadcastToLobby(lobbyId, joinMsg);
  }

  let buffer = Buffer.alloc(0);

  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 2) {
      const firstByte  = buffer[0];
      const secondByte = buffer[1];
      const opcode     = firstByte & 0x0f;
      const masked     = (secondByte & 0x80) !== 0;
      let payloadLen   = secondByte & 0x7f;
      let offset       = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) break;
        payloadLen = buffer.readUInt16BE(2);
        offset     = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) break;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset     = 10;
      }

      const maskLen  = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (buffer.length < totalLen) break;

      // Connection close
      if (opcode === 8) {
        socket.destroy();
        break;
      }

      if (opcode === 1 || opcode === 2) {
        let payload = buffer.slice(offset + maskLen, totalLen);
        if (masked) {
          const mask = buffer.slice(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }

        try {
          const msg = JSON.parse(payload.toString());
          handleWsMessage(socket, lobbyId, user, msg);
        } catch { /* ignore bad JSON */ }
      }

      buffer = buffer.slice(totalLen);
    }
  });

  socket.on('close', () => {
    if (wsClients[lobbyId]) wsClients[lobbyId].delete(socket);
    if (user) {
      broadcastToLobby(lobbyId, { type: 'system', message: `${user.display_name} left.`, ts: Date.now() });
    }
  });

  socket.on('error', () => {
    if (wsClients[lobbyId]) wsClients[lobbyId].delete(socket);
  });
}

function handleWsMessage(socket, lobbyId, user, msg) {
  if (msg.type === 'chat') {
    if (!msg.message || typeof msg.message !== 'string') return;
    const name   = user ? user.display_name : 'Anonymous';
    const avatar = user ? user.avatar       : '👾';
    const stored = addChatMessage(lobbyId, name, avatar, msg.message);
    broadcastToLobby(lobbyId, { type: 'chat', ...stored });
  } else if (msg.type === 'ping') {
    const frame = encodeFrame(JSON.stringify({ type: 'pong' }));
    socket.write(frame);
  } else if (msg.type === 'quick_msg') {
    const presets = ['Good luck! 🤞', 'GG 🎉', 'Nice move! 👏', 'Nooo! 😱', 'Let\'s go! 🔥'];
    const text    = presets[msg.index] || 'Hey!';
    const name    = user ? user.display_name : 'Anonymous';
    const avatar  = user ? user.avatar       : '👾';
    const stored  = addChatMessage(lobbyId, name, avatar, text);
    broadcastToLobby(lobbyId, { type: 'chat', ...stored });
  }
}

function encodeFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len     = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

// ============================================================
//  START SERVER
// ============================================================
initDB();

const server = http.createServer(handleRequest);

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) {
    handleWebSocket(req, socket, head, server);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║         POLYPLAYER SERVER            ║
  ║   Running on http://localhost:${PORT}   ║
  ║   WebSocket: ws://localhost:${PORT}/ws  ║
  ║   Admin: admin / admin123            ║
  ╚══════════════════════════════════════╝
  `);
});
