'use strict';

// ============================================================
//  POLYPLAYER — server.js  (MongoDB Atlas edition)
//  Dependencies: mongodb
//  Install:  npm install mongodb
//  Run:      MONGO_URI="mongodb+srv://..." node server.js
// ============================================================

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const { MongoClient, ObjectId } = require('mongodb');

// ============================================================
//  CONFIG
// ============================================================
const PORT          = process.env.PORT        || 3000;
const SESSION_DAYS  = 30;
const HMAC_SECRET   = process.env.HMAC_SECRET || 'polyplayer-secret-change-in-production';
const MONGO_URI     = process.env.MONGO_URI   || 'mongodb://localhost:27017/polyplayer';
const WELCOME_COINS = 10;
const CHAT_MAX_LEN  = 200;
const CHAT_HISTORY  = 50;

const BAD_WORDS = ['fuck','shit','ass','bitch','dick','cunt','nigger','faggot','retard'];

// ============================================================
//  DATABASE CONNECTION + COLLECTIONS
// ============================================================
let db;      // MongoDB database handle
let users, sessions, transactions, games, lobbies, lobbyMembers;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db             = client.db();          // uses the DB name from the URI
  users          = db.collection('users');
  sessions       = db.collection('sessions');
  transactions   = db.collection('transactions');
  games          = db.collection('games');
  lobbies        = db.collection('lobbies');
  lobbyMembers   = db.collection('lobby_members');

  // Indexes
  await users.createIndex({ username: 1 }, { unique: true });
  await sessions.createIndex({ token: 1 }, { unique: true });
  await sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await games.createIndex({ game_id: 1 }, { unique: true });

  console.log('[DB] Connected to MongoDB.');
}

async function initDB() {
  // Seed admin account
  const admin = await users.findOne({ username: 'admin' });
  if (!admin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('admin123', salt);
    const result = await users.insertOne({
      username:      'admin',
      display_name:  'Administrator',
      password_hash: hash,
      password_salt: salt,
      avatar:        '🐺',
      coins:         999999,
      is_admin:      1,
      created_at:    new Date(),
      last_login:    null,
    });
    console.log('[DB] Admin account created. Username: admin  Password: admin123');
  }

  // Seed Tac-Grid game
  const tacgrid = await games.findOne({ game_id: 'tac-grid' });
  if (!tacgrid) {
    await games.insertOne({
      game_id:     'tac-grid',
      name:        'Tac-Grid',
      stake:       3,
      min_players: 2,
      max_players: 2,
      needs_rt:    1,
      is_active:   1,
      created_at:  new Date(),
    });
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
  const payload = `${userId}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const sig     = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 4) return null;
  const sig      = parts.pop();
  const payload  = parts.join('.');
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  return payload.split('.')[0]; // userId string (ObjectId hex)
}

// ============================================================
//  SESSION HELPERS
// ============================================================
async function createSession(userId) {
  const token   = generateToken(userId.toString());
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await sessions.insertOne({ user_id: userId, token, expires_at: expires });
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const userIdStr = verifyToken(token);
  if (!userIdStr) return null;

  let userId;
  try { userId = new ObjectId(userIdStr); } catch { return null; }

  const session = await sessions.findOne({
    token,
    expires_at: { $gt: new Date() },
    user_id: userId,
  });
  if (!session) return null;

  const user = await users.findOne({ _id: userId });
  if (!user) return null;

  // Merge so callers can use both session and user fields
  return { ...user, id: user._id };
}

function getTokenFromRequest(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers['cookie'] || '';
  const match  = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

// ============================================================
//  TRANSACTION HELPER
// ============================================================
async function recordTx(userId, amount, type, description) {
  await transactions.insertOne({
    user_id:     userId,
    amount,
    type,
    description: description || '',
    created_at:  new Date(),
  });
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
//  IN-MEMORY CHAT STORE
// ============================================================
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
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(json);
}

function ok(res, data = {})         { send(res, 200, { ok: true,  ...data }); }
function fail(res, msg, code = 400) { send(res, code, { ok: false, error: msg }); }

// ============================================================
//  ROUTER
// ============================================================
const routes = [];

function route(method, pattern, handler, requireAuth = false, requireAdmin = false) {
  routes.push({ method, pattern, handler, requireAuth, requireAdmin });
}

async function handleRequest(req, res) {
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

  if (method === 'GET' && (path_ === '/' || path_ === '/index.html')) {
    const html = fs.readFileSync('./index.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  for (const r of routes) {
    if (r.method !== method) continue;

    let params = {};
    let match  = false;

    if (typeof r.pattern === 'string') {
      match = path_ === r.pattern;
    } else {
      const m = path_.match(r.pattern);
      if (m) { match = true; params = m.groups || {}; }
    }

    if (!match) continue;

    if (r.requireAuth || r.requireAdmin) {
      const token = getTokenFromRequest(req);
      const user  = await getSessionUser(token);
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

  const existing = await users.findOne({ username });
  if (existing) return fail(res, 'Username already taken.');

  const salt  = crypto.randomBytes(16).toString('hex');
  const hash  = hashPassword(password, salt);
  const dname = (display_name || username).slice(0, 30);

  const result = await users.insertOne({
    username,
    display_name:  dname,
    password_hash: hash,
    password_salt: salt,
    avatar:        '🐺',
    coins:         WELCOME_COINS,
    is_admin:      0,
    created_at:    new Date(),
    last_login:    null,
  });

  await recordTx(result.insertedId, WELCOME_COINS, 'signup_bonus', 'Welcome bonus coins');

  const token = await createSession(result.insertedId);
  ok(res, { token, username, display_name: dname, coins: WELCOME_COINS, avatar: '🐺', is_admin: 0 });
});

// POST /api/login
route('POST', '/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return fail(res, 'Username and password required.');

  const user = await users.findOne({ username });
  if (!user) return fail(res, 'Invalid username or password.');

  const hash = hashPassword(password, user.password_salt);
  if (hash !== user.password_hash) return fail(res, 'Invalid username or password.');

  await users.updateOne({ _id: user._id }, { $set: { last_login: new Date() } });

  const token = await createSession(user._id);
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
  if (token) await sessions.deleteOne({ token });
  ok(res, { message: 'Logged out.' });
});

// GET /api/me
route('GET', '/api/me', async (req, res) => {
  const token = getTokenFromRequest(req);
  const user  = await getSessionUser(token);
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
  const user = await users.findOne({ _id: req.user._id }, { projection: { coins: 1 } });
  const txs  = await transactions
    .find({ user_id: req.user._id })
    .sort({ _id: -1 })
    .limit(50)
    .project({ amount: 1, type: 1, description: 1, created_at: 1, _id: 0 })
    .toArray();
  ok(res, { coins: user.coins, transactions: txs });
}, true);

// PUT /api/profile
route('PUT', '/api/profile', async (req, res) => {
  const { display_name, avatar } = req.body;
  const validAvatars = ['🦊','🐺','🐍','🤖','👻','🦅','👾','⚡','🐻','🦁','🐯','🦂'];

  const updates = {};
  if (display_name !== undefined) {
    if (display_name.length < 1 || display_name.length > 30) return fail(res, 'Display name must be 1-30 characters.');
    updates.display_name = display_name.slice(0, 30);
  }
  if (avatar !== undefined) {
    if (!validAvatars.includes(avatar)) return fail(res, 'Invalid avatar.');
    updates.avatar = avatar;
  }

  if (Object.keys(updates).length) {
    await users.updateOne({ _id: req.user._id }, { $set: updates });
  }

  const updated = await users.findOne({ _id: req.user._id }, { projection: { display_name: 1, avatar: 1, _id: 0 } });
  ok(res, updated);
}, true);

// ============================================================
//  GAMES ROUTES
// ============================================================

// GET /api/games
route('GET', '/api/games', async (req, res) => {
  const gameList = await games.find({ is_active: 1 }).sort({ _id: 1 }).toArray();
  ok(res, { games: gameList });
}, true);

// ============================================================
//  LOBBY ROUTES
// ============================================================

// POST /api/lobby/join  { game_id }
route('POST', '/api/lobby/join', async (req, res) => {
  const { game_id } = req.body;
  if (!game_id) return fail(res, 'game_id required.');

  const game = await games.findOne({ game_id, is_active: 1 });
  if (!game) return fail(res, 'Game not found or inactive.');

  const user = await users.findOne({ _id: req.user._id }, { projection: { coins: 1 } });
  if (user.coins < game.stake) return fail(res, `Not enough coins. Need ${game.stake}, you have ${user.coins}.`);

  // Check if already in a waiting lobby for this game
  const waitingLobby = await lobbies.findOne({ game_id, status: 'waiting' });
  if (waitingLobby) {
    const already = await lobbyMembers.findOne({ lobby_id: waitingLobby._id, user_id: req.user._id });
    if (already) return fail(res, 'You are already in a lobby for this game.');
  }

  // Find or create a waiting lobby
  let lobby = await lobbies.findOne({ game_id, status: 'waiting' });
  if (!lobby) {
    const result = await lobbies.insertOne({
      game_id,
      status:     'waiting',
      pot:        0,
      winner_id:  null,
      created_at: new Date(),
      started_at: null,
      ended_at:   null,
    });
    lobby = await lobbies.findOne({ _id: result.insertedId });
  }

  // Deduct stake
  await users.updateOne({ _id: req.user._id }, { $inc: { coins: -game.stake } });
  await recordTx(req.user._id, -game.stake, 'stake_deducted', `Stake for ${game.name}`);
  await lobbies.updateOne({ _id: lobby._id }, { $inc: { pot: game.stake } });
  await lobbyMembers.insertOne({
    lobby_id:  lobby._id,
    user_id:   req.user._id,
    stake:     game.stake,
    joined_at: new Date(),
  });

  const memberCount = await lobbyMembers.countDocuments({ lobby_id: lobby._id });
  const updatedUser = await users.findOne({ _id: req.user._id }, { projection: { coins: 1 } });
  const updatedLobby = await lobbies.findOne({ _id: lobby._id });

  let started = false;
  if (memberCount >= game.min_players) {
    await lobbies.updateOne({ _id: lobby._id }, { $set: { status: 'active', started_at: new Date() } });
    started = true;
    broadcastToLobby(lobby._id.toString(), { type: 'match_start', lobby_id: lobby._id.toString(), game_id });
  } else {
    broadcastToLobby(lobby._id.toString(), { type: 'player_joined', count: memberCount, needed: game.min_players });
  }

  ok(res, {
    lobby_id:    lobby._id.toString(),
    game_id,
    stake:       game.stake,
    pot:         updatedLobby.pot,
    members:     memberCount,
    min_players: game.min_players,
    started,
    coins:       updatedUser.coins,
  });
}, true);

// POST /api/lobby/leave  { lobby_id }
route('POST', '/api/lobby/leave', async (req, res) => {
  const { lobby_id } = req.body;
  if (!lobby_id) return fail(res, 'lobby_id required.');

  let lobbyObjId;
  try { lobbyObjId = new ObjectId(lobby_id); } catch { return fail(res, 'Invalid lobby_id.'); }

  const lobby = await lobbies.findOne({ _id: lobbyObjId, status: 'waiting' });
  if (!lobby) return fail(res, 'Lobby not found or already started.');

  const member = await lobbyMembers.findOne({ lobby_id: lobbyObjId, user_id: req.user._id });
  if (!member) return fail(res, 'You are not in this lobby.');

  // Refund stake
  await users.updateOne({ _id: req.user._id }, { $inc: { coins: member.stake } });
  await recordTx(req.user._id, member.stake, 'refund', 'Left lobby before match started');
  await lobbyMembers.deleteOne({ _id: member._id });
  await lobbies.updateOne({ _id: lobbyObjId }, { $inc: { pot: -member.stake } });

  const memberCount = await lobbyMembers.countDocuments({ lobby_id: lobbyObjId });
  if (memberCount === 0) {
    await lobbies.updateOne({ _id: lobbyObjId }, { $set: { status: 'cancelled' } });
  }

  broadcastToLobby(lobby_id, { type: 'player_left', count: memberCount });

  const updatedUser = await users.findOne({ _id: req.user._id }, { projection: { coins: 1 } });
  ok(res, { refunded: member.stake, coins: updatedUser.coins });
}, true);

// GET /api/lobby/:id
route('GET', /^\/api\/lobby\/(?<lobby_id>[^/]+)$/, async (req, res) => {
  let lobbyObjId;
  try { lobbyObjId = new ObjectId(req.params.lobby_id); } catch { return fail(res, 'Invalid lobby_id.', 404); }

  const lobby = await lobbies.findOne({ _id: lobbyObjId });
  if (!lobby) return fail(res, 'Lobby not found.', 404);

  const memberDocs = await lobbyMembers.find({ lobby_id: lobbyObjId }).toArray();
  const userIds    = memberDocs.map(m => m.user_id);
  const memberUsers = await users
    .find({ _id: { $in: userIds } })
    .project({ username: 1, display_name: 1, avatar: 1, _id: 0 })
    .toArray();

  const game = await games.findOne({ game_id: lobby.game_id });
  ok(res, { lobby, members: memberUsers, game });
}, true);

// POST /api/match/result  { lobby_id, winner_username }
route('POST', '/api/match/result', async (req, res) => {
  const { lobby_id, winner_username } = req.body;
  if (!lobby_id || !winner_username) return fail(res, 'lobby_id and winner_username required.');

  let lobbyObjId;
  try { lobbyObjId = new ObjectId(lobby_id); } catch { return fail(res, 'Invalid lobby_id.'); }

  const lobby = await lobbies.findOne({ _id: lobbyObjId, status: 'active' });
  if (!lobby) return fail(res, 'Active lobby not found.');

  const winner = await users.findOne({ username: winner_username });
  if (!winner) return fail(res, 'Winner not found.');

  const inLobby = await lobbyMembers.findOne({ lobby_id: lobbyObjId, user_id: winner._id });
  if (!inLobby) return fail(res, 'Winner was not in this lobby.');

  const pot = lobby.pot;
  await users.updateOne({ _id: winner._id }, { $inc: { coins: pot } });
  await recordTx(winner._id, pot, 'payout', `Won match in lobby #${lobby_id}`);
  await lobbies.updateOne(
    { _id: lobbyObjId },
    { $set: { status: 'finished', winner_id: winner._id, ended_at: new Date() } }
  );

  broadcastToLobby(lobby_id, { type: 'match_over', winner: winner_username, pot });

  const updatedWinner = await users.findOne({ _id: winner._id }, { projection: { coins: 1 } });
  ok(res, { winner: winner_username, pot, coins: updatedWinner.coins });
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
  const userList = await users
    .find({ is_admin: 0 })
    .sort({ _id: 1 })
    .project({ username: 1, display_name: 1, coins: 1, avatar: 1, last_login: 1, created_at: 1 })
    .toArray();
  // Map _id to id for frontend compatibility
  const mapped = userList.map(u => ({ ...u, id: u._id.toString() }));
  ok(res, { users: mapped });
}, true, true);

// POST /api/admin/coins  { user_id, amount, reason }
route('POST', '/api/admin/coins', async (req, res) => {
  const { user_id, amount, reason } = req.body;
  if (!user_id || amount === undefined) return fail(res, 'user_id and amount required.');

  const amt = parseInt(amount);
  let userObjId;
  try { userObjId = new ObjectId(user_id); } catch { return fail(res, 'Invalid user_id.'); }

  const user = await users.findOne({ _id: userObjId });
  if (!user) return fail(res, 'User not found.');

  const newBal = user.coins + amt;
  if (newBal < 0) return fail(res, 'Cannot reduce coins below 0.');

  await users.updateOne({ _id: userObjId }, { $set: { coins: newBal } });
  const type = amt >= 0 ? 'admin_credit' : 'admin_debit';
  await recordTx(userObjId, amt, type, reason || `Admin adjustment by ${req.user.username}`);

  ok(res, { user_id, new_balance: newBal, amount: amt });
}, true, true);

// GET /api/admin/games
route('GET', '/api/admin/games', async (req, res) => {
  const gameList = await games.find({}).sort({ _id: 1 }).toArray();
  ok(res, { games: gameList });
}, true, true);

// POST /api/admin/games  — register new game
route('POST', '/api/admin/games', async (req, res) => {
  const { game_id, name, stake, min_players, max_players, needs_rt } = req.body;
  if (!game_id || !name) return fail(res, 'game_id and name required.');

  const existing = await games.findOne({ game_id });
  if (existing) return fail(res, 'game_id already registered.');

  await games.insertOne({
    game_id,
    name,
    stake:       stake       || 3,
    min_players: min_players || 2,
    max_players: max_players || 2,
    needs_rt:    needs_rt ? 1 : 0,
    is_active:   1,
    created_at:  new Date(),
  });

  ok(res, { message: `Game "${name}" registered.` });
}, true, true);

// PUT /api/admin/games/:game_id
route('PUT', /^\/api\/admin\/games\/(?<game_id>[^/]+)$/, async (req, res) => {
  const { stake, is_active, name } = req.body;
  const game = await games.findOne({ game_id: req.params.game_id });
  if (!game) return fail(res, 'Game not found.', 404);

  const updates = {};
  if (stake     !== undefined) updates.stake     = parseInt(stake);
  if (is_active !== undefined) updates.is_active = is_active ? 1 : 0;
  if (name      !== undefined) updates.name      = name;

  if (Object.keys(updates).length) {
    await games.updateOne({ game_id: req.params.game_id }, { $set: updates });
  }

  ok(res, { updated: true });
}, true, true);

// GET /api/admin/matches
route('GET', '/api/admin/matches', async (req, res) => {
  const lobbyList = await lobbies.find({}).sort({ _id: -1 }).limit(100).toArray();

  const enriched = await Promise.all(lobbyList.map(async l => {
    const game   = await games.findOne({ game_id: l.game_id }, { projection: { name: 1 } });
    const winner = l.winner_id ? await users.findOne({ _id: l.winner_id }, { projection: { username: 1 } }) : null;
    return {
      id:         l._id.toString(),
      game_id:    l.game_id,
      game_name:  game ? game.name : null,
      pot:        l.pot,
      status:     l.status,
      winner:     winner ? winner.username : null,
      created_at: l.created_at,
      ended_at:   l.ended_at,
    };
  }));

  ok(res, { matches: enriched });
}, true, true);

// GET /api/admin/chat/:room_id
route('GET', /^\/api\/admin\/chat\/(?<room_id>[^/]+)$/, async (req, res) => {
  ok(res, { messages: getRoomHistory(req.params.room_id) });
}, true, true);

// ============================================================
//  WEBSOCKET — Lobby real-time + Chat
// ============================================================
const wsClients = {};

function broadcastToLobby(lobbyId, data) {
  const room = wsClients[String(lobbyId)];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

function handleWebSocket(req, socket, head) {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const url     = new URL(req.url, 'http://localhost');
  const lobbyId = url.searchParams.get('lobby_id') || 'global';
  const token   = url.searchParams.get('token');

  // Resolve user asynchronously; store on socket when ready
  socket._wsUser = null;
  getSessionUser(token).then(user => {
    socket._wsUser = user || null;
    if (user) {
      broadcastToLobby(lobbyId, { type: 'system', message: `${user.display_name} joined.`, ts: Date.now() });
    }
  });

  if (!wsClients[lobbyId]) wsClients[lobbyId] = new Set();
  wsClients[lobbyId].add(socket);

  const history = getRoomHistory(lobbyId);
  if (history.length) {
    const frame = encodeFrame(JSON.stringify({ type: 'history', messages: history }));
    socket.write(frame);
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

      if (opcode === 8) { socket.destroy(); break; }

      if (opcode === 1 || opcode === 2) {
        let payload = buffer.slice(offset + maskLen, totalLen);
        if (masked) {
          const mask = buffer.slice(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        try {
          const msg = JSON.parse(payload.toString());
          handleWsMessage(socket, lobbyId, socket._wsUser, msg);
        } catch { /* ignore bad JSON */ }
      }

      buffer = buffer.slice(totalLen);
    }
  });

  socket.on('close', () => {
    if (wsClients[lobbyId]) wsClients[lobbyId].delete(socket);
    if (socket._wsUser) {
      broadcastToLobby(lobbyId, { type: 'system', message: `${socket._wsUser.display_name} left.`, ts: Date.now() });
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
    socket.write(encodeFrame(JSON.stringify({ type: 'pong' })));
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
(async () => {
  await connectDB();
  await initDB();

  const server = http.createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws')) {
      handleWebSocket(req, socket, head);
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
})();
