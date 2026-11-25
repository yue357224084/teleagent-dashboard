'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Store = require('../lib/store');
const LogBus = require('../lib/logbus');

test('密码加密落盘后可解密回原文，且磁盘上是密文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-store-'));
  const store = new Store(dir);
  store.cfg.accounts.push({ id: 'ta_1', name: 'a', user: 'u', password: 'p@ss', jwt: 'tok', features: {}, stats: {} });
  store.save();

  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'app_config.json'), 'utf8'));
  assert.match(disk.accounts[0].password, /^ENC:/);
  assert.match(disk.accounts[0].jwt, /^ENC:/);

  const reloaded = new Store(dir);
  assert.equal(reloaded.cfg.accounts[0].password, 'p@ss');
  assert.equal(reloaded.cfg.accounts[0].jwt, 'tok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('日志总线：级别归一化、平台标记 ctyun、重复消息合并计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-log-'));
  const bus = new LogBus(dir);
  bus.push('KeepAlive', '换票成功', 'warning', '账号A');
  const e = bus.push('KeepAlive', '换票成功', 'warning', '账号A');
  assert.equal(e.level, 'warn');
  assert.equal(e.platform, 'ctyun');
  assert.ok((e.repeatCount || 1) >= 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('账号视图：desktops 来自实例列表，任务状态与积分映射正确', () => {
  const { accountView } = require('../lib/views');
  const acc = {
    id: 'ta_1', name: '账号A', user: '13800000000', features: { keepAlive: true, autoSign: true },
    stats: { points: 6198.37, lastSignDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), lastSignTime: '2026-11-25 08:05:00' },
    instances: [{ id: 'inst-1', name: 'Agent 云电脑', status: 100, spec: '4C8G' }],
    instanceId: 'inst-1', keepaliveInterval: 300,
  };
  const rt = { status: () => ({ jwt: true, keepAliveState: 'online', instanceStatus: 100, instanceId: 'inst-1', cycles: 3, heartbeats: 3, healed: 0, points: 6198.37 }) };
  const v = accountView(acc, rt);
  assert.equal(v.id, 'ta_1');
  assert.equal(v.desktops[0].desktopId, 'inst-1');
  assert.equal(v.desktops[0].cpu, '4核');
  assert.equal(v.stats.keepAliveStatus, 'online');
  assert.equal(v.liveMetrics.officialTasks[0].status, 2); // 今日已领
  assert.equal(v.liveMetrics.userPoints, 6198.37);
});
