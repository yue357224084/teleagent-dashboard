// 配置存储：data/app_config.json（密码 AES-256-GCM 落盘，密钥 data/.master.key）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CIPHER_RE = /^ENC:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;
const DEFAULT_TITLE = 'TeleAgent 云电脑多账号保活中心';
const DEFAULT_SUBTITLE = '多账号长连接保活 · 每日福利社积分 · 远程电源管理';

function atomicWrite(file, data, mode) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.cfgPath = path.join(dataDir, 'app_config.json');
    this.masterKey = this.loadMasterKey();
    this.cfg = this.load();
  }

  loadMasterKey() {
    const main = path.join(this.dataDir, '.master.key');
    const bak = `${main}.bak`;
    for (const f of [main, bak]) {
      try {
        const raw = fs.readFileSync(f, 'utf8').trim();
        if (/^[0-9a-f]{64}$/i.test(raw)) {
          if (f === bak) atomicWrite(main, raw, 0o600);
          return Buffer.from(raw, 'hex');
        }
      } catch { /* 下一个 */ }
    }
    const key = crypto.randomBytes(32);
    atomicWrite(main, key.toString('hex'), 0o600);
    atomicWrite(bak, key.toString('hex'), 0o600);
    return key;
  }

  encrypt(plain) {
    if (!plain || typeof plain !== 'string') return '';
    if (CIPHER_RE.test(plain)) return plain;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = c.update(plain, 'utf8', 'hex') + c.final('hex');
    return `ENC:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc}`;
  }

  decrypt(cipherText) {
    if (!cipherText || typeof cipherText !== 'string') return '';
    if (!cipherText.startsWith('ENC:')) return cipherText;
    try {
      const [, ivHex, tagHex, data] = cipherText.split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(ivHex, 'hex'));
      d.setAuthTag(Buffer.from(tagHex, 'hex'));
      return d.update(data, 'hex', 'utf8') + d.final('utf8');
    } catch (e) {
      console.error('密码解密失败（主密钥不匹配或密文损坏）:', e.message);
      return '';
    }
  }

  defaults() {
    return {
      version: '1.0.0',
      settings: {
        webPort: Number(process.env.PORT) || 8580,
        keepAliveSeconds: 60,
        pulseIntervalSeconds: 30,
        allowRegistration: false,
        defaultQuota: 20,
        cron: {
          executeTime: '08:05',
          enableSubCron: false,
          signCron: '5 8 * * *',
          aiChatCron: '',
          cloudHangCron: '',
          browserHangCron: '',
          redeemCron: '',
        },
        notify: { enabled: false, channel: 'webhook', webhookUrl: '' },
        systemTitle: DEFAULT_TITLE,
        systemSubtitle: DEFAULT_SUBTITLE,
      },
      users: [],
      accounts: [],
    };
  }

  load() {
    let cfg = null;
    for (const f of [this.cfgPath, `${this.cfgPath}.bak`]) {
      try {
        const txt = fs.readFileSync(f, 'utf8').trim();
        if (txt) { cfg = JSON.parse(txt); break; }
      } catch { /* 下一个 */ }
    }
    const def = this.defaults();
    if (!cfg || typeof cfg !== 'object') cfg = def;
    cfg.settings = { ...def.settings, ...(cfg.settings || {}) };
    cfg.settings.cron = { ...def.settings.cron, ...(cfg.settings.cron || {}) };
    cfg.settings.notify = { ...def.settings.notify, ...(cfg.settings.notify || {}) };
    if (!Array.isArray(cfg.users)) cfg.users = [];
    if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
    for (const acc of cfg.accounts) {
      if (acc.password) acc.password = this.decrypt(acc.password);
      if (acc.jwt) acc.jwt = this.decrypt(acc.jwt);
      acc.stats = acc.stats || {};
      acc.features = { keepAlive: true, autoSign: true, aiChat: false, cloudHang: false, autoRedeem: false, autoBoot: true, ...(acc.features || {}) };
    }
    return cfg;
  }

  save() {
    const clone = JSON.parse(JSON.stringify(this.cfg));
    for (const acc of clone.accounts) {
      if (acc.password) acc.password = this.encrypt(acc.password);
      if (acc.jwt) acc.jwt = this.encrypt(acc.jwt);
    }
    const body = JSON.stringify(clone, null, 2);
    atomicWrite(this.cfgPath, body, 0o600);
    atomicWrite(`${this.cfgPath}.bak`, body, 0o600);
  }

  get settings() { return this.cfg.settings; }
  get users() { return this.cfg.users; }
  get accounts() { return this.cfg.accounts; }
}

module.exports = Store;
