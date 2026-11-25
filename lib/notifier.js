// 通知：settings.notify 配置的通用 webhook（POST JSON），带 90 秒去重
'use strict';

class Notifier {
  constructor(store, logbus) {
    this.store = store;
    this.logbus = logbus;
    this.last = new Map();
  }

  async send(title, text, { dedupeSec = 0 } = {}) {
    const cfg = this.store.settings.notify || {};
    if (!cfg.enabled || !cfg.webhookUrl) return { ok: false, skipped: true };
    const key = title + '|' + text;
    if (dedupeSec) {
      const lastAt = this.last.get(key) || 0;
      if (Date.now() - lastAt < dedupeSec * 1000) return { ok: false, skipped: true };
      this.last.set(key, Date.now());
    }
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text, timestamp: new Date().toISOString() }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (e) {
      this.logbus.push('Notify', `webhook 推送失败: ${e.message}`, 'warning');
      return { ok: false, error: e.message };
    }
  }

  // KeepAlive 模块期望的 event 接口
  event(kind, title, text, dedupeSec = 0) {
    return this.send(`[${kind}] ${title}`, text, { dedupeSec });
  }
}

module.exports = Notifier;
