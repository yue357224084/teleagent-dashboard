// TeleAgent 适配层：隐藏不支持的平台/登录方式，并把「添加账号」改写成 TeleAgent 平台登录
// 说明：ctyun-dashboard 前端原生的"扫码/图形验证码/设备码"链路属于天翼云，本后端不提供；
//       TeleAgent 平台的服务端登录会自动过滑块，所以这里只需要手机号 + 密码。
(function () {
  const $ = (id) => document.getElementById(id);

  function hide(el) { if (el) el.style.display = 'none'; }
  function unhide(el) { if (el) el.style.display = ''; }
  function hideGroup(inputId) {
    const el = $(inputId);
    if (!el) return;
    const grp = el.closest('.form-group');
    if (grp) grp.style.display = 'none';
  }

  function applyTeleagentUi() {
    // 只保留"天翼云"槽位，并把名字换成 TeleAgent
    const tabCtyun = $('platform-tab-ctyun');
    if (tabCtyun) tabCtyun.textContent = '🤖 TeleAgent 云电脑';
    hide($('platform-tab-ydpc'));
    hide($('platform-tab-ecloud'));

    // 扫码 tab / 图形验证码 / 设备码 都不适用
    hide($('tab-btn-qrcode'));
    hide($('login-panel-qrcode'));
    const tabs = $('acc-login-tabs');
    if (tabs) tabs.style.display = 'none';
    const pwdPanel = $('login-panel-pwd');
    if (pwdPanel) pwdPanel.classList.remove('hidden');

    hideGroup('acc-captcha-code');
    hideGroup('acc-device-code');

    // 文案改成 TeleAgent 口径
    const userLabel = document.querySelector('label[for="acc-user"]') || ($('acc-user') && $('acc-user').previousElementSibling);
    if (userLabel && /手机号/.test(userLabel.textContent || '')) userLabel.textContent = 'TeleAgent 账号（手机号）*';
    const u = $('acc-user');
    if (u) u.placeholder = '请输入 agent.teleai.com.cn 登录账号';
    const p = $('acc-password');
    if (p) p.placeholder = '请输入 TeleAgent 登录密码（服务端自动过滑块）';
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

  // 原生验证码刷新接口在我们这里不存在，改成空操作避免 404 噪音
  window.refreshModalCaptcha = function () {};
  window.refreshYdpcModalCaptcha = function () {};

  // 隐藏后端没有对应能力的入口（渲染是每 5 秒重绘，所以持续清扫）
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
    sweepUnsupported();
  }

  document.addEventListener('DOMContentLoaded', boot);
  setInterval(boot, 2000);
})();
