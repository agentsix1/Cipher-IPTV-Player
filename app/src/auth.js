'use strict';

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'xs_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LOCAL_USER_ID = 'local';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function publicUser(row) {
  return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : null;
}

function userCount() {
  return db.get('SELECT COUNT(*) AS n FROM users WHERE id <> ?', [LOCAL_USER_ID]).n;
}

function createUser(username, password, isAdmin) {
  const name = String(username || '').trim();
  if (!/^[\w.@-]{2,40}$/.test(name)) throw httpError(400, 'Username must be 2-40 letters, numbers, or . _ - @');
  if (String(password || '').length < 4) throw httpError(400, 'Password must be at least 4 characters');
  if (db.get('SELECT id FROM users WHERE username = ?', [name])) throw httpError(409, 'That username is already taken');
  const id = crypto.randomUUID();
  db.run('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, name, hashPassword(password), isAdmin ? 1 : 0, Date.now()]);
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [id]));
}

function ensureLocalUser() {
  if (!db.get('SELECT id FROM users WHERE id = ?', [LOCAL_USER_ID])) {
    db.run('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)',
      [LOCAL_USER_ID, 'local', hashPassword(crypto.randomBytes(24).toString('hex')), Date.now()]);
  }
}

function login(username, password) {
  const row = db.get('SELECT * FROM users WHERE username = ? AND id <> ?', [String(username || '').trim(), LOCAL_USER_ID]);
  if (!row || !verifyPassword(password, row.password_hash)) throw httpError(401, 'Invalid username or password');
  const token = crypto.randomBytes(32).toString('hex');
  db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, row.id, Date.now() + SESSION_TTL_MS]);
  return { token, user: publicUser(row) };
}

function logout(token) {
  if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeMs) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function resolveUser(req) {
  if (config.isApk) return publicUser(db.get('SELECT * FROM users WHERE id = ?', [LOCAL_USER_ID]));
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const session = db.get('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!session || session.expires_at < Date.now()) return null;
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', [session.user_id]));
}

function middleware(req, _res, next) {
  req.user = resolveUser(req);
  req.sessionToken = parseCookies(req.headers.cookie)[COOKIE] || null;
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

function listUsers() {
  return db.all('SELECT * FROM users WHERE id <> ? ORDER BY username', [LOCAL_USER_ID]).map(publicUser);
}

function deleteUser(id) {
  db.run('DELETE FROM users WHERE id = ?', [id]);
  db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  db.run('DELETE FROM settings WHERE user_id = ?', [id]);
  db.run('DELETE FROM favorites WHERE user_id = ?', [id]);
  db.run('DELETE FROM group_prefs WHERE user_id = ?', [id]);
}

function changePassword(userId, currentPassword, newPassword) {
  const row = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) throw httpError(401, 'Current password is incorrect');
  if (String(newPassword || '').length < 4) throw httpError(400, 'Password must be at least 4 characters');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), userId]);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  COOKIE,
  SESSION_TTL_MS,
  LOCAL_USER_ID,
  userCount,
  createUser,
  ensureLocalUser,
  login,
  logout,
  sessionCookie,
  middleware,
  requireUser,
  requireAdmin,
  listUsers,
  deleteUser,
  changePassword,
  httpError,
};
