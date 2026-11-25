// 平台 API 模块（只读）：userCenter / points detail / dayTask
'use strict';

const https = require('https');
const { URL } = require('url');

class Api {
  constructor(auth, config, log) {
    this.auth = auth;
    this.config = config;
    this.log = log;
    this.jwt = null;
    this.snap = { balance: null, plan: null, updated_at: null, error: null };
    this._t = null;
  }

  bindToken(jwt) { this.jwt = jwt; }

  pointsSnapshot() { return { ...this.snap }; }

  _req(pathname, timeoutMs = 12000) {
    const base = new URL(this.config.api_base);
    // 关键：base.pathname 含 /superCowork/sapi 前缀，必须拼上（hostname+path 构造会丢弃它）
    const basePath = base.pathname.replace(/\/+$/, '');
    const fullPath = pathname.startsWith('/') ? basePath + pathname : pathname;
    return new Promise((resolve, reject) => {
      if (!this.jwt) return reject(new Error('无会话凭据'));
      const req = https.request({
        hostname: base.hostname,
        port: 443,
        path: fullPath,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TeleAgentDashboard/1.0',
          Accept: 'application/json, text/plain, */*',
          Origin: `https://${base.hostname}`,
          Referer: `https://${base.hostname}/teleagent`,
          Cookie: `operationToken=${this.jwt}`,
        },
        timeout: timeoutMs,
      }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error('会话已失效(401)，等待客户端续期或重新配置'));
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('响应非 JSON')); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      req.on('error', reject);
      req.end();
    });
  }

  async refreshPoints() {
    try {
      const uc = await this._req('/user/portal/companyStore/userCenter');
      const d = (uc && uc.data) || {};
      this.snap = {
        balance: d.current_points_balance ?? null,
        plan: d.plan_display_name || null,
        updated_at: new Date().toISOString(),
        error: null,
      };
      this.log.info('Points', `积分状态已刷新：余额 ${this.snap.balance}${this.snap.plan ? '（' + this.snap.plan + '）' : ''}`);
      return { ok: true, ...this.snap };
    } catch (e) {
      this.snap.error = e.message;
      this.snap.updated_at = new Date().toISOString();
      this.log.warn('Points', `刷新失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // 每日任务数据（活动/领取态的原始信息）
  async dayTask() {
    return this._req('/user/portal/companyStore/v3/checkDayTask?theme=light');
  }

  // ---------- 福利社每日登录积分（API 探测/领取） ----------
  // 页面 https://agent.teleai.com.cn/meter/teleagent/user/portal/star-welfare 的「每日登录积分」
  // 候选 API 探测（GET 版）
  async probeWelfareApis() {
    const candidates = [
      '/user/portal/star-welfare',
      '/user/portal/starWelfare',
      '/user/portal/welfare/daily',
      '/user/portal/companyStore/dailyLogin',
      '/user/portal/companyStore/starWelfare',
      '/user/portal/welfare/status',
      '/user/portal/dailyLogin/status',
    ];
    const results = [];
    for (const p of candidates) {
      try {
        const r = await this._req(p, 8000);
        results.push({ path: p, ok: true, data: JSON.stringify(r).slice(0, 200) });
        this.log.info('Welfare', `探测成功 ${p}: ${JSON.stringify(r).slice(0, 120)}`);
      } catch (e) {
        results.push({ path: p, ok: false, err: e.message });
      }
    }
    return results;
  }

  // 每日任务原始返回（checkDayTask 里可能就有领取态/领取 action 标识）
  async dayTaskRaw() {
    try {
      const r = await this._req('/user/portal/companyStore/v3/checkDayTask?theme=light');
      return r;
    } catch (e) { return { error: e.message }; }
  }

  // ---------- 每日登录积分领取（API 版，替代 UIA） ----------
  // dayTask 返回 action_type:api + jump_url:/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login
  claimDailyLogin() {
    return this._req('/user/portal/companyStore/checkTask?type=daily_login');
  }
}

module.exports = Api;
