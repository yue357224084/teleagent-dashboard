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
    try { return (window.accounts || []).find((a) => a.id === id) || {}; } catch { return {}; }
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

  function openOps(id) {
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
    $('ta-ops-interval').value = String(a.keepaliveInterval || 300);
    const plan = a.restartPlan || {};
    $('ta-ops-plan-on').checked = !!plan.enabled;
    $('ta-ops-plan-mode').value = plan.mode === 'weekly' ? 'weekly' : 'daily';
    $('ta-ops-plan-weekday').value = String(plan.weekday || 0);
    $('ta-ops-plan-time').value = plan.time || '04:30';
    $('ta-ops-out').style.display = 'none';
    openModal('ta-ops-modal');
  }

  function opsOut(text) {
    const el = $('ta-ops-out');
    el.style.display = 'block';
    el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  }

  window.taOp = async function (act) {
    const id = opsAccId;
    if (!id) return;
    const a = accById(id);
    try {
      if (act === 'open') {
        showToast('正在获取官方临时票据…', 'info');
        const r = await authFetch('/api/accounts/' + id + '/web-launch');
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
        const r = await authFetch('/api/accounts/' + id + '/power/restart', { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'rebuild') {
        const v = prompt('重置云电脑服务会清除系统盘安装的软件与数据（历史任务/工作空间/个人设置保留），约 2 分钟。\n确认请输入 RESET：');
        if (v !== 'RESET') return showToast('已取消', 'info');
        const r = await authFetch('/api/accounts/' + id + '/power/rebuild', { method: 'POST' });
        return opsOut(await r.json());
      }
      if (act === 'cancel') {
        const r = await authFetch('/api/accounts/' + id + '/power/cancel', { method: 'POST' });
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

  function injectOpsButtons() {
    document.querySelectorAll('[id^="acc-card-"]').forEach((card) => {
      const tools = card.querySelector('.card-action-tools');
      if (!tools || tools.querySelector('[data-ta-ops]')) return;
      const id = card.id.replace('acc-card-', '');
      const btn = document.createElement('button');
      btn.className = 'btn btn-tool';
      btn.setAttribute('data-ta-ops', '1');
      btn.title = '打开 / 立即保活 / 暂停恢复 / 重启 / 重置 / 取消排队 / 平台状态 / 定时重启 / 凭据';
      btn.textContent = '🔧 实例操作';
      btn.onclick = () => openOps(id);
      tools.appendChild(btn);
    });
  }

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

  function boot() {
    applyTeleagentUi();
    ensureSaveButton();
    sweepUnsupported();
    ensureOpsModal();
    injectOpsButtons();
  }

  document.addEventListener('DOMContentLoaded', boot);
  setInterval(boot, 2000);
})();
