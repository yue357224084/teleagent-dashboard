// 模型网关：云电脑节点通过出站 WebSocket 接入，面板对外提供 OpenAI 兼容 /v1
// 节点协议与 shixiangkuangmo/teleagent 的 pool_agent.py 兼容：
//   hello {node_id,name,hostname,version,models,max_inflight}
//   status {upstream,inflight,totals,models}
//   chat {reqId, body} → chat_start {status,contentType} / chat_chunk {data} / chat_end / chat_error
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const WS_PATH = '/api/pool/agent';
const CHAT_TIMEOUT_MS = 300000;

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function newToken(prefix) {
  return prefix + crypto.randomBytes(24).toString('base64url');
}

class Gateway {
  constructor({ dataDir, logbus }) {
    this.dataDir = dataDir;
    this.logbus = logbus;
    this.file = path.join(dataDir, 'gateway.json');
    this.state = this.load();
    this.pending = new Map(); // reqId -> {res, started, contentType, timer}
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      s.nodes = Array.isArray(s.nodes) ? s.nodes : [];
      s.keys = Array.isArray(s.keys) ? s.keys : [];
      s.usage = s.usage && typeof s.usage === 'object' ? s.usage : {};
      for (const n of s.nodes) { n.online = false; n.inflight = 0; n.ws = null; }
      return s;
    } catch {
      return { nodes: [], keys: [], usage: {} };
    }
  }

  save() {
    const clone = JSON.parse(JSON.stringify(this.state));
    for (const n of clone.nodes) { delete n.ws; delete n.online; }
    try {
      fs.writeFileSync(this.file, JSON.stringify(clone, null, 2), { mode: 0o600 });
    } catch (e) { this.logbus.push('Gateway', `网关配置落盘失败: ${e.message}`, 'warning'); }
  }

  // ---------- HTTP 升级 ----------
  attach(httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      let p = '/';
      try { p = new URL(req.url, 'http://x').pathname; } catch { /* 忽略 */ }
      if (p !== WS_PATH) { socket.destroy(); return; }
      const node = this.authNode(req);
      if (!node) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.nodeId = node.id;
        this.wss.emit('connection', ws, req);
      });
    });
  }

  authNode(req) {
    const h = req.headers.authorization || '';
    const token = h.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    return this.state.nodes.find((n) => n.token === token) || null;
  }

  authKey(req) {
    const h = req.headers.authorization || '';
    const key = h.replace(/^Bearer\s+/i, '').trim();
    if (!key) return null;
    return this.state.keys.find((k) => k.key === key && k.enabled !== false) || null;
  }

  onConnection(ws, req) {
    const node = this.state.nodes.find((n) => n.id === ws.nodeId);
    if (!node) { ws.close(); return; }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (buf) => {
      let msg = null;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      this.onMessage(node, ws, msg);
    });
    ws.on('close', () => {
      node.online = false;
      node.inflight = 0;
      node.lastSeen = Date.now();
      if (node.ws === ws) node.ws = null;
      this.logbus.push('Gateway', `节点离线：${node.name}（${node.id}）`, 'warn');
      this.save();
    });
    ws.on('error', () => {});
  }

  onMessage(node, ws, msg) {
    const type = msg.type;
    if (type === 'hello') {
      node.online = true;
      node.ws = ws;
      node.name = msg.name || node.name;
      node.hostname = msg.hostname || '';
      node.version = msg.version || '';
      node.models = Array.isArray(msg.models) ? msg.models : node.models || [];
      node.maxInflight = Number(msg.max_inflight) || 4;
      node.lastSeen = Date.now();
      this.logbus.push('Gateway', `节点上线：${node.name}（${node.hostname}，${node.models.length} 个模型）`, 'success');
      this.save();
      return;
    }
    node.lastSeen = Date.now();
    if (type === 'status') {
      node.upstream = msg.upstream || null;
      node.inflight = Number(msg.inflight) || 0;
      node.models = Array.isArray(msg.models) && msg.models.length ? msg.models : node.models;
      return;
    }
    const entry = this.pending.get(msg.reqId);
    if (!entry) return;
    if (type === 'chat_start') {
      entry.started = true;
      entry.contentType = msg.contentType || 'text/event-stream; charset=utf-8';
      entry.status = Number(msg.status) || 200;
      try {
        entry.res.writeHead(entry.status, {
          'Content-Type': entry.contentType,
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      } catch { /* 已断开 */ }
      return;
    }
    if (type === 'chat_chunk') {
      const data = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
      try { entry.res.write(data); } catch { /* 忽略 */ }
      return;
    }
    if (type === 'chat_end') {
      clearTimeout(entry.timer);
      try { entry.res.end(); } catch { /* 忽略 */ }
      this.pending.delete(msg.reqId);
      this.recordUsage(node.id, entry.model, true);
      return;
    }
    if (type === 'chat_error') {
      clearTimeout(entry.timer);
      this.pending.delete(msg.reqId);
      this.recordUsage(node.id, entry.model, false);
      this.logbus.push('Gateway', `模型请求失败（${node.name}）：${msg.message || 'unknown'}`, 'warn');
      if (!entry.started) {
        try {
          entry.res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          entry.res.end(JSON.stringify({ error: { message: msg.message || 'node error', type: 'upstream_error' } }));
        } catch { /* 忽略 */ }
      } else {
        try { entry.res.end(); } catch { /* 忽略 */ }
      }
    }
  }

  recordUsage(nodeId, model, ok) {
    const day = today();
    const u = this.state.usage[day] || (this.state.usage[day] = { requests: 0, ok: 0, err: 0, byModel: {}, byNode: {} });
    u.requests++;
    u[ok ? 'ok' : 'err']++;
    const m = model || 'unknown';
    u.byModel[m] = (u.byModel[m] || 0) + 1;
    u.byNode[nodeId] = (u.byNode[nodeId] || 0) + 1;
    this.saveSoon();
  }

  saveSoon() {
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.save(); }, 3000);
    this._t.unref && this._t.unref();
  }

  // ---------- 管理 API ----------
  overview() {
    const day = this.state.usage[today()] || { requests: 0, ok: 0, err: 0, byModel: {}, byNode: {} };
    return {
      wsPath: WS_PATH,
      onlineNodes: this.state.nodes.filter((n) => n.online).length,
      totalNodes: this.state.nodes.length,
      models: this.models(),
      usageToday: day,
      nodes: this.state.nodes.map((n) => ({
        id: n.id, name: n.name, hostname: n.hostname, online: !!n.online, models: n.models || [],
        inflight: n.inflight || 0, maxInflight: n.maxInflight || 4,
        upstream: n.upstream, lastSeen: n.lastSeen || null, version: n.version || '',
        tokenHint: String(n.token).slice(0, 12) + '…',
      })),
      keys: this.state.keys.map((k) => ({
        id: k.id, name: k.name, enabled: k.enabled !== false,
        keyHint: String(k.key).slice(0, 10) + '…' + String(k.key).slice(-4), createdAt: k.createdAt,
      })),
    };
  }

  createNode(name) {
    const node = {
      id: 'n_' + crypto.randomBytes(4).toString('hex'),
      name: String(name || '云电脑节点').slice(0, 40),
      token: newToken('sk-node-'),
      models: [], maxInflight: 4, createdAt: Date.now(), online: false, inflight: 0,
    };
    this.state.nodes.push(node);
    this.save();
    this.logbus.push('Gateway', `已创建节点 ${node.name}（${node.id}）`, 'info');
    return node;
  }

  removeNode(id) {
    const i = this.state.nodes.findIndex((n) => n.id === id);
    if (i < 0) return false;
    try { this.state.nodes[i].ws && this.state.nodes[i].ws.close(); } catch { /* 忽略 */ }
    this.state.nodes.splice(i, 1);
    this.save();
    return true;
  }

  rotateNodeToken(id) {
    const n = this.state.nodes.find((x) => x.id === id);
    if (!n) return null;
    n.token = newToken('sk-node-');
    try { n.ws && n.ws.close(); } catch { /* 忽略 */ }
    this.save();
    return n;
  }

  createKey(name) {
    const k = {
      id: 'k_' + crypto.randomBytes(4).toString('hex'),
      name: String(name || '默认 Key').slice(0, 40),
      key: newToken('sk-pool-'), enabled: true, createdAt: Date.now(),
    };
    this.state.keys.push(k);
    this.save();
    this.logbus.push('Gateway', `已创建池 Key ${k.name}`, 'info');
    return k;
  }

  removeKey(id) {
    const i = this.state.keys.findIndex((k) => k.id === id);
    if (i < 0) return false;
    this.state.keys.splice(i, 1);
    this.save();
    return true;
  }

  models() {
    const set = [];
    for (const n of this.state.nodes) {
      if (!n.online) continue;
      for (const m of n.models || []) if (set.indexOf(m) < 0) set.push(m);
    }
    return set;
  }

  pickNode() {
    const cands = this.state.nodes.filter((n) => n.online && n.ws && (n.inflight || 0) < (n.maxInflight || 4));
    if (!cands.length) return null;
    cands.sort((a, b) => (a.inflight || 0) - (b.inflight || 0));
    return cands[0];
  }

  // ---------- /v1 ----------
  async handleV1(req, res, url) {
    const p = url.pathname;
    if (p === '/v1/models' && req.method === 'GET') {
      const data = this.models().map((id) => ({ id, object: 'model', created: 0, owned_by: 'teleagent' }));
      return this.json(res, 200, { object: 'list', data });
    }
    if (p === '/v1/chat/completions' && req.method === 'POST') {
      if (!this.authKey(req)) return this.json(res, 401, { error: { message: 'invalid api key', type: 'auth_error' } });
      const node = this.pickNode();
      if (!node) return this.json(res, 503, { error: { message: '没有可用的云电脑节点（请确认节点在线且未满并发）', type: 'no_node' } });
      let body;
      try { body = await this.readJson(req); } catch (e) { return this.json(res, 400, { error: { message: e.message, type: 'bad_request' } }); }
      const reqId = crypto.randomUUID();
      const entry = { res, model: body && body.model, started: false, model_ok: true };
      entry.timer = setTimeout(() => {
        this.pending.delete(reqId);
        if (!entry.started) this.json(res, 504, { error: { message: '节点超时', type: 'timeout' } });
        else try { res.end(); } catch { /* 忽略 */ }
      }, CHAT_TIMEOUT_MS);
      this.pending.set(reqId, entry);
      try {
        node.ws.send(JSON.stringify({ type: 'chat', reqId, body }));
      } catch (e) {
        clearTimeout(entry.timer);
        this.pending.delete(reqId);
        this.json(res, 502, { error: { message: '节点发送失败: ' + e.message, type: 'node_error' } });
      }
      return undefined;
    }
    if (p === '/v1/models') return this.json(res, 405, { error: { message: 'method not allowed' } });
    return this.json(res, 404, { error: { message: 'not found', type: 'not_found' } });
  }

  json(res, code, obj) {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(b);
  }

  readJson(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
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

  close() {
    for (const n of this.state.nodes) { try { n.ws && n.ws.close(); } catch { /* 忽略 */ } }
    try { this.wss.close(); } catch { /* 忽略 */ }
  }
}

module.exports = { Gateway, WS_PATH };
