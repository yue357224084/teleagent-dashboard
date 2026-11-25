// 登录模块：TeleAgent（天翼星辰）账号密码登录 → 换取 operationToken（JWT）
// 移植自社区逆向 teleagent-keepalive v1.3.0（2026-11 抓包复原）：
//   1. GET  /upms/public/auth/getRsaPublicKey   取 RSA 公钥 + keyId
//   2. POST /upms/public/captcha/get            blockPuzzle 滑块图（本地解码识别缺口，自动通过）
//   3. POST /upms/public/auth/accountNameLogin  密码装在 AES-128-GCM 密文里（密钥经 RSA-OAEP 封装）
//   4. GET  登录返回的 redirectUri（带 code）  → Set-Cookie: operationToken
// 密码本地加密存储：AES-256-GCM（密钥 = data/.secret，随机生成，data/ 不入库）
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const API = 'https://www.teleai.com.cn/teleai-api';
const SUPER_CLIENT_ID = 'Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi';
const SUPER_REDIRECT = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?source=4&state=https://agent.teleai.com.cn/teleagent';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0';
const REFERER = 'https://www.teleai.com.cn/master-auth';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => Buffer.from(b).toString('base64');

class Login {
  constructor(dataDir, log) {
    this.dataDir = dataDir;
    this.log = log;
  }

  jwtPath() { return path.join(this.dataDir, 'jwt.txt'); }

  // ---------- HTTP ----------
  async req(url, { method = 'POST', body, headers = {}, redirect } = {}) {
    const h = { 'User-Agent': UA, Origin: 'https://www.teleai.com.cn', Referer: REFERER, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    try {
      return await fetch(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: redirect || 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new Error(`请求超时（20s）：${new URL(url).host}，部署机到该域名网络不通或过慢`);
      }
      if (e.cause && e.cause.code) throw new Error(`网络错误 ${e.cause.code}: ${new URL(url).host}`);
      throw e;
    }
  }

  readSetCookies(headers) {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const value = headers.get('set-cookie');
    return value ? [value] : [];
  }

  mergeCookies(jar, headers) {
    for (const cookie of this.readSetCookies(headers)) {
      const pair = String(cookie).split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) {
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        // The callback sends one valid domain-wide operationToken followed by
        // host-scoped deletion cookies with the same name. This jar is keyed
        // by name only, so an empty deletion cookie must not erase the token.
        if (name === 'operationToken' && value === '' && jar[name]) continue;
        jar[name] = value;
      }
    }
    return jar;
  }

  cookieHeader(jar) {
    return Object.entries(jar).map(([name, value]) => name + '=' + value).join('; ');
  }

  async postJson(p, body) {
    const res = await this.req(API + p, { body });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${p} 响应非 JSON（HTTP ${res.status}）`);
    }
  }

  // ---------- 极简 PNG 解码（8bit 非隔行 RGB/RGBA，够用于滑块图） ----------
  decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
    let off = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.slice(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        bitDepth = data[8]; colorType = data[9];
        if (data[12] !== 0) throw new Error('不支持隔行 PNG');
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error('不支持的 PNG 格式');
    const ch = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * ch;
    const out = Buffer.alloc(height * stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const line = raw.slice(pos, pos + stride); pos += stride;
      const cur = out.slice(y * stride, (y + 1) * stride);
      const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch] : 0;
        const b = prev[x];
        const c = x >= ch ? prev[x - ch] : 0;
        let v = line[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[x] = v & 0xff;
      }
    }
    return { width, height, ch, data: out };
  }

  // 找原图里白色描边的拼图缺口，返回拖拽距离（缺口左上角 x - 2）
  solveOffset(origPng) {
    const img = this.decodePng(origPng);
    const { width, height, ch, data } = img;
    const isWhite = (x, y) => {
      const i = (y * width + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      return Math.min(r, g, b) > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 18;
    };
    const seen = new Uint8Array(width * height);
    let best = null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (seen[y * width + x] || !isWhite(x, y)) continue;
        const stack = [[x, y]];
        seen[y * width + x] = 1;
        let n = 0, minX = x, minY = y;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          n++;
          if (cx < minX) minX = cx;
          if (cy < minY) minY = cy;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              if (seen[ny * width + nx]) continue;
              if (!isWhite(nx, ny)) continue;
              seen[ny * width + nx] = 1;
              stack.push([nx, ny]);
            }
          }
        }
        if (n > 60 && (!best || n > best.n)) best = { n, x: minX, y: minY };
      }
    }
    if (!best) throw new Error('滑块图未识别到缺口');
    return Math.max(0, best.x - 2);
  }

  aesEcbBase64(key, plain) {
    const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
    return b64(Buffer.concat([c.update(plain, 'utf8'), c.final()]));
  }

  // ---------- 滑块（最多 6 轮；间隔 2s 避免触发风控） ----------
  async solveCaptcha() {
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(2000);
      const r = await this.postJson('/upms/public/captcha/get', { captchaType: 'blockPuzzle' });
      const d = r && r.repData;
      if (!d || !d.originalImageBase64) throw new Error('验证码图获取失败');
      let x;
      try {
        x = this.solveOffset(Buffer.from(d.originalImageBase64, 'base64'));
      } catch (e) {
        this.log.warn('Login', `滑块图识别失败（第 ${i + 1} 次）：${e.message}，换一张`);
        continue;
      }
      const pointJson = JSON.stringify({ x, y: 5 });
      const check = await this.postJson('/upms/public/captcha/check', {
        captchaType: 'blockPuzzle',
        pointJson: this.aesEcbBase64(d.secretKey, pointJson),
        token: d.token,
      });
      if (check && check.repCode === '0000') {
        this.log.info('Login', `滑块已自动通过（x=${x}，第 ${i + 1} 次）`);
        return { captchaVerification: this.aesEcbBase64(d.secretKey, `${d.token}---${pointJson}`) };
      }
      this.log.warn('Login', `滑块校验未通过（x=${x}），换一张重试（第 ${i + 1} 次）`);
    }
    throw new Error('滑块连续 6 次未通过');
  }

  // ---------- 账号密码登录 → operationToken ----------
  // 参数组合（实测逆向）：redirectUri 指向 agent 域 superCowork，登录成功后回跳该地址时
  // 服务端 Set-Cookie: operationToken（agent JWT）；回跳官网只会种 operToken（官网会话，非目标）
  async loginByPassword(account, password) {
    if (!account || !password) throw new Error('账号或密码为空');
    account = String(account).trim().toLowerCase();  // AAD 绑定：服务端按小写账号解密

    const keyRes = await this.req(`${API}/upms/public/auth/getRsaPublicKey`, { method: 'GET' }).then((r) => r.json());
    if (!keyRes || keyRes.code !== '10980001') throw new Error(`获取公钥失败: ${keyRes && keyRes.message}`);
    const { publicKey, keyId } = keyRes.data;

    const captcha = await this.solveCaptcha();

    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const timestamp = Date.now();
    const requestId = crypto.randomUUID();
    const aad = `loginName=${account}&keyId=${keyId}&timestamp=${timestamp}&requestId=${requestId}&clientId=${SUPER_CLIENT_ID}`;

    const gcm = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    gcm.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([gcm.update(password, 'utf8'), gcm.final()]);
    const tag = gcm.getAuthTag();

    const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    const encryptedKeyIv = crypto.publicEncrypt(
      { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.concat([aesKey, iv]),
    );

    const body = {
      loginName: account,
      keyId,
      timestamp,
      requestId,
      redirectUri: SUPER_REDIRECT,
      clientId: SUPER_CLIENT_ID,
      encryptedKeyIv: b64(encryptedKeyIv),
      ciphertext: b64(ct),
      tag: b64(tag),
      invitationCode: '',
      captchaCheckResult: captcha,
      publicKey,
    };

    // 登录请求改用原生 fetch：需要捕获响应 Set-Cookie（凭据 operToken 种在 cookie 里）
    const loginRes = await this.req(`${API}/upms/public/auth/accountNameLogin`, {
      method: 'POST',
      body,
      headers: { Origin: 'https://www.teleai.com.cn', Referer: REFERER },
    });
    const login = await loginRes.json().catch(() => null);
    if (!login || login.code !== '10980001') {
      const msg = (login && login.message) || '登录失败';
      const code = login && login.code;
      const err = new Error(code ? `${msg}（code=${code}）` : msg);
      err.code = code;
      throw err;
    }
    const data = login.data || {};
    this.log.info('Login', `密码校验通过，账号 ${account}`);

    // 正确链路（参考代码验证）：请求里声明了 redirectUri=superCowork，登录成功后
    // 服务端返回 data.redirectUri = superCowork 入口 + ?code=xxx（一次性票据）
    // GET 回跳它 → agent 域验 code → Set-Cookie: operationToken（云电脑 JWT）
    // 注意：登录响应本身也会 Set-Cookie: operToken（官网会话），不要用那个
    const redirect = data.redirectUri || SUPER_REDIRECT;
    if (!redirect.includes('agent.teleai.com.cn')) {
      throw new Error('服务端返回的回跳地址不是 agent 域（' + redirect.slice(0, 60) + '），superCowork 通道可能已变更');
    }
    const jar = this.mergeCookies({}, loginRes.headers);
    const cbRes = await this.req(redirect, {
      method: 'GET',
      headers: { Cookie: this.cookieHeader(jar) },
      redirect: 'manual',
    });
    this.mergeCookies(jar, cbRes.headers);
    if (!jar.operationToken) {
      // 回跳可能 302 到 agent 域下一站，跟随跳转链直到拿到
      const loc = cbRes.headers.get('location');
      if (cbRes.status >= 300 && cbRes.status < 400 && loc) {
        const token = await this.followRedirectForToken(loc, jar);
        return { operationToken: token, expiresAt: data.expiresAt || 0, refreshToken: data.refreshToken || '' };
      }
      throw new Error(`回跳未拿到 operationToken（状态 ${cbRes.status}，无跳转头）`);
    }
    this.log.info('Login', '已换取 operationToken（agent 域回跳）');
    return { operationToken: jar.operationToken, expiresAt: data.expiresAt || 0, refreshToken: data.refreshToken || '' };
  }

  // 跟随跳转链 → operationToken（登录回跳未直接 Set-Cookie 时的兜底；cookie 跨跳累积）
  async followRedirectForToken(startUrl, initialCookies = {}) {
    let current = startUrl;
    const jar = { ...initialCookies };
    const trace = [];
    for (let hop = 0; hop < 10 && current; hop++) {
      let res;
      try {
        res = await fetch(current, {
          method: 'GET',
          headers: {
            'User-Agent': UA,
            Cookie: this.cookieHeader(jar),
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        throw new Error(`跳转链请求失败（${new URL(current).host}）: ${e.message}`);
      }
      const cookieNames = this.readSetCookies(res.headers).map((c) => String(c).split("=")[0].trim());
      trace.push(`${hop + 1}:${res.status} ${new URL(current).host}${new URL(current).pathname} cookies=[${cookieNames.join(",")}]`);
      this.mergeCookies(jar, res.headers);
      if (jar.operationToken) {
        this.log.info('Login', `跳转链已获得 operationToken（${hop + 1} 跳）`);
        return jar.operationToken;
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      const html = await res.text();
      const m = html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)
        || html.match(/location\.replace\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m) { current = new URL(m[1], current).toString(); continue; }
      break;
    }
    throw new Error(`跳转链未拿到 operationToken | ${trace.join(" | ").slice(0, 400)}`);
  }

  // ---------- 本地密码加密存储（AES-256-GCM，密钥在 data/.secret） ----------
  loadSecret() {
    const f = path.join(this.dataDir, '.secret');
    try {
      return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    } catch (e) {
      const k = crypto.randomBytes(32);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
      return k;
    }
  }

  encryptPassword(plain) {
    if (!plain) return '';
    const key = this.loadSecret();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', b64(iv), b64(ct), b64(c.getAuthTag())].join(':');
  }

  decryptPassword(blob) {
    if (!blob) return '';
    const [ver, ivB, ctB, tagB] = String(blob).split(':');
    if (ver !== 'v1') return '';
    const key = this.loadSecret();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
  }

}

module.exports = Login;
