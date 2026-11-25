// ctyun-dashboard 前端所需的数据视图（把 TeleAgent 运行时投影成该前端的账号模型）
'use strict';

const { todayCST } = require('./runtime');

const STATUS_TEXT = { 100: '运行中', 4: '运行中', 3: '已关机', 5: '排队中' };

function desktopView(acc, rt) {
  const list = Array.isArray(acc.instances) && acc.instances.length
    ? acc.instances
    : (acc.instanceId ? [{ id: acc.instanceId, name: acc.instanceName, status: acc.instanceStatus }] : []);
  return list.map((ins) => {
    const spec = String(ins.spec || ins.flavorName || '');
    const m = spec.match(/(\d+)\s*C\s*(\d+)\s*G/i) || spec.match(/(\d+)\s*核\s*(\d+)\s*G/i);
    return {
    objId: String(ins.id || ''),
    desktopId: String(ins.id || ins.instanceId || ''),
    desktopCode: String(ins.id || '').slice(-6).toUpperCase(),
    desktopName: ins.name || ins.instanceName || acc.instanceName || 'TeleAgent 云电脑',
    useStatusText: STATUS_TEXT[ins.status] || '就绪',
    useStatus: ins.status,
    flavorName: ins.spec || ins.flavorName || 'TeleAgent',
    // 平台没给规格时按 4核/8G 展示（与产品默认规格一致）
    cpu: m ? `${m[1]}核` : '4核',
    memory: m ? `${m[2]}G` : '8G',
    osType: ins.os || 'Linux',
    keepaliveEnabled: acc.features.keepAlive !== false,
    taskEnabled: acc.features.autoSign !== false,
    keepaliveInterval: acc.keepaliveInterval || 300,
    };
  });
}

function taskViews(acc, rt) {
  const st = rt.status();
  const doneToday = acc.stats.lastSignDate === todayCST();
  return [
    {
      name: '福利社每日积分',
      points: 100,
      current: doneToday ? 1 : 0,
      total: 1,
      status: doneToday ? 2 : 0,
      completedAt: doneToday ? (acc.stats.lastSignTime || '') : '',
    },
    {
      name: '实例保活（换票）',
      points: 0,
      current: st.keepAliveState === 'online' ? 1 : 0,
      total: 1,
      status: st.keepAliveState === 'online' ? 2 : 0,
      completedAt: st.lastTicketAt ? new Date(st.lastTicketAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '',
    },
  ];
}

function accountView(acc, rt) {
  const st = rt.status();
  const keepOnline = st.keepAliveState === 'online';
  const exp = acc.jwtExpiresAt || 0;
  return {
    id: acc.id,
    platform: 'ctyun',
    ownerId: acc.ownerId || 'u_admin',
    name: acc.name,
    user: acc.user,
    password: '',
    deviceCode: '',
    displayConfig: acc.displayConfig || { width: 2560, height: 1440, scale: 150 },
    enabled: acc.enabled !== false,
    bound: !!st.jwt,
    sessionExpired: !st.jwt,
    createdAt: acc.createdAt,
    features: {
      keepAlive: acc.features.keepAlive !== false,
      autoSign: acc.features.autoSign !== false,
      aiChat: false,
      cloudHang: false,
      autoRedeem: false,
      autoBoot: !!acc.features.autoBoot,
    },
    redeemConfig: {
      enabled: false, targetType: 'redeem', desktopId: '', desktopName: '',
      prodId: 0, prodName: '', prodType: '', costPoints: 0, maxRedeemTimes: 0,
      scheduleType: 'monthly_days', monthlyDays: [-1], intervalDays: 1, lastRedeemDate: '',
    },
    stats: {
      lastSignTime: acc.stats.lastSignTime || '',
      lastAiChatTime: '',
      lastHangTime: '',
      hangMinutesToday: 0,
      points: st.points != null ? st.points : acc.stats.points,
      keepAliveStatus: keepOnline ? 'online' : 'offline',
      lastError: st.lastError || '',
      todaySuccessCount: acc.stats.lastSignDate === todayCST() ? 1 : 0,
      lastSuccessDate: acc.stats.lastSuccessDate || '',
      lastSignDate: acc.stats.lastSignDate || '',
      jwtExpiresAt: exp || null,
      jwtExpiresText: exp ? new Date(exp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '',
      instanceStatusText: STATUS_TEXT[st.instanceStatus] || '',
      pointsPlan: st.pointsPlan || '',
    },
    manualShutdown: false,
    desktops: desktopView(acc, rt),
    keepaliveInterval: acc.keepaliveInterval || 300,
    pulseIntervalSeconds: acc.keepaliveInterval || 300,
    restartPlan: acc.restartPlan || { enabled: false, mode: 'daily', time: '04:30', weekday: 0 },
    liveMetrics: {
      status: keepOnline ? 'online' : 'offline',
      currentHost: keepOnline ? '实例已就绪' : '未建立连接',
      desktopName: st.instanceName || '',
      desktopId: st.instanceId || '',
      keepAliveSeconds: acc.keepaliveInterval || 300,
      cycleCountdown: acc.keepaliveInterval || 300,
      lastHeartbeatTime: st.lastTicketAt ? new Date(st.lastTicketAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '',
      lastHeartbeatResult: keepOnline ? '换票成功' : (st.lastError || '未建立连接'),
      successCount: st.cycles || 0,
      errorCount: st.lastError ? 1 : 0,
      cycles: st.cycles || 0,
      heartbeats: st.heartbeats || 0,
      healed: st.healed || 0,
      instanceStatus: st.instanceStatus,
      officialTasks: taskViews(acc, rt),
      userPoints: st.points != null ? st.points : acc.stats.points,
    },
  };
}

function dashboardStatus(accounts, runtimes) {
  const today = todayCST();
  let signedToday = 0;
  let totalEarned = 0;
  const pointsDetails = [];
  let online = 0;
  for (const acc of accounts) {
    const rt = runtimes(acc);
    const v = accountView(acc, rt);
    if (v.stats.keepAliveStatus === 'online') online++;
    const tasks = v.liveMetrics.officialTasks.map((t) => ({
      name: t.name,
      points: t.points,
      completed: t.status === 2,
      progress: `${t.current}/${t.total}`,
      completedAt: t.completedAt || '',
    }));
    const earned = tasks.filter((t) => t.completed).reduce((s, t) => s + (t.points || 0), 0);
    if (acc.stats.lastSignDate === today) signedToday++;
    totalEarned += earned;
    pointsDetails.push({
      accountId: acc.id,
      accountName: acc.name,
      todayPoints: earned,
      totalPoints: v.stats.points || 0,
      tasks,
    });
  }
  return {
    accountsTotal: accounts.length,
    onlineKeepAlive: online,
    signedToday,
    totalEarnedPoints: totalEarned,
    pointsDetails,
    currentTime: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }),
    isGuest: false,
  };
}

module.exports = { accountView, dashboardStatus, STATUS_TEXT };
