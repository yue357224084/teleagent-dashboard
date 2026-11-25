// 多账号管理：账号 CRUD + 运行时装配 + 每日福利社领取调度
'use strict';

const { AccountRuntime, todayCST } = require('./runtime');

const KEEPALIVE_REFRESH_SEC = 300;

class AccountManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = ctx.store;
    this.logbus = ctx.logbus;
    this.runtimes = new Map();
    ctx.notifier = ctx.notifier;
  }

  start() {
    for (const acc of this.store.accounts) {
      const rt = this.runtime(acc);
      if (acc.jwt) {
        rt.refreshInstances().catch((e) => this.logbus.push('System', `[${acc.name}] 实例信息刷新失败: ${e.message}`, 'warning', acc.name));
        rt.refreshPoints().catch(() => {});
      }
      if (acc.enabled !== false && acc.features.keepAlive && acc.jwt) rt.startKeepAlive();
    }
    this.tickTimer = setInterval(() => this.tick().catch(() => {}), 30 * 1000);
    this.tickTimer.unref();
  }

  runtime(acc) {
    let rt = this.runtimes.get(acc.id);
    if (!rt) {
      rt = new AccountRuntime(acc, this.ctx);
      this.runtimes.set(acc.id, rt);
    }
    return rt;
  }

  get(id) { return this.store.accounts.find((a) => a.id === id) || null; }

  list(ownerId) {
    return this.store.accounts.filter((a) => !ownerId || a.ownerId === ownerId);
  }

  async create({ name, account, password, keepaliveInterval }) {
    if (!account || !password) throw new Error('账号和密码都要填');
    const acc = {
      id: AccountRuntime.newId(),
      platform: 'teleagent',
      ownerId: 'u_admin',
      name: String(name || `TeleAgent-${String(account).slice(-4)}`).slice(0, 40),
      user: String(account).trim(),
      password,
      jwt: null,
      jwtExpiresAt: 0,
      instanceId: null,
      instanceName: '',
      instanceStatus: null,
      keepaliveInterval: Math.max(60, Number(keepaliveInterval) || KEEPALIVE_REFRESH_SEC),
      displayConfig: { width: 2560, height: 1440, scale: 150 },
      enabled: true,
      bound: false,
      sessionExpired: false,
      features: { keepAlive: true, autoSign: true, aiChat: false, cloudHang: false, autoRedeem: false, autoBoot: true },
      stats: { lastSignTime: '', lastAiChatTime: '', lastHangTime: '', hangMinutesToday: 0, points: 0, keepAliveStatus: 'offline', lastError: '', todaySuccessCount: 0, lastSuccessDate: '', lastSignDate: '' },
      restartPlan: { enabled: false, mode: 'daily', time: '04:30', weekday: 0 },
      createdAt: Date.now(),
    };
    // 先登录成功再入库：登录失败不留半成品账号（否则重试会产生重复条目）
    const rt = new AccountRuntime(acc, this.ctx);
    await rt.loginWithPassword(acc.user, password);
    this.store.accounts.push(acc);
    this.runtimes.set(acc.id, rt);
    this.store.save();
    this.logbus.push('System', `已添加 TeleAgent 账号 [${acc.name}]（${rt.maskAccount(acc.user)}）并完成登录`, 'success', acc.name);
    return { ok: true, account: acc };
  }

  remove(id) {
    const i = this.store.accounts.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const [acc] = this.store.accounts.splice(i, 1);
    const rt = this.runtimes.get(id);
    if (rt) { try { rt.ka.stop(true); } catch { /* 忽略 */ } this.runtimes.delete(id); }
    this.store.save();
    this.logbus.push('System', `已删除账号 [${acc.name}]`, 'warning');
    return true;
  }

  update(id, body) {
    const acc = this.get(id);
    if (!acc) return null;
    if (body.name) acc.name = String(body.name).slice(0, 40);
    if (typeof body.enabled === 'boolean') acc.enabled = body.enabled;
    if (body.features) acc.features = { ...acc.features, ...body.features };
    if (body.restartPlan) {
      acc.restartPlan = { ...acc.restartPlan, ...body.restartPlan };
      this.runtime(acc).power.applyPlan(acc.restartPlan);
    }
    if (body.keepaliveInterval) {
      acc.keepaliveInterval = Math.max(60, Number(body.keepaliveInterval) || KEEPALIVE_REFRESH_SEC);
    }
    const rt = this.runtime(acc);
    if (body.features && 'keepAlive' in body.features) {
      if (body.features.keepAlive) rt.startKeepAlive(); else rt.stopKeepAlive();
    }
    this.store.save();
    return acc;
  }

  // 每日福利社积分：settings.cron.executeTime（默认 08:05）触发，每账号每日一次
  async tick() {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const target = this.store.settings.cron.executeTime || '08:05';
    if (hm !== target) return;
    const today = todayCST();
    for (const acc of this.store.accounts) {
      if (acc.enabled === false || !acc.features.autoSign) continue;
      if (acc.stats.lastSignDate === today) continue;
      const rt = this.runtime(acc);
      rt.claimDaily().catch((e) => this.logbus.push('Welfare', `[${acc.name}] 领取异常: ${e.message}`, 'error', acc.name));
    }
  }
}

module.exports = AccountManager;
