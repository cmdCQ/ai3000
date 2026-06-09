/**
 * 我的命盘 — 前端逻辑 (MySQL版)
 * 新建排盘 / 查看详情
 * 列表统一在首页「我的命盘」Tab 展示
 */

const SHICHEN_NAMES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);

  // ===== 无参数 → 直接跳回首页（列表在首页） =====
  if (!params.get('id') && params.get('action') !== 'create') {
    window.location.href = '/?tab=charts';
    return;
  }

  // ===== 登录检查 =====
  if (!AUTH.isLoggedIn()) {
    window.location.href = '/login/';
    return;
  }

  // ===== 日历切换 =====
  document.querySelectorAll('.calendar-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.calendar-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ===== 真太阳时切换 =====
  const tsToggle = document.getElementById('f-true-solar');
  if (tsToggle) {
    tsToggle.addEventListener('change', function() {
      document.getElementById('solar-detail').style.display = this.checked ? 'block' : 'none';
    });
  }

  // ===== 按钮 =====
  var cancelBtn = document.getElementById('btn-cancel-form');
  if (cancelBtn) cancelBtn.addEventListener('click', function(){ window.location.href = '/'; });
  document.getElementById('btn-submit').addEventListener('click', submitChart);

  // ===== 默认填今天 =====
  const now = new Date();
  const fy = document.getElementById('f-year');
  if (fy) {
    fy.value = now.getFullYear();
    document.getElementById('f-month').value = now.getMonth() + 1;
    document.getElementById('f-day').value = now.getDate();
    const hour = now.getHours();
    const hourOptions = document.getElementById('f-hour').options;
    for (let i = 0; i < hourOptions.length; i++) {
      if (parseInt(hourOptions[i].value) <= hour) {
        document.getElementById('f-hour').value = hourOptions[i].value;
      }
    }
  }

  // ===== 根据参数展示对应视图 =====
  if (params.get('id')) {
    // 命盘详情已迁至独立页面
    window.location.href = '/my-charts/?id=' + params.get('id');
    return;
  }
  showForm();
});

// ============================================================
// 视图切换
// ============================================================

function showForm() {
  document.getElementById('view-form').style.display = 'block';
  document.getElementById('view-detail').style.display = 'none';
}

// ============================================================
// 提交排盘
// ============================================================

async function submitChart() {
  const name = document.getElementById('f-name').value.trim() || '未命名';
  const birthYear = parseInt(document.getElementById('f-year').value);
  const birthMonth = parseInt(document.getElementById('f-month').value);
  const birthDay = parseInt(document.getElementById('f-day').value);
  const birthHour = parseInt(document.getElementById('f-hour').value);
  const gender = document.getElementById('f-gender').value;
  const calendar = document.querySelector('.calendar-toggle .active')?.dataset?.cal || 'gregorian';
  const trueSolarTime = document.getElementById('f-true-solar').checked;
  const birthplace = document.getElementById('f-place').value.trim();
  const lat = parseFloat(document.getElementById('f-lat').value) || null;
  const lng = parseFloat(document.getElementById('f-lng').value) || null;

  if (isNaN(birthHour) || birthHour === '') {
    alert('请选择出生时辰 (｡•́︿•̀｡)');
    return;
  }
  if (!birthYear || !birthMonth || !birthDay) {
    alert('请填写完整的出生日期');
    return;
  }
  if (birthYear < 1900 || birthYear > 2100) {
    alert('年份超出范围（1900-2100）');
    return;
  }
  if (birthMonth < 1 || birthMonth > 12) {
    alert('月份超出范围（1-12）');
    return;
  }
  var maxDay = new Date(birthYear, birthMonth, 0).getDate();
  if (birthDay < 1 || birthDay > maxDay) {
    alert(birthYear + '年' + birthMonth + '月只有 ' + maxDay + ' 天哦 (｡•́︿•̀｡)');
    return;
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const result = await ChartsStore.add({
      name, gender,
      birthYear, birthMonth, birthDay,
      birthHour, calendar,
      trueSolarTime,
      birthplace,
      latitude: lat, longitude: lng,
    });
    // 创建成功后跳转到命盘详情页
    window.location.href = '/my-charts/?id=' + result.id;
  } catch (e) {
    alert('保存失败: ' + (e.message || '请稍后重试'));
    btn.disabled = false;
    btn.textContent = '开始排盘';
  }
}

// ============================================================
// 工具
// ============================================================

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
