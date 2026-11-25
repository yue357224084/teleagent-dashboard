// 电源模块：定时重启计划（统一走平台 instance/restart，重启云电脑本身，不动部署机）
// 重启/重置/取消排队等即时操作由 keepalive 模块提供（server.js 直接路由）。
'use strict';

class Power {
  constructor(config, log, notifier, ka) {
    this.config = config;
    this.log = log;
    this.notifier = notifier || { event: async () => {} };
    this.ka = ka || null; // 注入 KeepAlive：定时计划走 instance/restart
    // 定时重启计划（每日/每周）：平台 instance/restart
    this.plan = Power.normalizePlan(config.power && config.power.restart_plan);
    this.busyCheck = null;   // () => boolean，外部注入（如积分领取进行中则延后）
    this.lastPlanDay = '';   // 当日已触发标记（防重复）
    this.planTimer = setInterval(() => { this.planTick().catch((e) => this.log.error('Power', `计划检查异常: ${e.message}`)); }, 30 * 1000);
    this.planTimer.unref && this.planTimer.unref();
  }

  static normalizePlan(p) {
    if (!p || typeof p !== 'object') return { enabled: false, mode: 'daily', time: '04:30', weekday: 0 };
    const wd = Number(p.weekday);
    return {
      enabled: !!p.enabled,
      mode: p.mode === 'weekly' ? 'weekly' : 'daily',
      time: /^\d{2}:\d{2}$/.test(String(p.time)) ? String(p.time) : '04:30',
      weekday: Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : 0,
    };
  }

  setBusyCheck(fn) { this.busyCheck = fn; }

  applyPlan(p) {
    this.plan = Power.normalizePlan(p);
    this.log.info('Power', `重启计划已更新：${this.planText()}`);
  }

  planText() {
    if (!this.plan.enabled) return '无';
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][this.plan.weekday];
    return this.plan.mode === 'weekly' ? `每周${wd} ${this.plan.time}` : `每日 ${this.plan.time}`;
  }

  // 定时计划检查（每 30 秒）：命中时间点且无冲突 → 调平台 instance/restart 重启云电脑
  async planTick() {
    const p = this.plan;
    if (!p.enabled) return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hm !== p.time) return;
    if (p.mode === 'weekly' && now.getDay() !== p.weekday) return;
    const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (this.lastPlanDay === dayKey) return;
    if (this.busyCheck && this.busyCheck()) {
      this.log.warn('Power', '定时重启：有任务进行中（如积分领取），本轮跳过');
      return;
    }
    this.lastPlanDay = dayKey;
    this.log.warn('Power', `⏰ 定时重启触发：${this.planText()}`);
    if (!this.ka) { this.log.error('Power', '定时重启失败：未注入 keepalive 模块'); return; }
    try {
      await this.ka.platformRestart();
      this.notifier.event('restart-plan', '定时重启执行', `计划：${this.planText()}\n时间：${now.toLocaleString('zh-CN')}\n已调用 instance/restart，约 1 分钟恢复。`, 60);
    } catch (e) {
      this.log.error('Power', `定时重启失败（平台接口）：${e.message}`);
      this.notifier.event('restart-plan-fail', '定时重启失败', `计划：${this.planText()}\n错误：${e.message}`, 10);
    }
  }

  status() {
    return {
      restart_plan: this.plan,
      restart_plan_text: this.planText(),
      plan_available: !!(this.ka && this.ka.jwt),
    };
  }
}

module.exports = Power;
