// 保活模块 v5：teleagent-manager 实例 API（官方接口表逆向自网页版前端包）
// 机制：每轮先发官方心跳（instance/refresh + instance/heartbeat，活跃信号），
//       再 instance/connect 换票（活跃信号，也是「打开云电脑」入口票据的来源）；
//       自愈——instance/list 发现 status=3(关机)/5(排队) 时 instance/start 拉起。
// 电源相关：instance/restart 重启、instance/rebuild 重置（高危）、instance/cancel 取消排队。
// 鉴权：JWT（页面登录换取）→ Cookie: operationToken=<JWT>
'use strict';

const https = require('https');

const MGR_BASE = 'https://agent.teleai.com.cn/teleagent-manager/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0';

// status 码含义（参考代码注释）
// 100 = 运行中；4 = 运行中(另一种)；3 = 关机；5 = 排队
const STATUS_TEXT = { 100: '运行中', 4: '运行中', 3: '已关机', 5: '排队中' };

class KeepAlive {
  constructor(auth, config, log, notifier) {
    this.auth = auth;
    this.config = config;
    this.log = log;
    this.notifier = notifier || { event: async () => {} };
    this.jwt = null;
    this.instanceId = null;
    this.instanceInfo = null;
    this.enabled = config.keepalive.enabled !== false;
    this.refreshSec = Math.max(60, parseInt(config.keepalive.refreshSec || '300', 10));
    this.ticketMode = (config.keepalive.mode || 'ticket') === 'ticket';
    // 状态
    this.state = 'off'; // off/starting/online/healing/error
    this.lastTicketAt = null;
    this.lastError = '';
    this.cycles = 0;
    this.healCount = 0;
    this.heartbeatCount = 0;
    this.serviceStatusSnap = null; // { ok, http_status, text, at }
    this.instanceStatus = null;
    this.stopped = true;
    this.timer = null;
    this.healing = false;
    this.restartingUntil = 0; // 平台重启窗口内不误判掉线
  }

  status() {
    return {
      enabled: this.enabled,
      mode: this.ticketMode ? 'ticket' : 'claim',
      state: this.state,
      refresh_sec: this.refreshSec,
      instance_id: this.instanceId,
      instance_status: this.instanceStatus,
      instance_status_text: STATUS_TEXT[this.instanceStatus] || null,
      instance_info: this.instanceInfo, // 实例 API 返回的完整详情（名称/规格/到期等，有则展示）
      last_ticket_at: this.lastTicketAt,
      last_ticket_text: this.lastTicketAt ? humanAgo(this.lastTicketAt) : null,
      cycles: this.cycles,
      healed: this.healCount,
      heartbeats: this.heartbeatCount,
      service_status: this.serviceStatusSnap,
      last_error: this.lastError || null,
    };
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) this.start(this.auth.jwt);
    else this.stop(true);
    return { enabled: this.enabled };
  }

  // 外部注入 JWT（auth 模块解密后/续期后调用）
  bindToken(jwt) {
    this.jwt = jwt;
  }

  _headers() {
    return {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Cookie: `operationToken=${this.jwt}`,
      'x-client-platform': 'web',
      Referer: 'https://agent.teleai.com.cn/teleagent',
    };
  }

  _req(method, pathname, body) {
    return new Promise((resolve, reject) => {
      if (!this.jwt) return reject(new Error('无会话凭据'));
      const u = new URL(MGR_BASE);
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname.replace(/\/+$/, '') + pathname,
        method,
        headers: Object.assign(this._headers(), data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        timeout: 20000,
      }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error('会话已失效(401)，等待客户端续期'));
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            const j = JSON.parse(b);
            if (j.error && j.error.code !== 0) return reject(new Error(j.error.message || `code=${j.error.code}`));
            resolve(j);
          } catch { reject(new Error('响应非 JSON')); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async listInstances() {
    const j = await this._req('GET', '/instance/list');
    return j.data || [];
  }

  async resolveInstance() {
    const list = await this.listInstances();
    if (!list.length) throw new Error('账号名下没有实例');
    let ins = this.instanceId ? list.find((x) => x.id === this.instanceId) : list[0];
    if (!ins) ins = list[0];
    this.instanceId = ins.id;
    this.instanceStatus = ins.status;
    this.instanceInfo = ins; // 缓存完整详情供面板展示
    return ins;
  }

  // 换票：活跃信号（ticket 模式核心）
  async connectTicket() {
    const c = await this._req('POST', '/instance/connect', { id: this.instanceId });
    if (!c.data || !c.data.connectURL) throw new Error('connect 未返回 connectURL');
    return c.data.connectURL;
  }

  // 云电脑网页入口（「打开云电脑」用）
  async freshConnectUrl() {
    if (!this.instanceId) await this.resolveInstance();
    return this.connectTicket();
  }

  async startInstance() {
    const r = await this._req('POST', '/instance/start', { id: this.instanceId });
    this.log.info('KeepAlive', `instance/start 已受理${r.data && r.data.status !== undefined ? '（status=' + r.data.status + '）' : ''}`);
    return r.data;
  }

  async waitReady(maxMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const ins = await this.resolveInstance();
        if (ins && (ins.status === 100 || ins.status === 4)) return true;
      } catch { /* 单次失败忽略 */ }
      await sleep(6000);
    }
    return false;
  }

  // 自愈：发现关机/排队 → start 拉起
  async ensureRunning(ins) {
    const st = ins && ins.status;
    this.log.warn('KeepAlive', `实例状态 ${st}（${STATUS_TEXT[st] || '非运行'}），调用 start 拉起…`);
    this.notifier.event('down', '云电脑掉线，正在自动拉起', `实例：${this.instanceId}\n状态：${STATUS_TEXT[st] || st}\n时间：${new Date().toLocaleString('zh-CN')}`);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try {
        await this.startInstance();
      } catch (e) {
        this.log.warn('KeepAlive', `start 第 ${i + 1} 次失败：${e.message}`);
      }
      ok = await this.waitReady(90000);
      if (!ok) await sleep(5000);
    }
    if (!ok) throw new Error('实例拉起超时');
    this.healCount++;
    this.log.info('KeepAlive', '🎉 实例已回到运行中（自愈完成）');
    this.notifier.event('up', '云电脑已自动拉起', `实例：${this.instanceId}\n时间：${new Date().toLocaleString('zh-CN')}`, 1);
  }

  // 一轮 ticket 保活
  async ticketRound() {
    let ins = await this.resolveInstance();
    if (ins.status !== 100 && ins.status !== 4) {
      this.state = 'healing';
      if (Date.now() < this.restartingUntil) {
        this.log.info('KeepAlive', `平台重启进行中（实例${STATUS_TEXT[ins.status] || ins.status}），等待恢复`);
        return null;
      }
      await this.ensureRunning(ins);
    }
    // 官方活跃信号（refresh/heartbeat），失败不阻断换票
    try { await this.sendHeartbeat(); } catch { /* 心跳失败忽略 */ }
    // 换票（带重试：拉起后服务端未备好票会报错）
    let url = null;
    for (let i = 0; i < 3; i++) {
      try {
        url = await this.connectTicket();
        break;
      } catch (e) {
        this.log.warn('KeepAlive', `换票第 ${i + 1} 次失败：${e.message.slice(0, 100)}`);
        await sleep(4000);
      }
    }
    if (!url) throw new Error('换票失败');
    this.lastTicketAt = Date.now();
    this.instanceStatus = 100;
    this.state = 'online';
    this.cycles++;
    this.lastError = '';
    return url;
  }

  async loop() {
    while (!this.stopped) {
      if (!this.enabled) {
        this.state = 'off';
        await sleep(10000);
        continue;
      }
      try {
        await this.ticketRound();
        if (this.cycles === 1 || this.cycles % 6 === 0) {
          this.log.info('KeepAlive', `保活中（第 ${this.cycles} 轮换票，实例${STATUS_TEXT[this.instanceStatus] || this.instanceStatus}）`);
        }
      } catch (e) {
        this.state = 'error';
        this.lastError = e.message;
        this.log.warn('KeepAlive', `本轮保活失败：${e.message.slice(0, 120)}`);
        // 会话失效时立即向 auth 模块要新 JWT
        if (/401|失效|过期/.test(e.message)) {
          this.jwt = this.auth.jwt;
        }
      }
      await sleep(this.refreshSec * 1000);
    }
  }

  start(jwt) {
    if (!this.enabled) { this.log.info('KeepAlive', '保活未启用（配置）'); return; }
    this.jwt = jwt || this.auth.jwt;
    if (!this.jwt) { this.log.warn('KeepAlive', '无凭据，保活未启动'); return; }
    if (!this.stopped) return;
    this.stopped = false;
    this.state = 'starting';
    this.log.info('KeepAlive', `保活启动（模式 ticket，间隔 ${this.refreshSec}s）`);
    this.loop().catch((e) => this.log.error('KeepAlive', `循环异常: ${e.message}`));
  }

  stop(keepDisabled) {
    this.stopped = true;
    clearTimeout(this.timer);
    this.state = 'off';
    if (!keepDisabled) { this.lastTicketAt = null; }
    this.log.info('KeepAlive', '保活已停止');
  }

  async reconnect() {
    // 兼容旧 API：立即触发一轮
    this.stopped = false;
    this.enabled = true;
    try {
      await this.ticketRound();
      this.loop().catch(() => {});
    } catch (e) {
      this.lastError = e.message;
    }
    return { ok: !this.lastError, state: this.state };
  }

  // ---------- 平台远程重启（任意部署模式可用） ----------
  // 接口来自官方前端包（teleagent 网页版）：POST /teleagent-manager/v1/instance/restart
  //   body {"id":"<实例id>"}，与「设置 > 恢复与重置 > 重启云电脑」是同一个动作。
  // 不重装、不影响数据，服务随系统自动启动；remote 部署时不会碰部署机。
  async platformRestart() {
    if (!this.jwt) throw new Error('无会话凭据（先在「账号登录」登录）');
    if (!this.instanceId) await this.resolveInstance();
    this.log.warn('KeepAlive', `调用平台重启接口（instance/restart，实例 ${this.instanceId}）…`);
    const r = await this._req('POST', '/instance/restart', { id: this.instanceId });
    // 重启窗口内（约 3 分钟）不做「掉线自愈」误判
    this.restartingUntil = Date.now() + 180000;
    this.state = 'healing';
    this.notifier.event('restart', '云电脑平台重启已下发', `接口：instance/restart\n实例：${this.instanceId}\n时间：${new Date().toLocaleString('zh-CN')}`, 60);
    this.log.warn('KeepAlive', '平台重启已受理，服务将随系统自动启动');
    return { ok: true, via: 'instance/restart', data: (r && r.data) || null };
  }

  // ---------- 重置云电脑服务（instance/rebuild，高危，页面二次确认后调用） ----------
  // 与官方「设置 > 恢复与重置 > 重置云电脑服务」同一动作：重装服务、恢复运行环境，
  // 历史任务/工作空间/个人设置保留，仅清除系统盘安装的软件与数据，约 2 分钟。
  async platformRebuild() {
    if (!this.jwt) throw new Error('无会话凭据（先在「账号登录」登录）');
    if (!this.instanceId) await this.resolveInstance();
    this.log.warn('KeepAlive', `调用重置接口（instance/rebuild，实例 ${this.instanceId}）…`);
    const r = await this._req('POST', '/instance/rebuild', { id: this.instanceId });
    this.restartingUntil = Date.now() + 300000; // 重置窗口约 5 分钟
    this.state = 'healing';
    this.notifier.event('rebuild', '云电脑重置已下发', `接口：instance/rebuild\n实例：${this.instanceId}\n时间：${new Date().toLocaleString('zh-CN')}\n注意：系统盘安装的软件与数据将被清除。`, 60);
    this.log.warn('KeepAlive', '重置已受理，约 2 分钟完成，历史任务/工作空间/设置保留');
    return { ok: true, via: 'instance/rebuild', data: (r && r.data) || null };
  }

  // ---------- 取消排队（instance/cancel，实例在排队时自救用） ----------
  async platformCancel() {
    if (!this.jwt) throw new Error('无会话凭据（先在「账号登录」登录）');
    if (!this.instanceId) await this.resolveInstance();
    this.log.warn('KeepAlive', `取消排队（instance/cancel，实例 ${this.instanceId}）`);
    const r = await this._req('POST', '/instance/cancel', { id: this.instanceId });
    this.log.warn('KeepAlive', '取消已受理');
    return { ok: true, via: 'instance/cancel', data: (r && r.data) || null };
  }

  // ---------- 平台心跳（instance/refresh / instance/heartbeat，官方活跃信号） ----------
  // 官方网页版停留页面时持续调用 refresh；heartbeat 为显式心跳上报。
  // ticket 模式保留 connect 换票（生成入口 URL 的唯一途径），
  // 每轮先发 refresh/heartbeat 增强活跃信号，失败不阻断换票。
  async sendHeartbeat() {
    if (!this.jwt || !this.instanceId) return { ok: false, skipped: true };
    const results = {};
    for (const ep of ['refresh', 'heartbeat']) {
      try {
        await this._req('POST', `/instance/${ep}`, { id: this.instanceId });
        results[ep] = 'ok';
      } catch (e) {
        results[ep] = e.message.slice(0, 60);
      }
    }
    this.heartbeatCount++;
    this.lastHeartbeatAt = Date.now();
    return { ok: true, results };
  }

  // ---------- 平台服务状态（service/status） ----------
  // 周期查询（由 server 定时调用）+ 状态注入面板
  async pollServiceStatus() {
    try {
      const r = await this._req('GET', '/service/status');
      this.serviceStatusSnap = { ok: true, at: Date.now(), data: (r && r.data) || r || null };
    } catch (e) {
      this.serviceStatusSnap = { ok: false, at: Date.now(), error: e.message.slice(0, 100) };
    }
    return this.serviceStatusSnap;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function humanAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

module.exports = KeepAlive;
