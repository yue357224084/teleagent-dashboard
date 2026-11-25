// 日志总线：内存环形缓冲 + 落盘 jsonl + SSE 广播（ctyun-dashboard 前端消费）
'use strict';

const fs = require('fs');
const path = require('path');

const RING_MAX = 600;

class LogBus {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.ring = [];
    this.seq = 0;
    this.clients = new Set();
  }

  dayStr() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  file() { return path.join(this.dir, `dashboard-${this.dayStr()}.jsonl`); }

  loadRecent(limit = 300) {
    const out = [];
    try {
      const files = fs.readdirSync(this.dir).filter((f) => /^dashboard-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
      for (const f of files) {
        const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
        }
      }
    } catch { /* 无日志 */ }
    this.seq = out.reduce((m, e) => Math.max(m, Number(String(e.id || '').replace('log_', '')) || 0), 0);
    this.ring = out.slice(-RING_MAX);
    return this.ring.slice(-limit);
  }

  push(source, message, level = 'info', accountName = '') {
    const entry = {
      id: `log_${++this.seq}`,
      timestamp: new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }),
      source: String(source || 'System'),
      message: String(message ?? '').slice(0, 2000),
      level: level === 'warning' ? 'warn' : (['info', 'success', 'warn', 'error'].includes(level) ? level : 'info'),
      accountName: accountName || '',
      ts: Date.now(),
      platform: 'ctyun',
    };
    // 同一条消息 90 秒内重复：只加计数，不刷屏（前端按 repeatCount 显示 ×N）
    const last = this.ring[this.ring.length - 1];
    if (last && last.message === entry.message && last.source === entry.source
        && (entry.ts - (last.ts || 0)) < 90000) {
      last.repeatCount = (last.repeatCount || 1) + 1;
      last.timestamp = entry.timestamp;
      last.ts = entry.ts;
      this.broadcast(last, true);
      return last;
    }
    entry.repeatCount = 1;
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.shift();
    try { fs.appendFileSync(this.file(), `${JSON.stringify(entry)}\n`); } catch { /* 磁盘异常不影响主流程 */ }
    this.broadcast(entry, false);
    return entry;
  }

  broadcast(entry, isUpdate) {
    const payload = `data: ${JSON.stringify({ ...entry, isUpdate: !!isUpdate })}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }

  attach(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    for (const e of this.ring.slice(-80)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断开由 close 处理 */ } }, 25000);
    res.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  clear() {
    this.ring = [];
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (/^dashboard-.*\.jsonl$/.test(f)) fs.unlinkSync(path.join(this.dir, f));
      }
    } catch { /* 忽略 */ }
  }
}

module.exports = LogBus;
