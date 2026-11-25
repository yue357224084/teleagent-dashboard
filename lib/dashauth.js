// 控制台登录态：用户（scrypt 口令哈希）+ 会话 token（data/auth_sessions.json）
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] === 'scrypt' && parts.length === 3) {
    const hash = crypto.scryptSync(String(password), parts[1], 32, SCRYPT);
    const want = Buffer.from(parts[2], 'hex');
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  }
  return false;
}

class DashboardAuth {
  constructor(store, log) {
    this.store = store;
    this.log = log;
    this.file = path.join(store.dataDir, 'auth_sessions.json');
    this.sessions = this.loadSessions();
    this.ensureAdmin();
  }

  ensureAdmin() {
    if (this.store.users.length) return;
    const pwd = process.env.TELEAGENT_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    this.store.users.push({
      id: 'u_admin',
      username: 'admin',
      passwordHash: hashPassword(pwd),
      role: 'admin',
      maxQuota: 999,
      createdAt: Date.now(),
    });
    this.store.save();
    const initFile = path.join(this.store.dataDir, 'admin-init.txt');
    try { fs.writeFileSync(initFile, `username=admin\npassword=${pwd}\n`, { mode: 0o600 }); } catch { /* 忽略 */ }
    console.log(`\n🔑 初始管理员已创建：admin / ${pwd}`);
    console.log(`   （同样写入 ${initFile}，登录后请在界面改密）\n`);
  }

  loadSessions() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      const out = {};
      for (const [t, s] of Object.entries(raw || {})) if (s && s.expiresAt > now) out[t] = s;
      return out;
    } catch { return {}; }
  }

  persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.sessions, null, 2), { mode: 0o600 });
    } catch (e) { this.log.push('Auth', `会话落盘失败: ${e.message}`, 'warning'); }
  }

  findUser(username) {
    return this.store.users.find((u) => u.username === username.toLowerCase() || u.username === username);
  }

  login(username, password) {
    const user = this.findUser(String(username || '').trim());
    if (!user || !verifyPassword(password, user.passwordHash)) return null;
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions[token] = { userId: user.id, username: user.username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
    this.persist();
    return { token, user: this.publicUser(user) };
  }

  publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      maxQuota: user.maxQuota,
      avatar: user.avatar || '',
      accountsCount: this.store.accounts.filter((a) => a.ownerId === user.id).length,
    };
  }

  verify(token) {
    const s = token && this.sessions[token];
    if (!s || s.expiresAt < Date.now()) return null;
    return { ...s, token, role: (this.store.users.find((u) => u.id === s.userId) || {}).role || 'user' };
  }

  logout(token) {
    if (this.sessions[token]) { delete this.sessions[token]; this.persist(); }
  }

  changePassword(userId, oldPwd, newPwd) {
    const user = this.store.users.find((u) => u.id === userId);
    if (!user) return { ok: false, error: '用户不存在' };
    if (!verifyPassword(oldPwd, user.passwordHash)) return { ok: false, error: '当前密码不正确' };
    if (!newPwd || String(newPwd).length < 6) return { ok: false, error: '新密码至少 6 位' };
    user.passwordHash = hashPassword(newPwd);
    this.store.save();
    return { ok: true };
  }
}

module.exports = { DashboardAuth, hashPassword, verifyPassword };
