// TeleAgent 云电脑多账号保活控制台
// 前端：ctyun-dashboard（learycn/ctyun-dashboard 的静态页面）
// 后端：agent.teleai.com.cn / superCowork 平台接口（登录 / 实例保活 / 福利社积分 / 电源）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const Store = require('./lib/store');
const LogBus = require('./lib/logbus');
const Notifier = require('./lib/notifier');
const { DashboardAuth } = require('./lib/dashauth');
const AccountManager = require('./lib/accounts');
const { accountView, dashboardStatus } = require('./lib/views');
const { todayCST } = require('./lib/runtime');

const PORT = Number(process.env.PORT || 8580);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.CTYUN_DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store(DATA_DIR);
const logbus = new LogBus(DATA_DIR);
logbus.loadRecent();
const notifier = new Notifier(store, logbus);
const auth = new DashboardAuth(store, logbus);
const manager = new AccountManager({ store, logbus, notifier });
manager.start();

function json(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function session(req, parsed) {
  const h = req.headers.authorization || '';
  let token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token && parsed) token = parsed.searchParams.get('token') || '';
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  return auth.verify(token);
}

function requireAuth(req, res, parsed) {
  const s = session(req, parsed);
  if (!s) { json(res, { error: '未授权：请登录后再操作' }, 401); return null; }
  return s;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function runtimeOf(id) {
  const acc = manager.get(id);
  if (!acc) return null;
  return { acc, rt: manager.runtime(acc) };
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = parsed.pathname;

  try {
    // ---------- 静态 ----------
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const rel = p.replace('/static/', '').replace(/\.\./g, '');
      return serveStatic(res, path.join(PUBLIC_DIR, 'static', rel));
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ---------- 登录态 ----------
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const r = auth.login(body.username, body.password);
      if (!r) return json(res, { error: '用户名或密码错误' }, 401);
      logbus.push('Auth', `用户 ${r.user.username} 登录成功`, 'info');
      return json(res, { success: true, token: r.token, user: { ...r.user, userId: r.user.id } });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const s = session(req, parsed);
      if (s) auth.logout(s.token);
      return json(res, { success: true });
    }
    if (p === '/api/auth/me') {
      const s = session(req, parsed);
      if (!s) return json(res, { isLoggedIn: false, isGuest: true });
      const user = store.users.find((u) => u.id === s.userId);
      return json(res, {
        isLoggedIn: true,
        systemTitle: store.settings.systemTitle,
        systemSubtitle: store.settings.systemSubtitle,
        user: auth.publicUser(user),
      });
    }
    if (p === '/api/auth/register') return json(res, { error: '本部署不开放注册' }, 403);
    if (p === '/api/auth/change-password' && req.method === 'POST') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const body = await readBody(req);
      const r = auth.changePassword(s.userId, body.oldPassword || body.currentPassword, body.newPassword);
      return json(res, r, r.ok ? 200 : 400);
    }
    if (p === '/api/auth/change-username' || p === '/api/auth/change-avatar') return json(res, { success: true });

    // ---------- 看板状态 ----------
    if (p === '/api/status') {
      const s = session(req, parsed);
      if (!s) return json(res, { accountsTotal: 0, onlineKeepAlive: 0, signedToday: 0, currentTime: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), isGuest: true });
      return json(res, dashboardStatus(manager.list(), (a) => manager.runtime(a)));
    }

    // ---------- 账号 ----------
    if (p === '/api/accounts' && req.method === 'GET') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      return json(res, manager.list().map((acc) => accountView(acc, manager.runtime(acc))));
    }

    if (p === '/api/accounts/teleagent/login' && req.method === 'POST') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const body = await readBody(req);
      try {
        const r = await manager.create({
          name: body.name, account: body.account || body.user, password: body.password,
          keepaliveInterval: body.keepaliveInterval,
        });
        return json(res, { id: r.account.id, message: `账号 [${r.account.name}] 已登录并纳入保活` });
      } catch (e) {
        return json(res, { error: e.message }, 400);
      }
    }

    // 兼容旧前端"添加账号"入口（未提供平台时给出明确提示）
    if (req.method === 'POST' && p === '/api/accounts') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const body = await readBody(req);
      if (!body.account || !body.password) return json(res, { error: '请在「添加账号」里选择 TeleAgent 并填写手机号+密码' }, 400);
      const r = await manager.create(body);
      return json(res, { id: r.account.id });
    }

    if (p.startsWith('/api/accounts/')) {
      const parts = p.split('/').filter(Boolean); // ['api','accounts',id,...]
      const id = parts[2];
      const tail = parts.slice(3).join('/');
      if (!id) return json(res, { error: '缺少账号 id' }, 400);

      if (req.method === 'DELETE' && parts.length === 3) {
        const s = requireAuth(req, res, parsed); if (!s) return;
        const ok = manager.remove(id);
        return json(res, ok ? { success: true } : { error: '账号不存在' }, ok ? 200 : 404);
      }

      if (req.method === 'PUT' && parts.length === 3) {
        const s = requireAuth(req, res, parsed); if (!s) return;
        const body = await readBody(req);
        const acc = manager.update(id, body);
        if (!acc) return json(res, { error: '账号不存在' }, 404);
        const rt = manager.runtime(acc);
        // 编辑账号时填了新密码 → 立即用新密码重登
        if (body.password) {
          rt.loginWithPassword(acc.user, body.password)
            .catch((e) => logbus.push('Auth', `[${acc.name}] 重新登录失败: ${e.message}`, 'error', acc.name));
        }
        return json(res, accountView(acc, rt));
      }

      const cur = runtimeOf(id);
      if (!cur) return json(res, { error: '账号不存在' }, 404);
      const { acc, rt } = cur;

      if (req.method === 'GET' && parts.length === 3) {
        const s = requireAuth(req, res, parsed); if (!s) return;
        return json(res, accountView(acc, rt));
      }

      if (tail === 'desktops') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        try { await rt.refreshInstances(); } catch (e) { logbus.push('KeepAlive', `[${acc.name}] 实例列表刷新失败: ${e.message}`, 'warning', acc.name); }
        return json(res, accountView(acc, rt).desktops);
      }

      if (parts[3] === 'run' && req.method === 'POST') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        const task = parts[4];
        if (task === 'sign' || task === 'welfare') {
          rt.claimDaily().then((r) => {
            if (r.ok && !r.already) logbus.push('Welfare', `[${acc.name}] 福利社积分 +100（${r.message || 'ok'}）`, 'success', acc.name);
          });
          return json(res, { message: `[${acc.name}] 福利社积分领取已启动，结果以平台返回为准` });
        }
        if (task === 'keepalive') {
          rt.startKeepAlive();
          return json(res, { message: `[${acc.name}] 保活已重新拉起` });
        }
        if (task === 'relogin') {
          rt.ensureJwt().then(() => rt.refreshInstances()).catch((e) => logbus.push('Auth', `[${acc.name}] 重新登录失败: ${e.message}`, 'error', acc.name));
          return json(res, { message: `[${acc.name}] 重新登录已启动` });
        }
        if (task === 'keepalive-now') {
          rt.kick().then((r) => logbus.push('KeepAlive', `[${acc.name}] 立即保活完成（第 ${r.cycles} 轮）`, 'success', acc.name))
            .catch((e) => logbus.push('KeepAlive', `[${acc.name}] 立即保活失败: ${e.message}`, 'warning', acc.name));
          return json(res, { message: `[${acc.name}] 已触发立即保活` });
        }
        if (task === 'refresh') {
          rt.refreshInstances().catch(() => {});
          rt.refreshPoints().catch(() => {});
          return json(res, { message: `[${acc.name}] 已触发刷新` });
        }
        return json(res, { message: '该任务类型在当前平台不支持', unsupported: true });
      }

      if (parts[3] === 'power' && req.method === 'POST') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        const action = parts[4];
        try {
          const r = await rt.power(action);
          return json(res, { success: true, message: `[${acc.name}] ${action} 已下发`, data: r || null });
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }

      if (tail === 'web-launch' || tail === 'open') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        try {
          const url = await rt.openDesktop();
          return json(res, { success: true, directViewUrl: url, connectURL: url, desktopName: acc.instanceName || 'TeleAgent 云电脑' });
        } catch (e) {
          return json(res, { error: `打开云电脑失败: ${e.message}` }, 400);
        }
      }

      if (tail === 'service-status') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        try { return json(res, { success: true, data: await rt.serviceStatus() }); }
        catch (e) { return json(res, { success: false, error: e.message }, 400); }
      }

      if (tail === 'logout' && req.method === 'POST') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        return json(res, rt.clearCredentials());
      }

      if (tail === 'vm-feature' && req.method === 'POST') {
        const s = requireAuth(req, res, parsed); if (!s) return;
        const body = await readBody(req);
        if (body.vmKey || body.desktopId) {
          const key = String(body.desktopId || body.vmKey);
          if ('keepaliveEnabled' in body || 'taskEnabled' in body) {
            if ('taskEnabled' in body) acc.features.autoSign = !!body.taskEnabled;
            if ('keepaliveEnabled' in body) acc.features.keepAlive = !!body.keepaliveEnabled;
            manager.update(id, { features: acc.features });
          }
          return json(res, { success: true, target: key });
        }
        return json(res, { success: true });
      }

      // 其余未实现的账号级接口：返回中性结果，避免前端报错
      return json(res, { message: '该操作在当前平台不支持', unsupported: true });
    }

    // ---------- 日志 ----------
    if (p === '/api/logs' && req.method === 'GET') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const limit = Math.min(Number(parsed.searchParams.get('limit')) || 200, 600);
      return json(res, logbus.ring.slice(-limit));
    }
    if (p === '/api/logs/stream') {
      if (!session(req, parsed)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
      logbus.attach(res);
      return;
    }
    if (p === '/api/logs/clear' && req.method === 'POST') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      logbus.clear();
      return json(res, { success: true });
    }

    // ---------- 设置 ----------
    if (p === '/api/settings' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
      const s = requireAuth(req, res, parsed); if (!s) return;
      if (req.method === 'GET') return json(res, store.settings);
      const body = await readBody(req);
      const st = store.settings;
      for (const k of ['keepAliveSeconds', 'pulseIntervalSeconds', 'allowRegistration', 'defaultQuota', 'systemTitle', 'systemSubtitle']) {
        if (body[k] !== undefined) st[k] = body[k];
      }
      if (body.cron && typeof body.cron === 'object') st.cron = { ...st.cron, ...body.cron };
      if (body.notify && typeof body.notify === 'object') st.notify = { ...st.notify, ...body.notify };
      store.save();
      logbus.push('System', '系统设置已更新', 'info');
      return json(res, st);
    }

    if (p === '/api/user/notify' && (req.method === 'GET' || req.method === 'PUT')) {
      const s = requireAuth(req, res, parsed); if (!s) return;
      if (req.method === 'GET') return json(res, store.settings.notify);
      const body = await readBody(req);
      store.settings.notify = { ...store.settings.notify, ...body };
      store.save();
      return json(res, { success: true });
    }
    if (p === '/api/user/notify/test' && req.method === 'POST') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const r = await notifier.send('测试通知', '个人通知通道测试');
      return json(res, r.ok ? { success: true } : { success: false, error: r.error || '未配置 webhook' });
    }

    // ---------- 通知测试 ----------
    if (p === '/api/notify/test' && req.method === 'POST') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const r = await notifier.send('测试通知', `来自 TeleAgent 控制台的测试消息 ${new Date().toLocaleString('zh-CN')}`);
      return json(res, r, r.ok ? 200 : 400);
    }

    // ---------- 概览 / 奖励（前端顶部统计用） ----------
    if (p === '/api/rewards') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      return json(res, []);
    }

    // ---------- 管理 ----------
    if (p.startsWith('/api/admin/users/') && req.method === 'PUT') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const body = await readBody(req);
      const uid = p.split('/')[4];
      const user = store.users.find((u) => u.id === uid) || store.users[0];
      if (p.endsWith('/password') && body.password) {
        user.passwordHash = require('./lib/dashauth').hashPassword(body.password);
        store.save();
        return json(res, { success: true });
      }
      if (p.endsWith('/quota')) {
        user.maxQuota = Number(body.quota) || user.maxQuota;
        store.save();
        return json(res, { success: true });
      }
      return json(res, { success: true });
    }
    if (p === '/api/admin/users') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      if (req.method === 'GET') return json(res, store.users.map((u) => auth.publicUser(u)));
      return json(res, { message: '本部署仅保留单一管理员，用户管理未开放', unsupported: true });
    }

    // ---------- 配置导入导出 ----------
    if (p === '/api/config/export') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const clone = JSON.parse(JSON.stringify(store.cfg));
      for (const a of clone.accounts) {
        if (a.password) a.password = store.encrypt(a.password);
        if (a.jwt) a.jwt = store.encrypt(a.jwt);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="teleagent-config.json"' });
      return res.end(JSON.stringify(clone, null, 2));
    }
    if (p === '/api/config/import' && req.method === 'POST') {
      const s = requireAuth(req, res, parsed); if (!s) return;
      const body = await readBody(req);
      if (!body || !Array.isArray(body.accounts)) return json(res, { error: '配置格式不正确' }, 400);
      for (const a of body.accounts) {
        if (a.password) a.password = store.decrypt(a.password);
        if (a.jwt) a.jwt = store.decrypt(a.jwt);
        a.stats = a.stats || {};
        a.features = { keepAlive: true, autoSign: true, aiChat: false, cloudHang: false, autoRedeem: false, autoBoot: true, ...(a.features || {}) };
      }
      store.cfg.accounts = body.accounts;
      if (body.settings) store.cfg.settings = { ...store.settings, ...body.settings };
      store.save();
      logbus.push('System', `已导入 ${body.accounts.length} 个账号配置（重启后完全生效）`, 'warning');
      return json(res, { success: true, accounts: body.accounts.length });
    }

    if (p === '/api/device/generate') return json(res, { deviceCode: `ta_${Date.now().toString(36)}` });

    // 未实现接口：中性返回，不打断前端渲染
    if (p.startsWith('/api/')) {
      logbus.push('System', `前端调用了未实现的接口: ${req.method} ${p}`, 'warning');
      return json(res, {}, 200);
    }

    return json(res, { error: 'Not Found' }, 404);
  } catch (e) {
    logbus.push('System', `请求异常 ${req.method} ${p}: ${e.message}`, 'error');
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log('===========================================================');
  console.log('🚀 TeleAgent 云电脑多账号保活控制台已启动');
  console.log(`👉 控制台访问地址: http://${HOST === "0.0.0.0" ? '<本机IP>' : HOST}:${PORT}`);
  console.log(`📁 数据目录: ${DATA_DIR}`);
  console.log(`👥 账号数量: ${store.accounts.length}`);
  console.log('===========================================================');
});

process.on('uncaughtException', (e) => {
  logbus.push('System', `未捕获异常: ${e.stack || e.message}`, 'error');
  console.error(e);
});
process.on('unhandledRejection', (e) => {
  logbus.push('System', `未处理 Promise 拒绝: ${(e && e.message) || e}`, 'error');
});

module.exports = server;
