// 单账号运行时：把平台模块（登录 / 保活 / 积分 / 电源）按账号组合起来
'use strict';

const path = require('path');
const crypto = require('crypto');

const Login = require('./platform/login');
const KeepAlive = require('./platform/keepalive');
const Api = require('./platform/api');
const Power = require('./platform/power');

const SAPI_BASE = 'https://agent.teleai.com.cn/superCowork/sapi';

function todayCST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

class AccountRuntime {
  constructor(acc, ctx) {
    this.acc = acc;
    this.store = ctx.store;
    this.ctx = ctx;
    this.dataDir = path.join(ctx.store.dataDir, 'accounts', acc.id);
    this.log = {
      info: (s, m) => ctx.logbus.push(s, m, 'info', acc.name),
      warn: (s, m) => ctx.logbus.push(s, m, 'warning', acc.name),
      error: (s, m) => ctx.logbus.push(s, m, 'error', acc.name),
    };
    this.login = new Login(this.dataDir, this.log);
    this.authRef = { jwt: acc.jwt || null };
    this.ka = new KeepAlive(
      this.authRef,
      { keepalive: { enabled: true, mode: 'ticket', refreshSec: Math.max(60, Number(acc.keepaliveInterval) || 300) } },
      this.log,
      ctx.notifier,
    );
    this.api = new Api(this.authRef, { api_base: SAPI_BASE }, this.log);
    this.power = new Power({ power: { restart_plan: acc.restartPlan || {} } }, this.log, ctx.notifier, this.ka);
    if (acc.jwt) {
      this.ka.bindToken(acc.jwt);
      this.api.bindToken(acc.jwt);
    }
    this.lastSignDate = acc.stats.lastSignDate || '';
    this.busy = false;
  }

  get jwt() { return this.authRef.jwt; }

  persist() { this.store.save(); }

  maskAccount(a) {
    const s = String(a || '');
    if (/^\d{11}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(7)}`;
    return s.length > 4 ? `${s.slice(0, 2)}***${s.slice(-1)}` : s;
  }

  async loginWithPassword(account, password) {
    const r = await this.login.loginByPassword(account, password);
    if (!r || !r.operationToken) throw new Error('未获取到 operationToken');
    this.authRef.jwt = r.operationToken;
    this.acc.jwt = r.operationToken;
    this.acc.jwtExpiresAt = (r.expiresAt || 0) * 1000 || Date.now() + 20 * 86400000;
    this.acc.user = String(account).trim();
    this.acc.bound = true;
    this.acc.sessionExpired = false;
    if (password) this.acc.password = password;
    this.ka.bindToken(this.authRef.jwt);
    this.api.bindToken(this.authRef.jwt);
    await this.refreshInstances().catch((e) => this.log.warn('Login', `实例列表拉取失败: ${e.message}`));
    this.persist();
    this.startKeepAlive();
    this.refreshPoints().catch(() => {});
    return { ok: true, account: this.maskAccount(account) };
  }

  // 会话失效且存有密码时自动重登
  async ensureJwt() {
    if (this.authRef.jwt) return this.authRef.jwt;
    if (!this.acc.password) throw new Error('会话已失效，且未保存密码，请在面板重新登录');
    await this.loginWithPassword(this.acc.user, this.acc.password);
    return this.authRef.jwt;
  }

  startKeepAlive() {
    if (!this.acc.features.keepAlive) { this.ka.enabled = false; return; }
    this.ka.enabled = true;
    if (this.authRef.jwt) this.ka.start(this.authRef.jwt);
  }

  stopKeepAlive() {
    this.ka.enabled = false;
    this.ka.stop(true);
  }

  async refreshInstances() {
    if (!this.authRef.jwt) return [];
    const list = await this.ka.listInstances();
    this.acc.instances = list;
    const pick = list.find((x) => x.id === this.acc.instanceId) || list[0] || null;
    if (pick) {
      this.acc.instanceId = pick.id;
      this.acc.instanceName = pick.name || pick.instanceName || 'TeleAgent 云电脑';
      this.acc.instanceStatus = pick.status;
      this.ka.instanceId = pick.id;
      this.ka.instanceStatus = pick.status;
      this.ka.instanceInfo = pick;
    }
    return list;
  }

  async refreshPoints() {
    if (!this.authRef.jwt) return null;
    const r = await this.api.refreshPoints();
    if (r && r.ok) {
      this.acc.stats.points = r.balance;
      this.acc.stats.pointsPlan = r.plan;
    }
    return r;
  }

  async activityCenter() {
    await this.ensureJwt();
    this.api.bindToken(this.authRef.jwt);
    const [uc, promos, task, ctype] = await Promise.allSettled([
      this.api.userCenter(), this.api.activityPromos(), this.api.dayTaskV3(), this.api.campaignType(),
    ]);
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    const err = (r) => (r.status === 'rejected' ? r.reason.message : null);
    const unwrap = (r) => { const v = val(r); return v && v.data !== undefined ? v.data : v; };
    const clean = (x) => String(x == null ? '' : x).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

    const ucD = unwrap(uc) || {};
    const activities = (ucD.activities || []).map((a) => ({
      name: clean(a.name),
      balance: a.balance,
      total: a.total_activity_points,
      remaining: a.remaining_activity_points,
      expireDays: a.expire_days,
      usagePercent: a.usage_percent,
      expiring: typeof a.expire_days === 'number' && a.expire_days <= 7,
    }));

    const promoD = unwrap(promos) || {};
    const campaigns = (promoD.activities || []).map((c) => ({
      id: c.campaign_id,
      name: clean(c.name || c.title || c.activity_title),
      desc: clean(c.desc || c.description || c.activity_subtitle),
      jumpUrl: c.jump_url || '',
      showJump: promoD.show_web_jump !== false,
    }));

    const taskD = unwrap(task) || {};
    const rawAd = taskD.activity_data;
    const arr = Array.isArray(rawAd) ? rawAd : (rawAd ? [rawAd] : []);
    const main = arr.find((x) => x.is_main_activity) || arr[0] || null;
    const subs = arr.filter((x) => x.action_type === 'api');
    const daily = {
      brand: clean(taskD.brand_title),
      main: main ? { name: clean(main.activity_title) || clean(main.name), actionType: main.action_type, status: main.action_status, jumpUrl: main.jump_url } : null,
      sub: subs.map((x) => ({
        name: clean(x.activity_title) || clean(x.name),
        type: x.action_type,
        status: x.action_status,
        jumpUrl: x.jump_url,
      })),
    };

    return {
      ok: !!(uc.status === 'fulfilled' || task.status === 'fulfilled'),
      points: ucD.current_points_balance ?? null,
      plan: ucD.plan_display_name || null,
      maxConcurrent: ucD.max_concurrent_tasks ?? null,
      storeUrl: ucD.company_store_web_url || '',
      benefitUrl: ucD.benefit_url || '',
      activities,
      campaigns,
      daily,
      campaignType: unwrap(ctype) || null,
      expiring: activities.filter((a) => a.expiring),
      errors: [err(uc), err(promos), err(task), err(ctype)].filter(Boolean),
    };
  }

  async pointsDetail(page, pageSize) {
    await this.ensureJwt();
    this.api.bindToken(this.authRef.jwt);
    const r = await this.api.pointsDetail(page, pageSize);
    return (r && r.data !== undefined) ? r.data : r;
  }

  async usageStats(page, pageSize) {
    await this.ensureJwt();
    this.api.bindToken(this.authRef.jwt);
    const [ov, rec] = await Promise.allSettled([this.api.usageOverview(), this.api.usageRecords(page, pageSize)]);
    const unwrap = (r) => (r.status === 'fulfilled' ? ((r.value && r.value.data !== undefined) ? r.value.data : r.value) : { error: r.reason.message });
    return { overview: unwrap(ov) || {}, records: unwrap(rec) || {} };
  }

  async claimDaily() {
    if (this.busy) return { ok: false, error: '该账号有任务进行中' };
    this.busy = true;
    try {
      await this.ensureJwt();
      this.api.bindToken(this.authRef.jwt);
      const today = todayCST();
      if (this.lastSignDate === today) return { ok: true, already: true, message: '今日已领取' };
      const r = await this.api.claimDailyLogin();
      const msg = r && (r.message || (r.data && r.data.message)) || JSON.stringify(r || {}).slice(0, 120);
      const code = r && r.code != null ? String(r.code) : '0';
      const accepted = !(r && r.error) && ['0', '200', '10980001'].includes(code);

      // 双回读：任务状态 + 积分余额（平台有时返回成功但任务未推进）
      let confirmed = false;
      let balance = null;
      for (let i = 0; i < 3 && !confirmed; i++) {
        const [dt, uc] = await Promise.allSettled([this.api.dayTaskV3(), this.api.userCenter()]);
        if (uc.status === 'fulfilled') {
          const b = uc.value && uc.value.data && uc.value.data.current_points_balance;
          if (b != null) balance = b;
        }
        if (dt.status === 'fulfilled') {
          const d = dt.value && dt.value.data;
          const rawAd = d && d.activity_data;
          const arr = Array.isArray(rawAd) ? rawAd : (rawAd ? [rawAd] : []);
          confirmed = arr.some((x) => x.action_type === 'api' && x.action_status === 'completed');
        }
        if (!confirmed && i < 2) await new Promise((res) => setTimeout(res, 2000));
      }
      if (balance != null) this.acc.stats.points = balance;

      const success = accepted;
      if (success) {
        this.lastSignDate = today;
        this.acc.stats.lastSignTime = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
        this.acc.stats.lastSignDate = today;
        this.log.info('Welfare', `每日福利社积分领取${confirmed ? '成功（回读已确认）' : '已提交（回读未确认）'}: ${msg}`);
      } else {
        this.log.warn('Welfare', `每日福利社积分领取返回: ${msg}`);
      }
      this.persist();
      return { ok: success, message: msg };
    } catch (e) {
      this.log.warn('Welfare', `每日福利社积分领取失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      this.busy = false;
    }
  }

  async openDesktop() {
    await this.ensureJwt();
    this.ka.bindToken(this.authRef.jwt);
    if (!this.ka.instanceId) await this.refreshInstances();
    const url = await this.ka.freshConnectUrl();
    return url;
  }

  async power(action) {
    await this.ensureJwt();
    this.ka.bindToken(this.authRef.jwt);
    if (!this.ka.instanceId) await this.refreshInstances();
    if (action === 'poweron' || action === 'start') {
      const r = await this.ka.startInstance();
      this.log.info('Power', '已下发开机（instance/start）');
      return r;
    }
    if (action === 'restart' || action === 'reboot') return this.ka.platformRestart();
    if (action === 'rebuild') return this.ka.platformRebuild();
    if (action === 'cancel') return this.ka.platformCancel();
    throw new Error(`不支持的电源动作: ${action}`);
  }

  async serviceStatus() {
    await this.ensureJwt();
    this.ka.bindToken(this.authRef.jwt);
    return this.ka.pollServiceStatus();
  }

  // 立即跑一轮换票（对应旧面板「立即保活」）
  async kick() {
    await this.ensureJwt();
    this.ka.bindToken(this.authRef.jwt);
    if (!this.ka.instanceId) await this.refreshInstances();
    const url = await this.ka.ticketRound();
    return { ok: !!url, cycles: this.ka.cycles, instanceStatus: this.ka.instanceStatus };
  }

  // 清空登录凭据（保留账号条目，对应旧面板「清除登录」）
  clearCredentials() {
    this.authRef.jwt = null;
    this.acc.jwt = null;
    this.acc.jwtExpiresAt = 0;
    this.acc.password = '';
    this.acc.bound = false;
    this.acc.sessionExpired = true;
    this.stopKeepAlive();
    this.persist();
    this.log.warn('Auth', '已清除登录凭据（JWT + 密码），账号保留');
    return { ok: true };
  }

  status() {
    const acc = this.acc;
    const ins = acc.instances && acc.instances.find((x) => x.id === acc.instanceId);
    return {
      jwt: !!this.authRef.jwt,
      jwtExpiresAt: acc.jwtExpiresAt || null,
      instanceId: acc.instanceId || null,
      instanceName: acc.instanceName || (ins && ins.name) || '',
      instanceStatus: this.ka.instanceStatus != null ? this.ka.instanceStatus : acc.instanceStatus,
      keepAliveState: this.ka.state,
      cycles: this.ka.cycles,
      heartbeats: this.ka.heartbeatCount,
      healed: this.ka.healCount,
      lastError: this.ka.lastError || acc.stats.lastError || '',
      lastTicketAt: this.ka.lastTicketAt,
      points: acc.stats.points,
      pointsPlan: acc.stats.pointsPlan,
      lastSignTime: acc.stats.lastSignTime || '',
      lastSignDate: acc.stats.lastSignDate || '',
    };
  }

  static newId() { return 'ta_' + crypto.randomBytes(4).toString('hex'); }
}

module.exports = { AccountRuntime, todayCST };
