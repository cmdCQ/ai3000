/* 后台管理 v3 */

let admToken = localStorage.getItem('sqw_admin_token');
let admExpiry = parseInt(localStorage.getItem('sqw_admin_expiry') || '0');
let _deleteTarget = null; // 待确认删除目标

document.addEventListener('DOMContentLoaded', () => {
  if (admToken && Date.now() < admExpiry) {
    verifyAdmin().then(ok => ok ? showDash() : showLogin());
  } else {
    clearAuth();
  }

  // 登录
  document.getElementById('admLoginForm').addEventListener('submit', doLogin);

  // 退出
  document.getElementById('admLogout').addEventListener('click', () => {
    clearAuth(); showLogin();
  });

  // 侧栏 Tab
  document.querySelectorAll('.adm-nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('.adm-nav-item').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
      const tab = item.dataset.tab;
      document.querySelectorAll('.adm-tab').forEach(x => x.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');
      if (tab === 'users') loadUsers();
      else if (tab === 'charts') loadChartUsers();
      else if (tab === 'divination') loadDivUsers();
      else if (tab === 'suggestions') loadSugUsers();
      else if (tab === 'books') loadBooks();
      else if (tab === 'prompts') loadPrompts();
      else if (tab === 'dashboard') loadDashboard();
    });
  });

  // 修改密码
  document.getElementById('btnChangePwd').addEventListener('click', openPwdModal);
  document.getElementById('pwdForm').addEventListener('submit', doChangePwd);

  // 时钟
  setInterval(() => {
    const el = document.getElementById('admClock');
    if (el) el.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  }, 1000);

  // 设置页服务器时间
  updateSettingTime();
});

// ========================= 认证 =========================

function clearAuth() {
  admToken = null; admExpiry = 0;
  localStorage.removeItem('sqw_admin_token');
  localStorage.removeItem('sqw_admin_expiry');
}

async function adminFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + admToken };
  return fetch('/api/admin' + path, { ...opts, headers });
}

async function verifyAdmin() {
  try { const r = await adminFetch('/verify'); return r.ok; }
  catch { return false; }
}

function showLogin() {
  document.getElementById('admLogin').style.display = 'flex';
  document.getElementById('admDash').style.display = 'none';
}

function showDash() {
  document.getElementById('admLogin').style.display = 'none';
  document.getElementById('admDash').style.display = 'block';
  loadDashboard();
}

async function doLogin(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const err = document.getElementById('admLoginErr');
  const username = document.getElementById('admUsername').value.trim();
  const password = document.getElementById('admPassword').value;

  if (!username || !password) { err.textContent = '请输入用户名和密码'; return; }
  btn.disabled = true; btn.textContent = '验证中…'; err.textContent = '';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');
    admToken = data.token;
    admExpiry = Date.now() + 23 * 60 * 60 * 1000;
    localStorage.setItem('sqw_admin_token', admToken);
    localStorage.setItem('sqw_admin_expiry', admExpiry.toString());
    showDash();
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false; btn.textContent = '进入后台';
  }
}

// ========================= 仪表盘 =========================

async function loadDashboard() {
  try {
    const [statsRes, chartsRes] = await Promise.all([
      adminFetch('/stats'),
      adminFetch('/charts'),
    ]);
    const stats = await statsRes.json();
    const charts = chartsRes.ok ? await chartsRes.json() : [];

    document.getElementById('statTotal').textContent = stats.totalUsers || 0;
    document.getElementById('statToday').textContent = stats.todayUsers || 0;
    document.getElementById('statAI').textContent = stats.totalAI || 0;
    document.getElementById('statActive').textContent = stats.active7d || 0;
    document.getElementById('statCharts').textContent = charts.length || 0;
    document.getElementById('statDivination').textContent = stats.totalDivinations || 0;

    // 活跃率
    const total = stats.totalUsers || 1;
    const pct = ((stats.active7d || 0) / total * 100).toFixed(1);
    document.getElementById('statActiveSub').textContent = '占比 ' + pct + '%';

    // 人均命盘
    const avg = total > 0 ? (charts.length / total).toFixed(1) : '0';
    document.getElementById('statTotalSub').textContent = '人均 ' + avg + ' 盘';
  } catch (e) {
    console.error('Dashboard load failed', e);
  }
}

// ========================= 用户 =========================

var tierNames = { 0:'普通', 1:'普通会员', 2:'SVIP' };
var allUsers = [];
var allTiers = {};

function filterUsers() {
  var q = (document.getElementById('usersSearch').value || '').trim().toLowerCase();
  var tbody = document.getElementById('usersTbody');
  var filtered = q ? allUsers.filter(function(u) {
    var phone = (u.phone || u.username || '').toLowerCase();
    return phone.indexOf(q) !== -1;
  }) : allUsers;
  renderUsers(filtered);
}

function renderUsers(users) {
  var tbody = document.getElementById('usersTbody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">暂无匹配用户</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(function(u) {
    var phone = u.phone || u.username || '—';
    var tierInfo = allTiers[phone] || {};
    var currentTier = tierInfo.tier !== undefined ? tierInfo.tier : 0;
    var tokenUsed = u.tokenUsed || 0;
    return '<tr>' +
      '<td class="mono">' + esc(phone) + '</td>' +
      '<td class="dim">' + fmtDate(u.createdAt) + '</td>' +
      '<td>' + (u.chartCount || 0) + '</td>' +
      '<td>' + (u.aiCount || 0) + '</td>' +
      '<td class="mono">' + fmtToken(tokenUsed) + '</td>' +
      '<td>' + renderTierSelect(phone, currentTier) + '</td>' +
      '<td class="dim">' + fmtRel(u.lastActive) + '</td>' +
      '<td class="adm-td-right">' +
        '<button class="adm-btn-sm" onclick="editToken(\'' + escAttr(phone) + '\', ' + tokenUsed + ')" style="margin-right:0.3rem">Token</button>' +
        '<button class="adm-del-btn" onclick="confirmDeleteUser(\'' + escAttr(phone) + '\')">删除</button></td>' +
      '</tr>';
  }).join('');
}

async function loadUsers() {
  const tbody = document.getElementById('usersTbody');
  const meta = document.getElementById('usersMeta');
  tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">加载中…</td></tr>';

  try {
    const [usersRes, chartsRes, tiersRes] = await Promise.all([
      adminFetch('/users'),
      adminFetch('/charts'),
      adminFetch('/user-tiers'),
    ]);
    const users = await usersRes.json();
    const charts = chartsRes.ok ? await chartsRes.json() : [];
    allTiers = tiersRes.ok ? await tiersRes.json() : {};

    // 统计每个用户的命盘数
    const chartCount = {};
    charts.forEach(c => { chartCount[c.userId] = (chartCount[c.userId] || 0) + 1; });
    // 合并命盘数到用户对象
    allUsers = users.map(function(u) {
      var phone = u.phone || u.username || '';
      u.chartCount = chartCount[phone] || 0;
      return u;
    });

    meta.textContent = '共 ' + allUsers.length + ' 人';
    document.getElementById('usersSearch').value = '';
    renderUsers(allUsers);
  } catch (e) {
    console.error('Load users failed', e);
    tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">加载失败，请重试</td></tr>';
  }
}

function renderTierSelect(username, currentTier) {
  var opts = '';
  for (var t = 0; t <= 2; t++) {
    opts += '<option value="' + t + '"' + (t === currentTier ? ' selected' : '') + '>' + tierNames[t] + '</option>';
  }
  var id = 'tsel_' + username.replace(/[^0-9]/g, '_');
  return '<select id="' + id + '" class="adm-tier-select" onchange="setUserTier(\'' + escAttr(username) + '\', this)">' + opts + '</select>';
}

async function setUserTier(username, sel) {
  var tier = parseInt(sel.value);
  sel.disabled = true;
  try {
    var res = await adminFetch('/user-tier', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, tier }),
    });
    if (!res.ok) { alert('设置失败'); return; }
  } catch(e) {
    alert('设置失败');
  } finally {
    sel.disabled = false;
  }
}

// ========================= 命盘（用户分组 → 点击看详情 → 跳转页面） =========================

async function loadChartUsers() {
  var grid = document.getElementById('chartsCardGrid');
  var meta = document.getElementById('chartsMeta');
  grid.innerHTML = '<div class="adm-card-empty">加载中…</div>';

  try {
    var res = await adminFetch('/chart-users');
    var users = await res.json();
    meta.textContent = '共 ' + users.length + ' 位用户';

    if (!users.length) {
      grid.innerHTML = '<div class="adm-card-empty">暂无命盘数据</div>';
      return;
    }

    grid.innerHTML = users.map(function(u) {
      var phone = u.userId || '未知';
      return '<div class="adm-user-card" onclick="openChartDetail(\''+escAttr(phone)+'\')">'+
        '<div class="adm-card-avatar">◎</div>'+
        '<div class="adm-card-body">'+
          '<span class="adm-card-name mono">'+esc(phone)+'</span>'+
          '<span class="adm-card-desc">'+u.count+' 份命盘</span>'+
        '</div>'+
        '<div class="adm-card-time dim">'+fmtRel(u.latestAt)+'</div>'+
        '<span class="adm-card-arrow">→</span>'+
      '</div>';
    }).join('');

    document.getElementById('chartsDetailPanel').style.display = 'none';
  } catch(e) {
    console.error('Load chart users failed', e);
    grid.innerHTML = '<div class="adm-card-empty">加载失败，请重试</div>';
  }
}

async function openChartDetail(userId) {
  var tbody = document.getElementById('chartsDetailTbody');
  var title = document.getElementById('chartsDetailTitle');
  title.textContent = userId + ' 的命盘';
  tbody.innerHTML = '<tr><td colspan="6" class="adm-empty">加载中…</td></tr>';
  document.getElementById('chartsDetailPanel').style.display = 'block';
  document.getElementById('chartsCardGrid').style.display = 'none';
  document.getElementById('chartsMeta').style.display = 'none';

  try {
    var res = await adminFetch('/charts?userId=' + encodeURIComponent(userId));
    var charts = await res.json();

    if (!charts.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="adm-empty">该用户暂无命盘</td></tr>';
      return;
    }

    tbody.innerHTML = charts.map(function(c) {
      var b = c.birth || {};
      var dateStr = b.year ? b.year + '-' + pad(b.month) + '-' + pad(b.day) : '—';
      var g = c.gender === 'male' ? '男' : '女';
      var detailUrl = '/my-charts/?id=' + c.id + '&admin=1';
      return '<tr>'+
        '<td><a href="'+detailUrl+'" target="_blank" style="color:var(--text);text-decoration:none;">'+esc(c.name||'未命名')+' ↗</a></td>'+
        '<td>'+g+'</td>'+
        '<td class="dim">'+dateStr+'</td>'+
        '<td class="dim">'+esc(c.birthplace||'—')+'</td>'+
        '<td class="dim">'+fmtDate(c.createdAt)+'</td>'+
        '<td class="adm-td-right"><button class="adm-del-btn" onclick="confirmDeleteChart(\''+escAttr(c.id)+'\',\''+escAttr(c.name||'未命名')+'\')">删除</button></td>'+
        '</tr>';
    }).join('');
  } catch(e) {
    console.error('Load user charts failed', e);
    tbody.innerHTML = '<tr><td colspan="6" class="adm-empty">加载失败</td></tr>';
  }
}

function closeChartDetail() {
  document.getElementById('chartsDetailPanel').style.display = 'none';
  document.getElementById('chartsCardGrid').style.display = '';
  document.getElementById('chartsMeta').style.display = '';
}

// ========================= 占卜（用户分组 → 点击看详情 → 梅花/六爻子标签） =========================

var _divRecordsCache = [];  // 缓存当前用户的所有排盘记录
var _divUserId = '';

async function loadDivUsers() {
  var grid = document.getElementById('divCardGrid');
  var meta = document.getElementById('divMeta');
  grid.innerHTML = '<div class="adm-card-empty">加载中…</div>';

  try {
    var res = await adminFetch('/divination-users');
    var users = await res.json();
    meta.textContent = '共 ' + users.length + ' 位用户';

    if (!users.length) {
      grid.innerHTML = '<div class="adm-card-empty">暂无排盘记录</div>';
      return;
    }

    grid.innerHTML = users.map(function(u) {
      var phone = u.userId || '未知';
      var mhysCnt = u.mhysCount || 0;
      var lyCnt = u.liuyaoCount || 0;
      var total = mhysCnt + lyCnt;
      var desc = '';
      if (mhysCnt > 0 && lyCnt > 0) desc = '🌸' + mhysCnt + '次梅花 · ⚡' + lyCnt + '次六爻';
      else if (mhysCnt > 0) desc = '🌸' + mhysCnt + '次梅花易数';
      else desc = '⚡' + lyCnt + '次六爻';
      return '<div class="adm-user-card" onclick="openDivDetail(\''+escAttr(phone)+'\')">'+
        '<div class="adm-card-avatar">☯</div>'+
        '<div class="adm-card-body">'+
          '<span class="adm-card-name mono">'+esc(phone)+'</span>'+
          '<span class="adm-card-desc">'+desc+'</span>'+
        '</div>'+
        '<div class="adm-card-time dim">'+fmtRel(u.latestAt)+'</div>'+
        '<span class="adm-card-arrow">→</span>'+
      '</div>';
    }).join('');

    document.getElementById('divDetailPanel').style.display = 'none';
  } catch(e) {
    console.error('Load divination users failed', e);
    grid.innerHTML = '<div class="adm-card-empty">加载失败，请重试</div>';
  }
}

async function openDivDetail(userId) {
  _divUserId = userId;
  _divRecordsCache = [];

  var tMhys = document.getElementById('divDetailTbodyMhys');
  var tLiuyao = document.getElementById('divDetailTbodyLiuyao');
  var title = document.getElementById('divDetailTitle');
  title.textContent = userId + ' 的排盘记录';
  tMhys.innerHTML = '<tr><td colspan="4" class="adm-empty">加载中…</td></tr>';
  tLiuyao.innerHTML = '<tr><td colspan="4" class="adm-empty">加载中…</td></tr>';
  document.getElementById('divDetailPanel').style.display = 'block';
  document.getElementById('divCardGrid').style.display = 'none';
  document.getElementById('divMeta').style.display = 'none';

  try {
    var res = await adminFetch('/divination-records/' + encodeURIComponent(userId));
    var records = await res.json();
    _divRecordsCache = records;

    // 统计数量
    var mhysCnt = records.filter(function(r) { return r.type === 'mhys'; }).length;
    var lyCnt = records.filter(function(r) { return r.type === 'liuyao'; }).length;
    document.getElementById('divCntMhys').textContent = mhysCnt;
    document.getElementById('divCntLiuyao').textContent = lyCnt;

    // 默认显示梅花易数
    switchDivSubtab('mhys');
  } catch(e) {
    console.error('Load user divination records failed', e);
    tMhys.innerHTML = '<tr><td colspan="4" class="adm-empty">加载失败</td></tr>';
  }
}

function switchDivSubtab(type) {
  // 更新子标签 active 样式
  document.querySelectorAll('.adm-subtab').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.subtab === type);
  });

  // 切换表格显示
  document.getElementById('divTableMhys').style.display = (type === 'mhys') ? '' : 'none';
  document.getElementById('divTableLiuyao').style.display = (type === 'liuyao') ? '' : 'none';

  // 渲染对应表格
  var filtered = _divRecordsCache.filter(function(r) { return r.type === type; });
  var tbody = (type === 'mhys') ? document.getElementById('divDetailTbodyMhys') : document.getElementById('divDetailTbodyLiuyao');
  var methodNames = { num1:'数字起卦', num2:'数字起卦', time:'时间起卦', manual:'手动起卦', auto:'自动起卦' };

  if (!filtered.length) {
    var label = (type === 'mhys') ? '梅花易数' : '六爻';
    tbody.innerHTML = '<tr><td colspan="4" class="adm-empty">暂无' + label + '排盘记录</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(function(r) {
    var resultUrl = (r.type === 'liuyao') ? '/liuyao/result.html?id=' + r.id + '&admin=1' : '/mhys/result.html?id=' + r.id + '&admin=1';
    return '<tr>'+
      '<td><a href="'+resultUrl+'" target="_blank" style="color:var(--text);text-decoration:none;">'+esc(r.topic||'(无事项)')+' ↗</a></td>'+
      '<td class="dim">'+(methodNames[r.method]||r.method||'—')+'</td>'+
      '<td class="dim">'+(r.divinationTime || fmtDate(r.createdAt))+'</td>'+
      '<td class="adm-td-right"><button class="adm-del-btn" onclick="confirmDeleteDivRecord(\''+escAttr(r.id)+'\',\''+escAttr(r.topic||'未填写')+'\',\''+escAttr(r.type)+'\')">删除</button></td>'+
      '</tr>';
  }).join('');
}

function closeDivDetail() {
  document.getElementById('divDetailPanel').style.display = 'none';
  document.getElementById('divCardGrid').style.display = '';
  document.getElementById('divMeta').style.display = '';
  _divRecordsCache = [];
  _divUserId = '';
}

function confirmDeleteDivRecord(id, topic, recType) {
  _deleteTarget = { type: (recType === 'liuyao' ? 'liuyao_record' : 'mhys_record'), id: id };
  document.getElementById('confirmTitle').textContent = '删除排盘记录';
  document.getElementById('confirmMsg').textContent = '确定删除排盘记录「' + topic + '」吗？此操作不可恢复。';
  document.getElementById('confirmBtn').textContent = '确认删除';
  showConfirm();
}

// ========================= 删除 =========================

function confirmDeleteUser(phone) {
  _deleteTarget = { type: 'user', id: phone };
  document.getElementById('confirmTitle').textContent = '删除用户';
  document.getElementById('confirmMsg').textContent = '确定删除用户 ' + phone + ' 吗？该用户的所有命盘也将一并删除。此操作不可恢复。';
  document.getElementById('confirmBtn').textContent = '确认删除';
  showConfirm();
}

function confirmDeleteChart(id, name) {
  _deleteTarget = { type: 'chart', id: id };
  document.getElementById('confirmTitle').textContent = '删除命盘';
  document.getElementById('confirmMsg').textContent = '确定删除命盘「' + name + '」吗？此操作不可恢复。';
  document.getElementById('confirmBtn').textContent = '确认删除';
  showConfirm();
}

async function doConfirmDelete() {
  if (!_deleteTarget) return;
  const { type, id } = _deleteTarget;
  try {
    let path;
    if (type === 'user') path = '/users/' + id;
    else if (type === 'chart') path = '/charts/' + id;
    else if (type === 'mhys_record') path = '/mhys-records/' + id;
    else if (type === 'liuyao_record') path = '/liuyao-records/' + id;
    else return;
    const res = await adminFetch(path, { method: 'DELETE' });
    if (!res.ok) throw new Error('删除失败');
    closeConfirm();
    // 刷新当前 tab
    const active = document.querySelector('.adm-nav-item.active');
    if (active && active.dataset.tab === 'users') loadUsers();
    else if (active && active.dataset.tab === 'charts') {
      if (document.getElementById('chartsDetailPanel').style.display !== 'none') {
        var userId = document.getElementById('chartsDetailTitle').textContent.replace(' 的命盘', '');
        openChartDetail(userId);
        loadChartUsers();
      } else {
        loadChartUsers();
      }
    }
    else if (active && active.dataset.tab === 'divination') {
      if (document.getElementById('divDetailPanel').style.display !== 'none') {
        // 重新加载当前用户详情
        openDivDetail(_divUserId);
        loadDivUsers();
      } else {
        loadDivUsers();
      }
    }
    else loadDashboard();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

document.getElementById('confirmBtn').addEventListener('click', doConfirmDelete);

function showConfirm() {
  document.getElementById('admOverlay').style.display = 'block';
  document.getElementById('modalConfirm').style.display = 'block';
}
function closeConfirm() {
  document.getElementById('admOverlay').style.display = 'none';
  document.getElementById('modalConfirm').style.display = 'none';
  _deleteTarget = null;
}

// ========================= Token 编辑 =========================

var _tokenEditUsername = '';

function editToken(username, currentUsed) {
  _tokenEditUsername = username;
  document.getElementById('tokenUserLabel').textContent = '用户：' + username;
  document.getElementById('tokenInput').value = currentUsed;
  document.getElementById('tokenErr').textContent = '';
  document.getElementById('tokenOk').style.display = 'none';
  document.getElementById('admOverlay').style.display = 'block';
  document.getElementById('modalToken').style.display = 'block';
  document.getElementById('tokenInput').focus();
}

function closeTokenModal() {
  document.getElementById('admOverlay').style.display = 'none';
  document.getElementById('modalToken').style.display = 'none';
  _tokenEditUsername = '';
}

async function saveToken() {
  var err = document.getElementById('tokenErr');
  var ok = document.getElementById('tokenOk');
  err.textContent = '';
  ok.style.display = 'none';

  var val = parseInt(document.getElementById('tokenInput').value);
  if (isNaN(val) || val < 0) {
    err.textContent = '请输入有效的非负整数';
    return;
  }

  try {
    var res = await adminFetch('/user-tokens', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: _tokenEditUsername, tokenUsed: val }),
    });
    if (!res.ok) {
      var data = await res.json();
      throw new Error(data.error || '设置失败');
    }
    ok.textContent = '已更新 ✓';
    ok.style.display = 'block';
    setTimeout(function() {
      closeTokenModal();
      loadUsers();
    }, 800);
  } catch(e) {
    err.textContent = e.message;
  }
}

// ========================= 密码 =========================

function openPwdModal() {
  document.getElementById('pwdCurrent').value = '';
  document.getElementById('pwdNew').value = '';
  document.getElementById('pwdConfirm').value = '';
  document.getElementById('pwdErr').textContent = '';
  document.getElementById('pwdOk').style.display = 'none';
  document.getElementById('admOverlay').style.display = 'block';
  document.getElementById('modalPwd').style.display = 'block';
}

function closePwdModal() {
  document.getElementById('admOverlay').style.display = 'none';
  document.getElementById('modalPwd').style.display = 'none';
}

async function doChangePwd(e) {
  e.preventDefault();
  const err = document.getElementById('pwdErr');
  const ok = document.getElementById('pwdOk');
  err.textContent = ''; ok.style.display = 'none';

  const current = document.getElementById('pwdCurrent').value;
  const pwd = document.getElementById('pwdNew').value;
  const confirm = document.getElementById('pwdConfirm').value;

  if (!current || !pwd || !confirm) { err.textContent = '请填写所有密码字段'; return; }
  if (pwd.length < 6) { err.textContent = '新密码至少需要 6 位'; return; }
  if (pwd !== confirm) { err.textContent = '两次输入的新密码不一致'; return; }

  try {
    const res = await adminFetch('/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current, newPassword: pwd }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '修改失败');
    ok.textContent = '密码修改成功 ✓';
    ok.style.display = 'block';
    setTimeout(closePwdModal, 1500);
  } catch (e) {
    err.textContent = e.message;
  }
}

// ========================= 工具 =========================

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function pad(n) { return String(n || 0).padStart(2, '0'); }

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fmtToken(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'K';
  return (n / 1000000).toFixed(1) + 'M';
}

function fmtRel(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return '未来';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + ' 小时前';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + ' 天前';
  return fmtDate(ts);
}

function updateSettingTime() {
  const el = document.getElementById('settingTime');
  if (el) {
    el.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
    setTimeout(updateSettingTime, 30000);
  }
}

// ========================= 建议模块 =========================

const sugLabelMap = {
  overall: '总体评价',
  ui: 'UI界面舒适度',
  feature: '功能适用度',
  ai: 'AI解析准确度',
  responseSpeed: '响应速度',
  accuracy: '解析内容丰富度',
};

async function loadSugUsers() {
  var grid = document.getElementById('sugCardGrid');
  var meta = document.getElementById('sugMeta');
  grid.innerHTML = '<div class="adm-card-empty">加载中…</div>';

  try {
    var res = await adminFetch('/suggestion-users');
    var users = await res.json();
    meta.textContent = '共 ' + users.length + ' 位用户';

    if (!users.length) {
      grid.innerHTML = '<div class="adm-card-empty">暂无建议数据</div>';
      return;
    }

    grid.innerHTML = users.map(function(u) {
      var phone = u.userId || '未知';
      var label = phone === 'anonymous' ? '匿名用户' : phone;
      return '<div class="adm-user-card" onclick="openSugDetail(\'' + escAttr(phone) + '\')">' +
        '<div class="adm-card-avatar">✎</div>' +
        '<div class="adm-card-body">' +
          '<span class="adm-card-name mono">' + esc(label) + '</span>' +
          '<span class="adm-card-desc">' + u.count + ' 条建议</span>' +
        '</div>' +
        '<div class="adm-card-time dim">' + fmtRel(u.latestAt) + '</div>' +
        '<span class="adm-card-arrow">→</span>' +
      '</div>';
    }).join('');

    document.getElementById('sugDetailPanel').style.display = 'none';
  } catch(e) {
    console.error('Load suggestion users failed', e);
    grid.innerHTML = '<div class="adm-card-empty">加载失败，请重试</div>';
  }
}

async function openSugDetail(userId) {
  var cards = document.getElementById('sugDetailCards');
  var title = document.getElementById('sugDetailTitle');
  var label = userId === 'anonymous' ? '匿名用户' : userId;
  title.textContent = label + ' 的建议';
  cards.innerHTML = '<div class="adm-card-empty">加载中…</div>';
  document.getElementById('sugDetailPanel').style.display = 'block';
  document.getElementById('sugCardGrid').style.display = 'none';
  document.getElementById('sugMeta').style.display = 'none';

  try {
    var res = await adminFetch('/suggestion-detail/' + encodeURIComponent(userId));
    var suggestions = await res.json();

    if (!suggestions.length) {
      cards.innerHTML = '<div class="adm-card-empty">该用户暂无建议</div>';
      return;
    }

    cards.innerHTML = suggestions.map(function(s) {
      var dateStr = fmtDate(s.createdAt);
      var starHtml = function(score) {
        var str = '';
        for (var i = 0; i < 5; i++) str += i < score ? '★' : '☆';
        return str;
      };
      var ratingsHtml = '';
      if (s.ratings) {
        ratingsHtml = '<div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.6rem;">';
        for (var key in sugLabelMap) {
          var val = s.ratings[key] || 0;
          if (val > 0) {
            ratingsHtml += '<span style="font-size:0.7rem;color:var(--text-dim);background:var(--bg);padding:0.2rem 0.5rem;border-radius:6px;border:1px solid var(--border);">' +
              esc(sugLabelMap[key]) + ' ' + starHtml(val) + '</span>';
          }
        }
        ratingsHtml += '</div>';
      }
      return '<div class="sg-detail-card" style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:1rem 1.2rem;margin-bottom:0.6rem;">' +
        '<div style="font-size:0.65rem;color:var(--text-muted);margin-bottom:0.4rem;">' + dateStr + '</div>' +
        ratingsHtml +
        '<div style="font-size:0.82rem;color:var(--text);line-height:1.7;white-space:pre-wrap;">' + esc(s.content) + '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    console.error('Load suggestion detail failed', e);
    cards.innerHTML = '<div class="adm-card-empty">加载失败</div>';
  }
}

function closeSugDetail() {
  document.getElementById('sugDetailPanel').style.display = 'none';
  document.getElementById('sugCardGrid').style.display = '';
  document.getElementById('sugMeta').style.display = '';
}

// ========================= 参考书籍模块 =========================

const catNames = { bazi:'四柱八字', ziwei:'紫微斗数', meihua:'梅花易数', liuyao:'六爻', qimen:'奇门遁甲', yijing:'易经（通用）', liuren:'六壬', fengshui:'风水', xiangshu:'相术', general:'通用术数' };
const statusLabels = { pending:'待入库', ingested:'已入库', error:'入库失败' };
const statusColors = { pending:'#f0a020', ingested:'#20a060', error:'#d04040' };

async function loadBookFolders() {
  try {
    var res = await adminFetch('/book-folders');
    var folders = res.ok ? await res.json() : [];
    var sel = document.getElementById('booksFolderFilter');
    var currentVal = sel.value;
    sel.innerHTML = '<option value="">全部文件夹</option>';
    folders.forEach(function(f) {
      sel.innerHTML += '<option value="' + escAttr(f.name) + '">' + esc(f.name) + ' (' + f.count + ')</option>';
    });
    sel.value = currentVal;
  } catch(e) {}
}

async function loadBooks() {
  var tbody = document.getElementById('booksTbody');
  var meta = document.getElementById('booksMeta');
  tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">加载中…</td></tr>';
  document.getElementById('booksDetailPanel').style.display = 'none';

  loadBookFolders();

  try {
    var cat = document.getElementById('booksCatFilter').value;
    var folder = document.getElementById('booksFolderFilter').value;
    var qs = [];
    if (cat) qs.push('category=' + encodeURIComponent(cat));
    if (folder) qs.push('folder=' + encodeURIComponent(folder));
    var queryStr = qs.length ? '?' + qs.join('&') : '';
    var res = await adminFetch('/books' + queryStr);
    var books = await res.json();
    meta.textContent = '共 ' + books.length + ' 本';

    if (!books.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">暂无书籍，点击上方按钮添加</td></tr>';
      return;
    }

    tbody.innerHTML = books.map(function(b) {
      var catName = catNames[b.category] || b.category;
      var stColor = statusColors[b.status] || '#888';
      var stLabel = statusLabels[b.status] || b.status;
      // 分类下拉选项
      var catOpts = '';
      Object.keys(catNames).forEach(function(k) {
        catOpts += '<option value="' + k + '"' + (k === b.category ? ' selected' : '') + '>' + catNames[k] + '</option>';
      });
      var ingestBtn = (b.status === 'pending' && b.content)
        ? '<button class="adm-ingest-btn" onclick="ingestBook(' + b.id + ', this)" title="入库到向量知识库">入库</button>'
        : '';
      return '<tr>' +
        '<td><a href="#" class="adm-book-link" onclick="openBookDetail(' + b.id + ')">' + esc(b.title) + '</a></td>' +
        '<td class="dim">' + esc(b.folder || '—') + '</td>' +
        '<td><select class="adm-cat-select" onchange="changeBookCategory(' + b.id + ', this.value)" onclick="event.stopPropagation()">' + catOpts + '</select></td>' +
        '<td class="dim">' + esc(b.author || '—') + '</td>' +
        '<td><span style="color:' + stColor + ';font-size:0.7rem">●</span> ' + stLabel + '</td>' +
        '<td class="mono">' + (b.chunksCount || 0) + '</td>' +
        '<td class="dim">' + fmtDate(b.createdAt) + '</td>' +
        '<td class="adm-td-right">' + ingestBtn + ' <button class="adm-del-btn" onclick="confirmDeleteBook(' + b.id + ',\'' + escAttr(b.title) + '\')">删除</button></td>' +
        '</tr>';
    }).join('');
  } catch(e) {
    console.error('Load books failed', e);
    tbody.innerHTML = '<tr><td colspan="8" class="adm-empty">加载失败，请重试</td></tr>';
  }
}

function openAddBook() {
  document.getElementById('bookEditId').value = '';
  document.getElementById('bookEditTitle').value = '';
  document.getElementById('bookEditFolder').value = '';
  document.getElementById('bookEditCat').value = 'bazi';
  document.getElementById('bookEditAuthor').value = '';
  document.getElementById('bookEditDesc').value = '';
  document.getElementById('bookEditContent').value = '';
  document.getElementById('bookEditErr').textContent = '';
  document.getElementById('bookEditOk').style.display = 'none';
  document.getElementById('booksDetailTitle').textContent = '添加书籍';
  document.getElementById('booksDetailPanel').style.display = 'block';
  document.getElementById('booksTable').closest('.adm-table-wrap').style.display = 'none';
  document.querySelector('#tab-books .adm-books-toolbar').style.display = 'none';
  document.getElementById('booksMeta').style.display = 'none';
}

async function openBookDetail(id) {
  document.getElementById('bookEditErr').textContent = '';
  document.getElementById('bookEditOk').style.display = 'none';
  document.getElementById('booksDetailTitle').textContent = '加载中…';
  document.getElementById('booksDetailPanel').style.display = 'block';
  document.getElementById('booksTable').closest('.adm-table-wrap').style.display = 'none';
  document.querySelector('#tab-books .adm-books-toolbar').style.display = 'none';
  document.getElementById('booksMeta').style.display = 'none';

  try {
    var res = await adminFetch('/books/' + id);
    if (!res.ok) throw new Error('书籍不存在');
    var b = await res.json();
    document.getElementById('bookEditId').value = b.id;
    document.getElementById('bookEditTitle').value = b.title || '';
    document.getElementById('bookEditFolder').value = b.folder || '';
    document.getElementById('bookEditCat').value = b.category || 'bazi';
    document.getElementById('bookEditAuthor').value = b.author || '';
    document.getElementById('bookEditDesc').value = b.description || '';
    document.getElementById('bookEditContent').value = b.content || '';
    document.getElementById('booksDetailTitle').textContent = '编辑：' + b.title;
  } catch(e) {
    console.error('Load book detail failed', e);
    document.getElementById('bookEditErr').textContent = '加载失败: ' + e.message;
  }
}

function closeBooksDetail() {
  document.getElementById('booksDetailPanel').style.display = 'none';
  document.getElementById('booksTable').closest('.adm-table-wrap').style.display = '';
  document.querySelector('#tab-books .adm-books-toolbar').style.display = '';
  document.getElementById('booksMeta').style.display = '';
}

// 保存书籍（添加/编辑）
document.addEventListener('DOMContentLoaded', function() {
  var form = document.getElementById('bookEditForm');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      saveBook();
    });
  }
});

async function saveBook() {
  var err = document.getElementById('bookEditErr');
  var ok = document.getElementById('bookEditOk');
  err.textContent = '';
  ok.style.display = 'none';

  var id = document.getElementById('bookEditId').value;
  var title = document.getElementById('bookEditTitle').value.trim();
  var folder = document.getElementById('bookEditFolder').value.trim();
  var category = document.getElementById('bookEditCat').value;
  var author = document.getElementById('bookEditAuthor').value.trim();
  var description = document.getElementById('bookEditDesc').value.trim();
  var content = document.getElementById('bookEditContent').value.trim();

  if (!title) { err.textContent = '请输入书名'; return; }

  var body = { title: title, folder: folder, category: category, author: author, description: description, content: content };

  try {
    var res;
    if (id) {
      res = await adminFetch('/books/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await adminFetch('/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      var data = await res.json();
      throw new Error(data.error || '保存失败');
    }
    ok.textContent = '保存成功 ✓';
    ok.style.display = 'block';
    setTimeout(function() {
      closeBooksDetail();
      loadBooks();
    }, 800);
  } catch(e) {
    err.textContent = e.message;
  }
}

function confirmDeleteBook(id, title) {
  _deleteTarget = { type: 'book', id: id };
  document.getElementById('confirmTitle').textContent = '删除书籍';
  document.getElementById('confirmMsg').textContent = '确定删除《' + title + '》吗？此书的所有知识库数据也会丢失。此操作不可恢复。';
  document.getElementById('confirmBtn').textContent = '确认删除';
  showConfirm();
}

async function changeBookCategory(id, newCat) {
  try {
    var res = await adminFetch('/books/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: newCat }),
    });
    if (!res.ok) throw new Error('修改失败');
  } catch(e) {
    alert('分类修改失败: ' + e.message);
    loadBooks();
  }
}

// 单本入库
async function ingestBook(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '入库中...'; }
  try {
    var res = await adminFetch('/books/ingest/' + id, { method: 'POST' });
    var data = await res.json();
    if (res.ok && data.ok) {
      loadBooks(); // 刷新列表
    } else {
      alert('入库失败: ' + (data.error || '未知错误'));
      if (btn) { btn.disabled = false; btn.textContent = '入库'; }
    }
  } catch(e) {
    alert('入库出错: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '入库'; }
  }
}

// 全部入库
async function batchIngest() {
  if (!confirm('确定要将所有待入库的书籍导入向量知识库吗？\n\n这可能需要几分钟时间。')) return;
  var btn = document.getElementById('btnBatchIngest');
  btn.disabled = true; btn.textContent = '⏳ 入库中...';
  try {
    var res = await adminFetch('/books/ingest-all', { method: 'POST' });
    var data = await res.json();
    if (data.ok) {
      alert('批量入库已开始！后台正在处理，请稍后刷新页面查看进度。');
      // 定时刷新
      var iv = setInterval(function() {
        loadBooks();
        // 检查是否还有 pending 的
        var pendingBtns = document.querySelectorAll('.adm-ingest-btn');
        if (!pendingBtns.length) { clearInterval(iv); btn.disabled = false; btn.textContent = '📥 全部入库'; }
      }, 3000);
      setTimeout(function() { clearInterval(iv); btn.disabled = false; btn.textContent = '📥 全部入库'; }, 600000); // 最多10分钟
    } else {
      alert('启动失败: ' + (data.error || '未知错误'));
      btn.disabled = false; btn.textContent = '📥 全部入库';
    }
  } catch(e) {
    alert('出错: ' + e.message);
    btn.disabled = false; btn.textContent = '📥 全部入库';
  }
}

// 扩展 doConfirmDelete 以支持书籍删除
var _originalDoConfirmDelete = doConfirmDelete;
doConfirmDelete = async function() {
  if (!_deleteTarget) return;
  if (_deleteTarget.type === 'book') {
    try {
      var res = await adminFetch('/books/' + _deleteTarget.id, { method: 'DELETE' });
      if (!res.ok) throw new Error('删除失败');
      closeConfirm();
      loadBooks();
    } catch(e) {
      alert('删除失败: ' + e.message);
    }
    return;
  }
  return _originalDoConfirmDelete();
};

// ========================= Prompt 管理 =========================

var promptLabelMap = {
  mhys_system:   '梅花易数 · System Prompt',
  mhys_prompt:   '梅花易数 · 用户 Prompt（有事项）',
  mhys_notopic:  '梅花易数 · 无事项回复',
  mhys_followup: '梅花易数 · 追问回复',
  liuyao_system: '六爻 · System Prompt',
  liuyao_prompt: '六爻 · 用户 Prompt（有事项）',
  liuyao_notopic:'六爻 · 无事项回复',
  liuyao_followup:'六爻 · 追问回复',
};

var promptVarHints = {
  mhys: '可用变量：{{topic}} {{benGuaName}} {{benGuaUpper}} {{benGuaLower}} {{huGuaName}} {{huGuaUpper}} {{huGuaLower}} {{bianGuaName}} {{bianGuaUpper}} {{bianGuaLower}} {{cuoGuaName}} {{cuoGuaUpper}} {{cuoGuaLower}} {{zongGuaName}} {{zongGuaUpper}} {{zongGuaLower}} {{tiName}} {{tiElement}} {{yongName}} {{yongElement}} {{tiyongVerdict}} {{tiyongDesc}} {{movingYao}} {{ragContext}} {{followUp}} {{context}}',
  liuyao: '可用变量：{{topic}} {{gender}} {{benGuaName}} {{benGuaUpper}} {{benGuaLower}} {{bianGuaName}} {{bianGuaUpper}} {{bianGuaLower}} {{ragContext}} {{followUp}} {{context}}',
};

async function loadPrompts() {
  var list = document.getElementById('promptsList');
  list.innerHTML = '<div class="adm-card-empty">加载中…</div>';

  try {
    var res = await adminFetch('/prompts');
    var prompts = await res.json();

    // 按标签分组
    var groups = [{ label: '🌸 梅花易数', keys: ['mhys_system','mhys_prompt','mhys_notopic','mhys_followup'] },
                  { label: '⚡ 六爻', keys: ['liuyao_system','liuyao_prompt','liuyao_notopic','liuyao_followup'] }];

    var html = '';
    groups.forEach(function(g) {
      html += '<div class="adm-prompt-group"><h3 class="adm-prompt-group-title">' + g.label + '</h3>';
      g.keys.forEach(function(key) {
        var item = prompts.find(function(p) { return p.key === key; });
        if (!item) return;
        var label = promptLabelMap[key] || key;
        var isCustom = item.isCustom;
        var value = item.customValue || item.defaultValue;
        var type = key.startsWith('mhys') ? 'mhys' : 'liuyao';
        var hint = promptVarHints[type] || '';
        var statusClass = isCustom ? 'adm-prompt-custom' : 'adm-prompt-default';
        var statusText = isCustom ? '已自定义' : '默认';
        var escValue = value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        html += '<div class="adm-prompt-item ' + statusClass + '" id="promptItem_' + key + '">' +
          '<div class="adm-prompt-head">' +
            '<span class="adm-prompt-label">' + esc(label) + '</span>' +
            '<span class="adm-prompt-status">' + statusText + '</span>' +
          '</div>' +
          '<textarea class="adm-prompt-textarea" id="promptText_' + key + '" rows="' + (key.endsWith('_prompt') ? '14' : '4') + '">' + escValue + '</textarea>' +
          '<div class="adm-prompt-hint">' + esc(hint) + '</div>' +
          '<div class="adm-prompt-actions">' +
            '<button class="adm-btn-primary adm-btn-sm" onclick="savePrompt(\'' + key + '\')">💾 保存</button>' +
            (isCustom ? '<button class="adm-btn-sm" onclick="resetPrompt(\'' + key + '\')" style="background:#d04040;color:#fff;border:none;border-radius:14px;padding:0.3rem 0.8rem;cursor:pointer;margin-left:0.4rem">↺ 恢复默认</button>' : '') +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    });

    list.innerHTML = html;
  } catch(e) {
    console.error('Load prompts failed', e);
    list.innerHTML = '<div class="adm-card-empty">加载失败，请重试</div>';
  }
}

async function savePrompt(key) {
  var textarea = document.getElementById('promptText_' + key);
  var value = textarea.value;
  try {
    var res = await adminFetch('/prompts/' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: value }),
    });
    if (!res.ok) throw new Error('保存失败');
    // 刷新显示
    loadPrompts();
  } catch(e) {
    alert('保存失败: ' + e.message);
  }
}

async function resetPrompt(key) {
  if (!confirm('确定恢复「' + (promptLabelMap[key] || key) + '」为默认模板吗？')) return;
  try {
    var res = await adminFetch('/prompts/' + key, { method: 'DELETE' });
    if (!res.ok) throw new Error('重置失败');
    loadPrompts();
  } catch(e) {
    alert('重置失败: ' + e.message);
  }
}
