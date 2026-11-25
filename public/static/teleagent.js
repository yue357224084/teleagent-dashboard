// TeleAgent 适配层：
// 1) 隐藏后端不支持的入口（天翼云扫码/图形验证码/移动云/AI对话/挂机/兑换/关机…）
// 2) 「添加账号」改写成 TeleAgent 平台登录（服务端自动过滑块）
// 3) 注入「实例操作」面板：打开 / 立即保活 / 暂停恢复 / 刷新 / 重启 / 重置 /
//    取消排队 / 平台服务状态 / 保活间隔 / 定时重启 / 重新登录 / 清除凭据
(function () {
  const $ = (id) => document.getElementById(id);

  function hide(el) { if (el) el.style.display = 'none'; }
  function hideGroup(inputId) {
    const el = $(inputId);
    if (!el) return;
    const grp = el.closest('.form-group');
    if (grp) grp.style.display = 'none';
  }

  function applyTeleagentUi() {
    const tabCtyun = $('platform-tab-ctyun');
    if (tabCtyun) tabCtyun.textContent = '🤖 TeleAgent 云电脑';
    hide($('platform-tab-ydpc'));
    hide($('platform-tab-ecloud'));
    hide($('tab-btn-qrcode'));
    hide($('login-panel-qrcode'));
    const tabs = $('acc-login-tabs');
    if (tabs) tabs.style.display = 'none';
    const pwdPanel = $('login-panel-pwd');
    if (pwdPanel) pwdPanel.classList.remove('hidden');
    hideGroup('acc-captcha-code');
    hideGroup('acc-device-code');

    const userLabel = $('acc-user') && $('acc-user').previousElementSibling;
    if (userLabel && /手机号/.test(userLabel.textContent || '')) userLabel.textContent = 'TeleAgent 账号（手机号）*';
    const u = $('acc-user');
    if (u) u.placeholder = '请输入 agent.teleai.com.cn 登录账号';
    const p = $('acc-password');
    if (p) p.placeholder = '请输入 TeleAgent 登录密码（服务端自动过滑块）';

    // 保存按钮：原逻辑只在切到「密码登录」tab 时显示，我们把 tab 藏了，需手动切一次
    forcePwdTab();
    const title = $('modal-account-title');
    if (title) {
      const want = (($('acc-id') || {}).value || '') ? '编辑 TeleAgent 账号' : '添加 TeleAgent 账号';
      if (title.textContent !== want) title.textContent = want;
    }
  }

  // 覆盖原生保存：TeleAgent 不需要图形验证码
  window.saveAccount = async function () {
    const accId = ($('acc-id') || {}).value || '';
    const name = (($('acc-name') || {}).value || '').trim();
    const user = (($('acc-user') || {}).value || '').trim();
    const password = (($('acc-password') || {}).value || '').trim();

    if (!user) { showToast('请填写 TeleAgent 账号（手机号）', 'error'); return; }
    if (!accId && !password) { showToast('请填写登录密码', 'error'); return; }

    showToast(accId ? '正在更新账号…' : '正在登录 TeleAgent 平台（自动过滑块），请稍候…', 'info');
    try {
      let res;
      if (accId) {
        const body = { name: name || user };
        if (password) body.password = password;
        res = await authFetch(`/api/accounts/${accId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await authFetch('/api/accounts/teleagent/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name || user, account: user, password }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        closeModal('account-modal');
        showToast(accId ? '账号已更新' : '🎉 登录成功，已添加并纳入保活', 'success');
        if (typeof checkCurrentUser === 'function') checkCurrentUser();
        if (typeof loadAccounts === 'function') loadAccounts();
      } else {
        showToast('❌ ' + (data.error || '登录失败'), 'error');
      }
    } catch (e) {
      showToast('请求异常: ' + e.message, 'error');
    }
  };

  window.refreshModalCaptcha = function () {};
  window.refreshYdpcModalCaptcha = function () {};

  // 原逻辑：切到「扫码」tab 会隐藏保存按钮；我们把扫码 tab 藏了，这里强制走密码模式
  function forcePwdTab() {
    const btnSave = $('btn-save-account-pwd');
    const panelQr = $('login-panel-qrcode');
    const panelPwd = $('login-panel-pwd');
    if (panelQr) panelQr.classList.add('hidden');
    if (panelPwd) panelPwd.classList.remove('hidden');
    if (btnSave) {
      btnSave.style.display = 'inline-block';
      if (btnSave.textContent !== '登录并添加') btnSave.textContent = '登录并添加';
    }
  }

  const origSwitch = window.switchAccountLoginTab;
  window.switchAccountLoginTab = function () {
    if (typeof origSwitch === 'function') {
      try { origSwitch('pwd'); } catch { /* 忽略原实现异常 */ }
    }
    forcePwdTab();
  };

  // 原保存按钮的显示/隐藏由 app.js 多处控制，容易又被 setAttribute 掉；
  // 这里额外注入一个自己的按钮，彻底不依赖原逻辑
  function ensureSaveButton() {
    const footer = document.querySelector('#account-modal .modal-footer');
    if (!footer) return;
    let btn = footer.querySelector('[data-ta-save]');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.setAttribute('data-ta-save', '1');
      btn.textContent = '登录并添加';
      btn.onclick = () => window.saveAccount();
      footer.appendChild(btn);
    }
    const isEdit = !!((($('acc-id') || {}).value) || '').trim();
    const want = isEdit ? '保存修改' : '登录并添加';
    if (btn.textContent !== want) btn.textContent = want;
    btn.style.display = 'inline-block';
    // 原按钮隐藏掉，避免出现两个保存
    const orig = $('btn-save-account-pwd');
    if (orig) orig.style.display = 'none';
  }

  const origOpenAdd = window.openAddAccountModal;
  window.openAddAccountModal = function () {
    if (typeof origOpenAdd === 'function') {
      try { origOpenAdd(); } catch { /* 忽略原实现异常 */ }
    }
    applyTeleagentUi();
    forcePwdTab();
    const title = $('modal-account-title');
    if (title) title.textContent = '添加 TeleAgent 账号';
  };

  // 「领取福利社积分」只跑 sign（AI 对话/挂机/兑换在本平台没有对应接口）
  window.syncAccountTasks = async function (accId) {
    try {
      const r = await authFetch('/api/accounts/' + accId + '/run/sign', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      showToast(d.message || '福利社积分领取已触发', r.ok ? 'success' : 'error');
      setTimeout(() => { if (typeof loadAccounts === 'function') loadAccounts(true); }, 1500);
    } catch (e) {
      showToast('请求异常: ' + e.message, 'error');
    }
  };

  // ---------- 实例操作面板 ----------
  let opsAccId = '';

  function accById(id) {
    // app.js 里是 `let accounts`（顶层 let 不挂在 window 上），只能按标识符访问
    try {
      if (typeof accounts !== 'undefined' && Array.isArray(accounts)) {
        return accounts.find((a) => a.id === id) || {};
      }
    } catch { /* 忽略 */ }
    return {};
  }

  function ensureOpsModal() {
    if ($('ta-ops-modal')) return;
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="modal-backdrop hidden" id="ta-ops-modal">
        <div class="modal" style="max-width: 560px;">
          <div class="modal-header">
            <h3 id="ta-ops-title">实例操作</h3>
            <button class="modal-close" onclick="closeModal('ta-ops-modal')">&times;</button>
          </div>
          <div class="modal-body">
            <div id="ta-ops-info" style="font-size: 12.5px; color: #334155; background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; line-height: 1.7;"></div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
              <span style="font-size:12.5px;">实例</span>
              <select class="form-control" id="ta-ops-inst" style="width:auto;padding:4px 8px;max-width:62%;"></select>
              <button class="btn btn-sm" onclick="taOp('primary')" title="设为保活主实例">设为主实例</button>
              <button class="btn btn-sm" onclick="taOp('create')" title="instance/create（参数与配额由平台校验）">➕ 创建实例</button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button class="btn btn-tool" onclick="taOp('open')">🚀 打开云电脑</button>
              <button class="btn btn-tool" onclick="taOp('kick')">🎫 立即保活</button>
              <button class="btn btn-tool" onclick="taOp('toggle')">⏸ 暂停 / 恢复保活</button>
              <button class="btn btn-tool" onclick="taOp('refresh')">🔄 刷新状态</button>
              <button class="btn btn-warning" onclick="taOp('restart')">♻️ 重启云电脑</button>
              <button class="btn btn-danger" onclick="taOp('rebuild')">💣 重置云电脑服务</button>
              <button class="btn btn-tool" onclick="taOp('cancel')">⏹ 取消排队</button>
              <button class="btn btn-tool" onclick="taOp('service')">📊 平台服务状态</button>
            </div>
            <div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
              <span style="font-size:12.5px;">保活间隔</span>
              <select class="form-control" id="ta-ops-interval" style="width:auto; padding:4px 8px;">
                <option value="60">1 分钟</option>
                <option value="300">5 分钟（推荐）</option>
                <option value="600">10 分钟</option>
                <option value="1800">30 分钟</option>
              </select>
              <button class="btn btn-sm" onclick="taOp('interval')">保存</button>
            </div>
            <div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
              <label style="font-size:12.5px; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" id="ta-ops-plan-on"> 定时重启
              </label>
              <select class="form-control" id="ta-ops-plan-mode" style="width:auto; padding:4px 8px;">
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
              <select class="form-control" id="ta-ops-plan-weekday" style="width:auto; padding:4px 8px;">
                <option value="0">周日</option><option value="1">周一</option><option value="2">周二</option>
                <option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option>
              </select>
              <input type="time" class="form-control" id="ta-ops-plan-time" style="width:auto; padding:4px 8px;" value="04:30">
              <button class="btn btn-sm" onclick="taOp('plan')">保存</button>
            </div>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <button class="btn btn-sm" onclick="taOp('relogin')">🔑 重新登录</button>
              <button class="btn btn-sm btn-danger" onclick="taOp('logout')">清除登录凭据</button>
            </div>
            <pre id="ta-ops-out" style="display:none; margin-top:10px; max-height:180px; overflow:auto; font-size:11.5px; background:#0f172a; color:#e2e8f0; padding:8px 10px; border-radius:6px;"></pre>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host.firstElementChild);
  }

  window.openOps = function openOps(id) {
    ensureOpsModal();
    opsAccId = id;
    const a = accById(id);
    const s = a.stats || {};
    const lm = a.liveMetrics || {};
    const d = (a.desktops || [])[0] || {};
    const firstTask = (lm.officialTasks || [])[0] || {};
    $('ta-ops-title').textContent = '实例操作 · ' + (a.name || a.user || id);
    $('ta-ops-info').innerHTML = [
      '实例：<b>' + (d.desktopName || '—') + '</b>（' + (d.useStatusText || '未知') + '）',
      '规格：' + (d.flavorName || 'TeleAgent') + ' · ' + (d.cpu || '4核') + '/' + (d.memory || '8G'),
      '保活：' + (s.keepAliveStatus === 'online' ? '🟢 在线' : '⚪ 离线') + ' · 间隔 ' + (a.keepaliveInterval || 300) + 's · 已换票 ' + (lm.cycles || 0) + ' 轮',
      '积分：<b>' + (s.points != null ? s.points : '—') + '</b>' + (s.pointsPlan ? '（' + s.pointsPlan + '）' : '') + ' · 今日福利社：' + (firstTask.status === 2 ? '✅ 已领' : '⏳ 未领'),
      '凭据有效期至：' + (s.jwtExpiresText || '—'),
    ].join('<br>');
    const instSel = $('ta-ops-inst');
    if (instSel) {
      const ds = a.desktops || [];
      instSel.innerHTML = ds.length
        ? ds.map((d) => `<option value="${d.desktopId}">${d.desktopName || d.desktopId}（${d.useStatusText || '未知'}）</option>`).join('')
        : '<option value="">（无实例）</option>';
      const primary = (a.stats && a.stats.instanceId) || (ds[0] && ds[0].desktopId) || '';
      if (primary) instSel.value = primary;
      if (!instSel.value && ds[0]) instSel.value = ds[0].desktopId;
    }
    $('ta-ops-interval').value = String(a.keepaliveInterval || 300);
    const plan = a.restartPlan || {};
    $('ta-ops-plan-on').checked = !!plan.enabled;
    $('ta-ops-plan-mode').value = plan.mode === 'weekly' ? 'weekly' : 'daily';
    $('ta-ops-plan-weekday').value = String(plan.weekday || 0);
    $('ta-ops-plan-time').value = plan.time || '04:30';
    $('ta-ops-out').style.display = 'none';
    openModal('ta-ops-modal');
  };

  function opsOut(text) {
    const el = $('ta-ops-out');
    el.style.display = 'block';
    el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  }

  window.taOp = async function (act) {
    const id = opsAccId;
    if (!id) return;
    const a = accById(id);
    const inst = ($('ta-ops-inst') || {}).value || '';
    const instQ = inst ? '?desktopId=' + encodeURIComponent(inst) : '';
    try {
      if (act === 'open') {
        showToast('正在获取官方临时票据…', 'info');
        const r = await authFetch('/api/accounts/' + id + '/web-launch' + instQ);
        const d = await r.json();
        if (d.directViewUrl) { window.open(d.directViewUrl, '_blank'); showToast('已在新标签打开云电脑', 'success'); }
        else showToast('打开失败: ' + (d.error || '无票据'), 'error');
        return;
      }
      if (act === 'kick') {
        const r = await authFetch('/api/accounts/' + id + '/run/keepalive-now', { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'toggle') {
        const want = !(a.features && a.features.keepAlive !== false);
        const r = await authFetch('/api/accounts/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ features: { keepAlive: want } }),
        });
        const d = await r.json();
        showToast(want ? '保活已恢复' : '保活已暂停', 'success');
        if (typeof loadAccounts === 'function') loadAccounts(true);
        return opsOut(d);
      }
      if (act === 'refresh') {
        const r = await authFetch('/api/accounts/' + id + '/run/refresh', { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'restart') {
        if (!confirm('重启云电脑（instance/restart，约 1 分钟恢复，不影响数据）？')) return;
        const r = await authFetch('/api/accounts/' + id + '/power/restart' + instQ, { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'rebuild') {
        const v = prompt('重置云电脑服务会清除系统盘安装的软件与数据（历史任务/工作空间/个人设置保留），约 2 分钟。\n确认请输入 RESET：');
        if (v !== 'RESET') return showToast('已取消', 'info');
        const r = await authFetch('/api/accounts/' + id + '/power/rebuild' + instQ, { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'cancel') {
        const r = await authFetch('/api/accounts/' + id + '/power/cancel' + instQ, { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'service') {
        const r = await authFetch('/api/accounts/' + id + '/service-status');
        return opsOut(await r.json());
      }
      if (act === 'interval') {
        const iv = Number($('ta-ops-interval').value) || 300;
        const r = await authFetch('/api/accounts/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keepaliveInterval: iv }),
        });
        showToast('保活间隔已设为 ' + iv + 's', 'success');
        return opsOut(await r.json());
      }
      if (act === 'plan') {
        const plan = {
          enabled: $('ta-ops-plan-on').checked,
          mode: $('ta-ops-plan-mode').value,
          weekday: Number($('ta-ops-plan-weekday').value) || 0,
          time: $('ta-ops-plan-time').value || '04:30',
        };
        const r = await authFetch('/api/accounts/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restartPlan: plan }),
        });
        showToast(plan.enabled ? '定时重启已保存' : '定时重启已关闭', 'success');
        return opsOut(await r.json());
      }
      if (act === 'primary') {
        if (!inst) return showToast('没有可选实例', 'error');
        const r = await authFetch('/api/accounts/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: inst }) });
        showToast('已设为保活主实例', 'success');
        if (typeof loadAccounts === 'function') loadAccounts(true);
        return opsOut(await r.json());
      }
      if (act === 'create') {
        const raw = prompt('instance/create 参数（JSON，留空提交空对象）。注意：接口未实测，配额与参数由平台校验，可能产生资源占用。', '{}');
        if (raw === null) return;
        let payload = {};
        try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { return showToast('JSON 不合法: ' + e.message, 'error'); }
        if (!confirm('确认调用 instance/create？')) return;
        const r = await authFetch('/api/accounts/' + id + '/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }) });
        return opsOut(await r.json());
      }
      if (act === 'relogin') {
        const r = await authFetch('/api/accounts/' + id + '/run/relogin', { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'logout') {
        if (!confirm('清除该账号的 JWT 与已保存密码？账号条目保留，之后需要重新输入密码。')) return;
        const r = await authFetch('/api/accounts/' + id + '/logout', { method: 'POST' });
        if (typeof loadAccounts === 'function') loadAccounts(true);
        return opsOut(await r.json());
      }
    } catch (e) {
      showToast('操作失败: ' + e.message, 'error');
      opsOut('操作失败: ' + e.message);
    }
  };

  // 隐藏后端没有对应能力的入口（渲染每 5 秒重绘，所以持续清扫）
  function sweepUnsupported() {
    document.querySelectorAll('.feature-row').forEach((row) => {
      const t = row.textContent || '';
      if (/AI\s*智能对话|云电脑挂机|自动兑换|抽奖|自动开机守护/.test(t)) row.style.display = 'none';
    });
    document.querySelectorAll('button').forEach((b) => {
      const t = (b.textContent || '').trim();
      if (/积分商城|短信二次安全绑定|重新扫码授权|扫码重授权/.test(t)) b.style.display = 'none';
      if (/^🛡️\s*守护|^守护:/.test(t)) b.style.display = 'none';
      if (/^🔴\s*关机/.test(t)) b.style.display = 'none';
    });
  }


  // ---------- 模型网关（云电脑节点 + OpenAI 兼容 /v1） ----------
  let gwState = null;

  function ensureGwModal() {
    if ($('ta-gw-modal')) return;
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="modal-backdrop hidden" id="ta-gw-modal">
        <div class="modal" style="max-width: 720px; max-height: 86vh; overflow: auto;">
          <div class="modal-header">
            <h3>模型网关 · OpenAI 兼容 /v1</h3>
            <button class="modal-close" onclick="closeModal('ta-gw-modal')">&times;</button>
          </div>
          <div class="modal-body">
            <div id="ta-gw-summary" style="font-size:12.5px;line-height:1.8;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
              <button class="btn btn-sm btn-primary" onclick="taGwCreateNode()">+ 添加云电脑节点</button>
              <button class="btn btn-sm" onclick="taGwCreateKey()">+ 创建池 Key</button>
              <button class="btn btn-sm" onclick="taGwRefresh()">刷新</button>
            </div>
            <div id="ta-gw-out" style="display:none;background:#0f172a;color:#e2e8f0;border-radius:6px;padding:8px 10px;font-size:11.5px;white-space:pre-wrap;word-break:break-all;margin-bottom:10px;max-height:180px;overflow:auto;"></div>
            <h4 style="font-size:13px;margin:6px 0;">节点</h4>
            <div id="ta-gw-nodes" style="font-size:12.5px;"></div>
            <h4 style="font-size:13px;margin:14px 0 6px;">池 Key</h4>
            <div id="ta-gw-keys" style="font-size:12.5px;"></div>
            <div style="margin-top:12px;font-size:12px;color:var(--text-muted);line-height:1.7;">
              客户端填：Base URL <code id="ta-gw-base"></code>，API Key = 池 Key，模型 = 节点上报的模型名。
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host.firstElementChild);
  }

  function gwOut(text) {
    const el = $('ta-gw-out');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  }

  async function refreshGw() {
    const r = await authFetch('/api/gateway/overview');
    const d = await r.json();
    gwState = d;
    const summary = $('ta-gw-summary');
    if (summary) {
      summary.innerHTML = [
        '在线节点：<b>' + d.onlineNodes + '/' + d.totalNodes + '</b>',
        '模型：' + ((d.models || []).join(', ') || '（节点未上报）'),
        '今日请求：<b>' + ((d.usageToday && d.usageToday.requests) || 0) + '</b>（成功 ' + ((d.usageToday && d.usageToday.ok) || 0) + ' / 失败 ' + ((d.usageToday && d.usageToday.err) || 0) + '）',
        'WebSocket 路径：<code>' + d.wsPath + '</code>',
      ].join('<br>');
    }
    const base = $('ta-gw-base');
    if (base) base.textContent = location.origin + '/v1';
    const nodesEl = $('ta-gw-nodes');
    if (nodesEl) {
      nodesEl.innerHTML = (d.nodes || []).length ? d.nodes.map((n) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
          <div style="min-width:0;">
            <b>${n.online ? '🟢' : '⚪'} ${n.name}</b>
            <span style="color:var(--text-muted);font-size:11.5px;"> ${n.hostname || ''} ${n.version ? 'v' + n.version : ''}</span><br>
            <span style="font-size:11.5px;color:var(--text-muted);">${n.id} · 并发 ${n.inflight}/${n.maxInflight} · 模型 ${(n.models || []).join(',') || '—'}</span>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn btn-sm" onclick="taGwRotate('${n.id}')" title="换 Token（会断开当前连接）">🔄</button>
            <button class="btn btn-sm btn-danger" onclick="taGwDelNode('${n.id}')" title="删除节点">🗑️</button>
          </div>
        </div>`).join('') : '<div style="color:var(--text-muted);">还没有节点。点「添加云电脑节点」，然后在云电脑里按提示运行节点程序。</div>';
    }
    const keysEl = $('ta-gw-keys');
    if (keysEl) {
      keysEl.innerHTML = (d.keys || []).length ? d.keys.map((k) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
          <div><b>${k.name}</b><br><span style="font-size:11.5px;color:var(--text-muted);">${k.keyHint} · 创建于 ${new Date(k.createdAt).toLocaleString('sv-SE')}</span></div>
          <button class="btn btn-sm btn-danger" onclick="taGwDelKey('${k.id}')">🗑️</button>
        </div>`).join('') : '<div style="color:var(--text-muted);">还没有池 Key。点「创建池 Key」生成一个给客户端用。</div>';
    }
    return d;
  }

  window.taGwRefresh = () => refreshGw().catch((e) => gwOut('刷新失败: ' + e.message));

  window.openGateway = async function () {
    ensureGwModal();
    openModal('ta-gw-modal');
    try { await refreshGw(); } catch (e) { gwOut('加载失败: ' + e.message); }
  };

  window.taGwCreateNode = async function () {
    const name = prompt('节点名称（例如：云电脑-7713）', '云电脑节点');
    if (name === null) return;
    const r = await authFetch('/api/gateway/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (!r.ok) return gwOut(d);
    gwOut(['节点已创建，Token 只显示这一次：', '', 'node-id : ' + d.id, 'token   : ' + d.token, '', '在云电脑里执行：',
      'python pool_agent.py --server ws://' + location.host + d.wsPath + ' --node-id ' + d.id + ' --token ' + d.token].join('\n'));
    refreshGw().catch(() => {});
  };

  window.taGwRotate = async function (id) {
    if (!confirm('换 Token 会立即断开该节点的当前连接，需要在云电脑里用新 Token 重启节点。继续？')) return;
    const r = await authFetch('/api/gateway/nodes/' + id + '/rotate', { method: 'POST' });
    const d = await r.json();
    if (d.token) gwOut('新 Token（只显示这一次）：\n' + d.token);
    refreshGw().catch(() => {});
  };

  window.taGwDelNode = async function (id) {
    if (!confirm('删除该节点？')) return;
    await authFetch('/api/gateway/nodes/' + id, { method: 'DELETE' });
    refreshGw().catch(() => {});
  };

  window.taGwCreateKey = async function () {
    const name = prompt('池 Key 名称', '默认 Key');
    if (name === null) return;
    const r = await authFetch('/api/gateway/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (!r.ok) return gwOut(d);
    gwOut(['池 Key 已创建，只显示这一次：', '', d.key, '', '客户端填：', 'Base URL: ' + location.origin + '/v1', 'API Key : ' + d.key].join('\n'));
    refreshGw().catch(() => {});
  };

  window.taGwDelKey = async function (id) {
    if (!confirm('删除该池 Key？使用它的客户端会立即失效。')) return;
    await authFetch('/api/gateway/keys/' + id, { method: 'DELETE' });
    refreshGw().catch(() => {});
  };

  function injectGatewayButton() {
    if ($('ta-gw-fab')) return;
    const b = document.createElement('button');
    b.id = 'ta-gw-fab';
    b.className = 'btn btn-sm';
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    b.textContent = '🔌 模型网关';
    b.onclick = () => window.openGateway();
    document.body.appendChild(b);
  }


  // ---------- 活动中心（活动 / 积分明细 / 用量 / 每日任务） ----------
  let actAccId = '';

  function ensureActModal() {
    if ($('ta-act-modal')) return;
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="modal-backdrop hidden" id="ta-act-modal">
        <div class="modal" style="max-width: 760px; max-height: 88vh; overflow: auto;">
          <div class="modal-header">
            <h3>🎁 活动中心</h3>
            <button class="modal-close" onclick="closeModal('ta-act-modal')">&times;</button>
          </div>
          <div class="modal-body">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
              <select class="form-control" id="ta-act-acc" style="width:auto;padding:4px 8px;" onchange="taActSwitch(this.value)"></select>
              <button class="btn btn-sm" onclick="taActLoad()">刷新</button>
              <button class="btn btn-sm btn-primary" onclick="taActClaim()">🎁 立即领取每日积分</button>
            </div>
            <div id="ta-act-body" style="font-size:12.5px;line-height:1.7;"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host.firstElementChild);
  }

  function actAccounts() {
    try { return (typeof accounts !== 'undefined' && Array.isArray(accounts)) ? accounts : []; } catch { return []; }
  }

  window.openActivity = async function () {
    ensureActModal();
    const sel = $('ta-act-acc');
    const list = actAccounts();
    sel.innerHTML = list.map((a) => `<option value="${a.id}">${a.name || a.user}</option>`).join('');
    actAccId = actAccId && list.some((x) => x.id === actAccId) ? actAccId : (list[0] && list[0].id) || '';
    if (actAccId) sel.value = actAccId;
    openModal('ta-act-modal');
    if (actAccId) await window.taActLoad();
    else $('ta-act-body').innerHTML = '<div style="color:var(--text-muted)">还没有账号，先在面板里添加。</div>';
  };

  window.taActSwitch = function (id) { actAccId = id; window.taActLoad().catch(() => {}); };

  window.taActLoad = async function () {
    if (!actAccId) return;
    const body = $('ta-act-body');
    body.innerHTML = '<div style="color:var(--text-muted)">加载中…</div>';
    const r = await authFetch('/api/accounts/' + actAccId + '/activity');
    const d = await r.json();
    if (!r.ok || !d.success) { body.innerHTML = '<div style="color:#dc2626">加载失败：' + (d.error || r.status) + '</div>'; return; }
    renderActivity(d.data);
    window.taActLoadPoints(1);
    window.taActLoadUsage();
    window.taActLoadNotify();
  };

  function renderActivity(d) {
    const body = $('ta-act-body');
    const exp = (d.expiring || []).map((a) => `<b>${a.name}</b> 剩 ${a.expireDays} 天（${a.balance} 分）`).join('；');
    const acts = (d.activities || []).map((a) => `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;${a.expiring ? 'border-color:#fca5a5;background:#fef2f2;' : ''}">
        <div><b>${a.name}</b><br><span style="color:var(--text-muted);font-size:11.5px;">总额 ${a.total ?? '—'} · 剩余 ${a.remaining ?? '—'} · 已用 ${a.usagePercent || '—'}</span></div>
        <div style="text-align:right;flex-shrink:0;"><b style="color:#2563eb;">${a.balance ?? '—'}</b><br><span style="font-size:11.5px;color:${a.expiring ? '#dc2626' : 'var(--text-muted)'};">${a.expireDays != null ? a.expireDays + ' 天后过期' : ''}</span></div>
      </div>`).join('') || '<div style="color:var(--text-muted);">无活动数据</div>';

    const camps = (d.campaigns || []).map((c) => `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
        <div><b>${c.name || ('活动 ' + c.id)}</b><br><span style="color:var(--text-muted);font-size:11.5px;">${c.desc || ''}</span></div>
        ${c.jumpUrl ? `<a class="btn btn-sm" href="${c.jumpUrl.startsWith('http') ? c.jumpUrl : 'https://agent.teleai.com.cn' + c.jumpUrl}" target="_blank" rel="noreferrer">去参与</a>` : ''}
      </div>`).join('') || '<div style="color:var(--text-muted);">无活动页</div>';

    const daily = d.daily || {};
    const subs = (daily.sub || []).map((x) => `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 10px;border-radius:6px;background:${x.status === 'completed' ? '#f0fdf4' : '#f8fafc'};margin-bottom:4px;">
        <span>${x.name}</span><span style="color:${x.status === 'completed' ? '#16a34a' : '#d97706'};">${x.status === 'completed' ? '✅ 已完成' : '⏳ 待完成'}</span>
      </div>`).join('');

    body.innerHTML = `
      ${exp ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:8px 10px;margin-bottom:10px;color:#b91c1c;">⚠️ 积分即将过期：${exp}</div>` : ''}
      <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:12px;">
        当前积分 <b style="font-size:16px;color:#2563eb;">${d.points ?? '—'}</b>
        ${d.plan ? '（' + d.plan + '）' : ''} · 最大并发任务 ${d.maxConcurrent ?? '—'}
        ${d.storeUrl ? ' · <a href="' + d.storeUrl + '" target="_blank" rel="noreferrer">积分商城</a>' : ''}
        ${d.benefitUrl ? ' · <a href="' + d.benefitUrl + '" target="_blank" rel="noreferrer">权益中心</a>' : ''}
      </div>
      <h4 style="font-size:13px;margin:10px 0 6px;">📅 今日任务</h4>
      ${subs || '<div style="color:var(--text-muted);">无每日任务</div>'}
      <h4 style="font-size:13px;margin:14px 0 6px;">🔥 我的活动</h4>
      ${acts}
      <h4 style="font-size:13px;margin:14px 0 6px;">🎯 活动页</h4>
      ${camps}
      <h4 style="font-size:13px;margin:14px 0 6px;">🧾 积分明细</h4>
      <div id="ta-act-points" style="color:var(--text-muted);">加载中…</div>
      <h4 style="font-size:13px;margin:14px 0 6px;">🔔 通知中心 <span id="ta-act-unread" style="color:#dc2626;font-size:11.5px;"></span>
        <button class="btn btn-sm" style="margin-left:6px;padding:2px 8px;font-size:11.5px;" onclick="taActNotifyAll()">全部已读</button>
      </h4>
      <div id="ta-act-notify" style="color:var(--text-muted);">加载中…</div>
      <h4 style="font-size:13px;margin:14px 0 6px;">📊 用量统计</h4>
      <div id="ta-act-usage" style="color:var(--text-muted);">加载中…</div>
      ${(d.errors || []).length ? `<div style="margin-top:10px;font-size:11.5px;color:#d97706;">部分接口异常：${d.errors.join('；')}</div>` : ''}
    `;
  }

  window.taActLoadPoints = async function (page) {
    const el = $('ta-act-points');
    if (!el) return;
    const r = await authFetch('/api/accounts/' + actAccId + '/points?page=' + (page || 1) + '&pageSize=10');
    const d = await r.json();
    if (!d.success) { el.innerHTML = '<span style="color:#dc2626">积分明细加载失败</span>'; return; }
    const data = d.data || {};
    const groups = data.groups || [];
    if (!groups.length) { el.innerHTML = '<span style="color:var(--text-muted)">暂无记录</span>'; return; }
    el.innerHTML = groups.map((g) => `
      <div style="margin-bottom:8px;">
        <div style="font-weight:700;margin-bottom:4px;">${g.type === 'campaign' ? '活动积分' : (g.type || '积分')}</div>
        ${(g.active || []).map((a) => `
          <div style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;">
            <div style="display:flex;justify-content:space-between;"><b>${a.name}</b><span>剩余 <b style="color:#2563eb;">${a.balance}</b> / ${a.totalQuota}</span></div>
            <div style="font-size:11.5px;color:var(--text-muted);">${a.effectiveStart || ''} ~ ${a.effectiveEnd || ''}</div>
            ${(a.subItems || []).map((s) => `<div style="font-size:11.5px;color:var(--text-muted);">· ${s.name || ''} ${s.totalQuota != null ? '总额 ' + s.totalQuota : ''} ${s.used != null ? '已用 ' + s.used : ''}</div>`).join('')}
          </div>`).join('')}
      </div>`).join('');
  };

  window.taActLoadUsage = async function () {
    const el = $('ta-act-usage');
    if (!el) return;
    const r = await authFetch('/api/accounts/' + actAccId + '/usage?page=1&pageSize=8');
    const d = await r.json();
    if (!d.success) { el.innerHTML = '<span style="color:#dc2626">用量加载失败</span>'; return; }
    const ov = (d.data && d.data.overview) || {};
    const rec = (d.data && d.data.records) || {};
    const list = rec.list || (rec.data && rec.data.list) || [];
    el.innerHTML = `
      <div style="margin-bottom:6px;">任务数 <b>${ov.taskCount ?? '—'}</b> · 调用次数 <b>${ov.callCount ?? '—'}</b> · 消耗积分 <b>${ov.pointsUsed ?? '—'}</b></div>
      ${list.length ? list.map((x) => `<div style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;display:flex;justify-content:space-between;gap:8px;"><span>${x.model || ''} <span style="color:var(--text-muted);font-size:11.5px;">${x.categoryName || ''}</span></span><span style="font-size:11.5px;">${x.totalUsage ?? ''} · ${x.statTime || ''}</span></div>`).join('') : '<div style="color:var(--text-muted);">暂无调用记录</div>'}
    `;
  };

  window.taActLoadNotify = async function () {
    const el = $('ta-act-notify');
    if (!el) return;
    const r = await authFetch('/api/accounts/' + actAccId + '/notifications?page=1&pageSize=8');
    const d = await r.json();
    if (!d.success) { el.innerHTML = '<span style="color:#dc2626">通知加载失败</span>'; return; }
    const un = d.data.unread || 0;
    const badge = $('ta-act-unread');
    if (badge) badge.textContent = un ? '(' + un + ' 未读)' : '';
    const items = d.data.items || [];
    el.innerHTML = items.length ? items.map((n) => `
      <div style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;${n.read ? 'opacity:.6;' : ''}">
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${n.title || '(无标题)'}</b>
          <span style="font-size:11.5px;color:var(--text-muted);flex-shrink:0;">${(n.createdAt || '').slice(0, 16)}</span>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);max-height:44px;overflow:hidden;">${(n.content || '').slice(0, 120)}</div>
        ${n.read ? '' : `<button class="btn btn-sm" style="margin-top:3px;padding:1px 8px;font-size:11px;" onclick="taActNotifyRead('${n.id}')">标记已读</button>`}
      </div>`).join('') : '<div style="color:var(--text-muted);">没有通知</div>';
  };

  window.taActNotifyRead = async function (id) {
    await authFetch('/api/accounts/' + actAccId + '/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    window.taActLoadNotify().catch(() => {});
  };

  window.taActNotifyAll = async function () {
    await authFetch('/api/accounts/' + actAccId + '/notifications/read-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    window.taActLoadNotify().catch(() => {});
  };

  window.taActClaim = async function () {
    if (!actAccId) return;
    showToast('正在领取每日积分…', 'info');
    const r = await authFetch('/api/accounts/' + actAccId + '/run/sign', { method: 'POST' });
    const d = await r.json();
    showToast(d.message || '已触发领取', r.ok ? 'success' : 'error');
    setTimeout(() => { window.taActLoad().catch(() => {}); if (typeof loadAccounts === 'function') loadAccounts(true); }, 4000);
  };

  function injectActivityButton() {
    if ($('ta-act-fab')) return;
    const b = document.createElement('button');
    b.id = 'ta-act-fab';
    b.className = 'btn btn-sm';
    b.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    b.textContent = '🎁 活动中心';
    b.onclick = () => window.openActivity();
    document.body.appendChild(b);
  }

  function boot() {
    applyTeleagentUi();
    ensureSaveButton();
    sweepUnsupported();
    ensureOpsModal();
    ensureGwModal();
    injectGatewayButton();
    ensureActModal();
    injectActivityButton();
  }

  document.addEventListener('DOMContentLoaded', boot);
  setInterval(boot, 2000);
})();
