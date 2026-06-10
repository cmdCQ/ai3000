/**
 * AI三千问 — Auth Server v2
 * 注册/登录(手机号+验证码) + 后台管理 API
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { Solar } = require('lunar-javascript');
const config = require('./config.js');

// ===== 阿里云号码认证服务（PNVS）短信验证码 =====
const DypnsapiClient = require('@alicloud/dypnsapi20170525').default;
const { Config } = require('@alicloud/openapi-client');
const { RuntimeOptions } = require('@alicloud/tea-util');

const SMS_CONFIG = {
  accessKeyId: config.alibaba.accessKeyId,
  accessKeySecret: config.alibaba.accessKeySecret,
  signName: config.alibaba.signName,
  templateCode: config.alibaba.templateCode,
  endpoint: 'dypnsapi.aliyuncs.com',
};

const smsClient = new DypnsapiClient(new Config({
  accessKeyId: SMS_CONFIG.accessKeyId,
  accessKeySecret: SMS_CONFIG.accessKeySecret,
  endpoint: SMS_CONFIG.endpoint,
}));
const smsRuntime = new RuntimeOptions({});

// 验证码 & 冷却存储（内存）
const codeStore = new Map();  // phone -> { code, expires }
const cooldownMap = new Map(); // phone -> lastSendTime(ms)
const SMS_COOLDOWN = 60;      // 60秒冷却
const CODE_EXPIRE_MIN = 5;    // 验证码有效期5分钟

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsVerifyCode(phone) {
  // 冷却检查
  const last = cooldownMap.get(phone);
  if (last) {
    const elapsed = Math.floor((Date.now() - last) / 1000);
    if (elapsed < SMS_COOLDOWN) {
      return { ok: false, error: `请等待 ${SMS_COOLDOWN - elapsed} 秒后再发送`, cooldown: SMS_COOLDOWN - elapsed };
    }
  }
  const code = generateCode();
  try {
    const { SendSmsVerifyCodeRequest } = require('@alicloud/dypnsapi20170525');
    const req = new SendSmsVerifyCodeRequest({
      phoneNumber: phone,
      signName: SMS_CONFIG.signName,
      templateCode: SMS_CONFIG.templateCode,
      templateParam: JSON.stringify({ code, min: String(CODE_EXPIRE_MIN) }),
      outId: `ai3000-${Date.now()}`,
    });
    const resp = await smsClient.sendSmsVerifyCodeWithOptions(req, smsRuntime);
    if (resp.body.code === 'OK') {
      cooldownMap.set(phone, Date.now());
      codeStore.set(phone, { code, expires: Date.now() + CODE_EXPIRE_MIN * 60 * 1000 });
      return { ok: true };
    }
    console.error('[SMS] Send failed:', resp.body.message);
    return { ok: false, error: '短信发送失败，请稍后重试' };
  } catch (e) {
    console.error('[SMS] Error:', e.message);
    return { ok: false, error: '短信服务异常' };
  }
}

function verifySmsCode(phone, inputCode) {
  const stored = codeStore.get(phone);
  if (!stored) return { ok: false, error: '请先获取验证码' };
  if (Date.now() > stored.expires) {
    codeStore.delete(phone);
    return { ok: false, error: '验证码已过期，请重新获取' };
  }
  if (stored.code !== String(inputCode)) return { ok: false, error: '验证码错误' };
  // 验证成功，清除
  codeStore.delete(phone);
  return { ok: true };
}

const PORT = 3301;

// 八字计算（23:00后算次日）
function calcBazi(year, month, day, hour, minute) {
  let adjYear = year, adjMonth = month, adjDay = day, baziHour = hour;
  if (hour >= 23) {
    const next = new Date(year, month - 1, day + 1);
    adjYear = next.getFullYear(); adjMonth = next.getMonth() + 1; adjDay = next.getDate();
    baziHour = 0;
  }
  try {
    const s = Solar.fromYmdHms(adjYear, adjMonth, adjDay, baziHour, minute || 0, 0);
    const l = s.getLunar();
    const ec = l.getEightChar();
    return {
      bazi: ec.getYearGan()+ec.getYearZhi()+' '+ec.getMonthGan()+ec.getMonthZhi()+' '+ec.getDayGan()+ec.getDayZhi()+' '+ec.getTimeGan()+ec.getTimeZhi(),
      lunarYear: l.getYear(),
      lunarMonth: l.getMonth(),
      lunarDay: l.getDay()
    };
  } catch(e) { return null; }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

// Ensure data dir
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== Files =====
function readJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ===== Crypto helpers =====
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verify;
}

// ===== Admin (hashed credentials stored in file) =====
const defaultAdmin = {
  username: config.admin.username || 'CQA',
  passwordHash: hashPassword(config.admin.password),
  loginAttempts: 0,
  lockedUntil: 0,
};

const admin = readJSON(ADMIN_FILE, defaultAdmin);
// Ensure password is hashed (migrate from plaintext if needed)
if (!admin.passwordHash || admin.passwordHash.length < 20) {
  admin.passwordHash = hashPassword(config.admin.password);
  writeJSON(ADMIN_FILE, admin);
}
// Ensure username (use config value if admin file is new)
if (!admin.username) {
  admin.username = config.admin.username || 'CQA';
  writeJSON(ADMIN_FILE, admin);
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min lockout
const ADMIN_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24h

// ===== JWT =====
let JWT_SECRET;
if (fs.existsSync(SECRET_FILE)) {
  JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, JWT_SECRET);
}

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function createToken(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: Date.now() }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}
function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (s !== expected) return null;
    const payload = JSON.parse(base64urlDecode(b));
    // Check expiry
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ===== Stats =====
async function getStats() {
  const users = readJSON(USERS_FILE, {});
  const stats = readJSON(STATS_FILE, { totalAI: 0, aiHistory: [] });
  const now = Date.now();
  const todayStart = new Date(new Date().toDateString()).getTime();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const userList = Object.values(users);

  // 查询排卦总数（已保存的记录）
  let totalDivinations = 0;
  try {
    const [rows] = await db.query('SELECT COUNT(*) as cnt FROM mhys_records WHERE user_id IS NOT NULL AND user_id != \'\'');
    totalDivinations = rows[0].cnt;
  } catch(e) { /* 静默 */ }
  // 六爻排卦总数
  try {
    const [lyRows] = await db.query('SELECT COUNT(*) as cnt FROM liuyao_records WHERE user_id IS NOT NULL AND user_id != \'\'');
    totalDivinations += lyRows[0].cnt;
  } catch(e) { /* 静默 */ }

  return {
    totalUsers: userList.length,
    todayUsers: userList.filter(u => u.createdAt > todayStart).length,
    totalAI: stats.totalAI || 0,
    totalDivinations,
    active7d: userList.filter(u => u.lastActive > weekAgo).length,
  };
}
async function getUsers() {
  const users = readJSON(USERS_FILE, {});
  // 从 MySQL 拉 token 用量和 AI 次数
  let dbMap = {};
  try {
    const [rows] = await db.query('SELECT username, token_used, ai_count FROM users');
    rows.forEach(r => { dbMap[r.username] = { tokenUsed: r.token_used || 0, aiCount: r.ai_count || 0 }; });
  } catch(e) { /* 静默 */ }

  return Object.entries(users).map(([key, u]) => {
    const phone = u.phone || key;
    const dbInfo = dbMap[phone] || {};
    return {
      id: key,
      username: u.username || phone,
      phone,
      createdAt: u.createdAt,
      aiCount: dbInfo.aiCount || u.aiCount || 0,
      tokenUsed: dbInfo.tokenUsed || 0,
      lastActive: u.lastActive,
    };
  });
}
function deleteUser(id) {
  const users = readJSON(USERS_FILE, {});
  delete users[id];
  writeJSON(USERS_FILE, users);
}

// ===== MySQL Connection =====
const db = mysql.createPool({
  host: 'localhost',
  user: 'ai3000',
  password: config.mysql.password,
  database: 'ai3000',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ===== CORS & JSON =====
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
function json(res, data, status = 200) {
  setCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ===== Handle =====
async function handle(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await parseBody(req);
  const pathname = url.pathname;

  // ===== Auth APIs =====

  // POST /api/send-sms-code — 发送短信验证码
  if (req.method === 'POST' && pathname === '/api/send-sms-code') {
    const { phone } = body;
    if (!phone || !/^1\d{10}$/.test(phone)) return json(res, { error: '请输入正确手机号' }, 400);
    const result = await sendSmsVerifyCode(phone);
    if (result.ok) return json(res, { ok: true });
    return json(res, { error: result.error, cooldown: result.cooldown || 0 }, 429);
  }

  // POST /api/register — 手机号+验证码+密码注册
  if (req.method === 'POST' && pathname === '/api/register') {
    const { phone, code, password } = body;
    if (!phone || !/^1\d{10}$/.test(phone)) return json(res, { error: '请输入正确手机号' }, 400);
    if (!code) return json(res, { error: '请输入短信验证码' }, 400);
    if (!password || password.length < 6) return json(res, { error: '密码至少 6 位' }, 400);

    // 校验验证码
    const codeCheck = verifySmsCode(phone, code);
    if (!codeCheck.ok) return json(res, { error: codeCheck.error }, 400);

    const users = readJSON(USERS_FILE, {});
    if (users[phone]) return json(res, { error: '该手机号已注册，请直接登录' }, 409);

    users[phone] = {
      phone,
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
      aiCount: 0,
      lastActive: Date.now(),
    };
    writeJSON(USERS_FILE, users);

    // 同步到 MySQL（token 计数用）
    ensureDbUser(phone).catch(()=>{});

    const token = createToken({ username: phone });
    return json(res, { token, username: phone });
  }

  // POST /api/login — 手机号+密码登录
  if (req.method === 'POST' && pathname === '/api/login') {
    const { phone, password } = body;
    if (!phone || !password) return json(res, { error: '请输入手机号和密码' }, 400);

    const users = readJSON(USERS_FILE, {});
    const user = users[phone];
    if (!user) return json(res, { error: '手机号未注册' }, 401);
    if (!verifyPassword(password, user.passwordHash)) return json(res, { error: '密码错误' }, 401);

    users[phone].lastActive = Date.now();
    writeJSON(USERS_FILE, users);

    // 同步到 MySQL（token 计数用）
    ensureDbUser(phone).catch(()=>{});

    const token = createToken({ username: phone });
    return json(res, { token, username: phone });
  }

  // POST /api/reset-password — 手机号+验证码重置密码
  if (req.method === 'POST' && pathname === '/api/reset-password') {
    const { phone, code, newPassword } = body;
    if (!phone || !/^1\d{10}$/.test(phone)) return json(res, { error: '请输入正确手机号' }, 400);
    if (!code) return json(res, { error: '请输入短信验证码' }, 400);
    if (!newPassword || newPassword.length < 6) return json(res, { error: '密码至少 6 位' }, 400);

    const users = readJSON(USERS_FILE, {});
    if (!users[phone]) return json(res, { error: '该手机号未注册' }, 404);

    // 校验验证码
    const codeCheck = verifySmsCode(phone, code);
    if (!codeCheck.ok) return json(res, { error: codeCheck.error }, 400);

    users[phone].passwordHash = hashPassword(newPassword);
    writeJSON(USERS_FILE, users);

    return json(res, { ok: true });
  }

  // GET /api/me
  if (req.method === 'GET' && pathname === '/api/me') {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '未登录或登录已过期' }, 401);
    return json(res, { username: payload.username });
  }

  // /api/interpret — 已移除（紫微斗数模块待重构）

  // ===== Admin APIs =====
  
  // POST /api/admin/login
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    // Rate limit check
    if (admin.lockedUntil && Date.now() < admin.lockedUntil) {
      const remaining = Math.ceil((admin.lockedUntil - Date.now()) / 60000);
      return json(res, { error: `账号已锁定，${remaining} 分钟后重试` }, 429);
    }

    const { username, password } = body;
    if (!username || !password) return json(res, { error: '请输入用户名和密码' }, 400);
    if (username !== admin.username) {
      admin.loginAttempts = (admin.loginAttempts || 0) + 1;
      if (admin.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        admin.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      writeJSON(ADMIN_FILE, admin);
      return json(res, { error: '用户名或密码错误' }, 401);
    }
    if (!verifyPassword(password, admin.passwordHash)) {
      admin.loginAttempts = (admin.loginAttempts || 0) + 1;
      if (admin.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        admin.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      writeJSON(ADMIN_FILE, admin);
      return json(res, { error: '用户名或密码错误' }, 401);
    }

    // Login success — reset attempts
    admin.loginAttempts = 0;
    admin.lockedUntil = 0;
    writeJSON(ADMIN_FILE, admin);

    const token = createToken({ role: 'admin', exp: Date.now() + ADMIN_TOKEN_EXPIRY });
    return json(res, { token });
  }

  // GET /api/admin/verify
  if (req.method === 'GET' && pathname === '/api/admin/verify') {
    const payload = checkAuth(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    return json(res, { ok: true });
  }

  // GET /api/admin/stats
  if (req.method === 'GET' && pathname === '/api/admin/stats') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    return json(res, await getStats());
  }

  // GET /api/admin/users
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    return json(res, await getUsers());
  }

  // DELETE /api/admin/users/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/users/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.split('/').pop();
    try {
      // 同时删除该用户的所有命盘
      await db.query('DELETE FROM charts WHERE user_id = ?', [id]);
      deleteUser(id);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Delete user error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // GET /api/admin/user-tiers — 获取所有用户的等级信息（MySQL）
  if (req.method === 'GET' && pathname === '/api/admin/user-tiers') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query('SELECT username, tier, token_used FROM users');
      const map = {};
      rows.forEach(r => { map[r.username] = { tier: r.tier || 0, tokenUsed: r.token_used || 0 }; });
      return json(res, map);
    } catch (e) {
      console.error('Admin user-tiers error:', e);
      return json(res, { error: '查询失败' }, 500);
    }
  }

  // PATCH /api/admin/user-tier — 设置用户等级
  if (req.method === 'PATCH' && pathname === '/api/admin/user-tier') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const { username, tier } = body;
    if (!username || tier === undefined || tier < 0 || tier > 2) return json(res, { error: '参数错误' }, 400);
    try {
      // 确保用户在 MySQL 中存在
      await ensureDbUser(username);
      await db.query('UPDATE users SET tier = ? WHERE username = ?', [tier, username]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Admin set tier error:', e);
      return json(res, { error: '设置失败' }, 500);
    }
  }

  // PATCH /api/admin/user-tokens — 设置用户 token 用量
  if (req.method === 'PATCH' && pathname === '/api/admin/user-tokens') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const { username, tokenUsed } = body;
    if (!username || tokenUsed === undefined || tokenUsed < 0) return json(res, { error: '参数错误' }, 400);
    try {
      await ensureDbUser(username);
      await db.query('UPDATE users SET token_used = ? WHERE username = ?', [tokenUsed, username]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Admin set token error:', e);
      return json(res, { error: '设置失败' }, 500);
    }
  }

  // GET /api/admin/charts — 管理员查看所有命盘（支持 ?userId= 过滤）
  if (req.method === 'GET' && pathname === '/api/admin/charts') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const filterUserId = url.searchParams.get('userId');
    try {
      let query = 'SELECT id, user_id, name, gender, birth_year, birth_month, birth_day, birth_hour, calendar, true_solar, birthplace, created_at FROM charts';
      let params = [];
      if (filterUserId) {
        query += ' WHERE user_id = ?';
        params.push(filterUserId);
      }
      query += ' ORDER BY created_at DESC LIMIT 200';
      const [rows] = await db.query(query, params);
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        gender: r.gender,
        birth: { year: r.birth_year, month: r.birth_month, day: r.birth_day, hour: r.birth_hour, calendar: r.calendar },
        trueSolarTime: !!r.true_solar,
        birthplace: r.birthplace || '',
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin charts error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // DELETE /api/admin/charts/:id — 管理员删除命盘
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/charts/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.split('/').pop();
    try {
      await db.query('DELETE FROM charts WHERE id = ?', [id]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Admin delete chart error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // POST /api/admin/password — 修改管理密码
  if (req.method === 'POST' && pathname === '/api/admin/password') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return json(res, { error: '密码格式不正确' }, 400);
    }
    if (!verifyPassword(currentPassword, admin.passwordHash)) {
      return json(res, { error: '当前密码不正确' }, 401);
    }
    admin.passwordHash = hashPassword(newPassword);
    writeJSON(ADMIN_FILE, admin);
    return json(res, { ok: true });
  }

  // ===== Charts API (MySQL) =====

  // GET /api/charts — 获取用户的命盘列表
  if (req.method === 'GET' && pathname === '/api/charts') {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    try {
      const [rows] = await db.query(
        'SELECT id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, calendar, true_solar, birthplace, latitude, longitude, bazi, lunar_year, lunar_month, lunar_day, created_at FROM charts WHERE user_id = ? ORDER BY created_at DESC',
        [payload.username]
      );
      return json(res, rows.map(r => ({
        id: r.id,
        name: r.name,
        gender: r.gender,
        birth: { year: r.birth_year, month: r.birth_month, day: r.birth_day, hour: r.birth_hour, minute: r.birth_minute, calendar: r.calendar },
        trueSolarTime: !!r.true_solar,
        birthplace: r.birthplace || '',
        latitude: r.latitude,
        longitude: r.longitude,
        bazi: r.bazi,
        lunar: r.lunar_year ? { year: r.lunar_year, month: r.lunar_month, day: r.lunar_day } : null,
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('DB list error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // POST /api/charts — 创建命盘
  if (req.method === 'POST' && pathname === '/api/charts') {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    const { name, gender, birthYear, birthMonth, birthDay, birthHour, birthMinute, calendar, trueSolarTime, birthplace, latitude, longitude } = body;
    const id = 'chart_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    // 计算八字
    const baziResult = calcBazi(birthYear, birthMonth, birthDay, birthHour ?? 12, birthMinute ?? 0);
    try {
      await db.query(
        'INSERT INTO charts (id, user_id, name, gender, birth_year, birth_month, birth_day, birth_hour, birth_minute, calendar, true_solar, birthplace, latitude, longitude, bazi, lunar_year, lunar_month, lunar_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, payload.username, name || '未命名', gender || 'male', birthYear, birthMonth, birthDay, birthHour ?? 12, birthMinute ?? 0, calendar || 'gregorian', trueSolarTime ? 1 : 0, birthplace || '', latitude ?? null, longitude ?? null, baziResult ? baziResult.bazi : '', baziResult ? baziResult.lunarYear : null, baziResult ? baziResult.lunarMonth : null, baziResult ? baziResult.lunarDay : null, now, now]
      );
      return json(res, { id, createdAt: now, bazi: baziResult ? baziResult.bazi : null });
    } catch (e) {
      console.error('DB create error:', e);
      return json(res, { error: '保存失败' }, 500);
    }
  }

  // DELETE /api/charts/:id — 删除命盘
  if (req.method === 'DELETE' && pathname.startsWith('/api/charts/')) {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    const id = pathname.split('/').pop();
    try {
      await db.query('DELETE FROM charts WHERE id = ? AND user_id = ?', [id, payload.username]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('DB delete error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // PATCH /api/charts/:id — 更新命盘
  if (req.method === 'PATCH' && pathname.startsWith('/api/charts/') && pathname.split('/').length === 4) {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    const id = pathname.split('/').pop();
    try {
      const [rows] = await db.query('SELECT user_id FROM charts WHERE id = ?', [id]);
      if (rows.length === 0) return json(res, { error: '命盘不存在' }, 404);
      if (rows[0].user_id !== payload.username) return json(res, { error: '无权修改' }, 403);

      const { name, gender, birthYear, birthMonth, birthDay, birthHour, birthMinute, calendar, trueSolarTime, birthplace, latitude, longitude } = body;
      const now = Date.now();
      // 重新计算八字
      const baziResult = calcBazi(birthYear, birthMonth, birthDay, birthHour ?? 12, birthMinute ?? 0);
      await db.query(
        'UPDATE charts SET name = ?, gender = ?, birth_year = ?, birth_month = ?, birth_day = ?, birth_hour = ?, birth_minute = ?, calendar = ?, true_solar = ?, birthplace = ?, latitude = ?, longitude = ?, bazi = ?, lunar_year = ?, lunar_month = ?, lunar_day = ?, updated_at = ? WHERE id = ?',
        [name || '未命名', gender || 'male', birthYear, birthMonth, birthDay, birthHour ?? 12, birthMinute ?? 0, calendar || 'gregorian', trueSolarTime ? 1 : 0, birthplace || '', latitude ?? null, longitude ?? null, baziResult ? baziResult.bazi : '', baziResult ? baziResult.lunarYear : null, baziResult ? baziResult.lunarMonth : null, baziResult ? baziResult.lunarDay : null, now, id]
      );
      return json(res, { id, updatedAt: now, bazi: baziResult ? baziResult.bazi : null });
    } catch (e) {
      console.error('DB update error:', e);
      return json(res, { error: '更新失败' }, 500);
    }
  }

  // GET /api/charts/:id — 获取单个命盘
  if (req.method === 'GET' && pathname.startsWith('/api/charts/') && pathname.split('/').length === 4) {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    const id = pathname.split('/').pop();
    try {
      const [rows] = await db.query('SELECT * FROM charts WHERE id = ? AND user_id = ?', [id, payload.username]);
      if (rows.length === 0) return json(res, { error: '命盘不存在' }, 404);
      const r = rows[0];
      return json(res, {
        id: r.id, name: r.name, gender: r.gender,
        birth: { year: r.birth_year, month: r.birth_month, day: r.birth_day, hour: r.birth_hour, minute: r.birth_minute, calendar: r.calendar },
        trueSolarTime: !!r.true_solar, birthplace: r.birthplace || '',
        latitude: r.latitude, longitude: r.longitude,
        bazi: r.bazi, lunar: r.lunar_year ? { year: r.lunar_year, month: r.lunar_month, day: r.lunar_day } : null,
        createdAt: r.created_at,
      });
    } catch (e) {
      console.error('DB get error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // ===== 梅花易数排盘记录 API =====

  // GET /api/mhys-records — 获取排盘记录列表
  if (req.method === 'GET' && pathname === '/api/mhys-records') {
    const payload = checkAuth(req);
    if (!payload) return json(res, []);
    try {
      const [rows] = await db.query(
        'SELECT id, topic, method, created_at, result_data FROM mhys_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
        [payload.username]
      );
      return json(res, rows.map(r => {
        let divTime = null, recTime = null;
        try {
          const rd = typeof r.result_data === 'string' ? JSON.parse(r.result_data) : r.result_data;
          if (rd && rd.divinationTime) divTime = rd.divinationTime;
          if (rd && rd.recordTime) recTime = rd.recordTime;
        } catch(e) {}
        return {
          id: r.id,
          topic: r.topic,
          method: r.method,
          created_at: r.created_at,
          divinationTime: divTime,
          recordTime: recTime,
        };
      }));
    } catch (e) {
      console.error('Mhys list error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/mhys-records/:id — 获取单条排盘记录（管理员可查看任意记录）
  if (req.method === 'GET' && pathname.startsWith('/api/mhys-records/') && pathname.split('/').length === 4) {
    const payload = checkAuth(req);
    const id = pathname.split('/').pop();
    try {
      let rows;
      if (payload && payload.role === 'admin') {
        // 管理员：查看任意记录
        [rows] = await db.query('SELECT * FROM mhys_records WHERE id = ?', [id]);
      } else if (payload) {
        [rows] = await db.query('SELECT * FROM mhys_records WHERE id = ? AND (user_id = ? OR user_id IS NULL)', [id, payload.username]);
      } else {
        [rows] = await db.query('SELECT * FROM mhys_records WHERE id = ? AND user_id IS NULL', [id]);
      }
      if (rows.length === 0) return json(res, { error: '记录不存在' }, 404);
      const r = rows[0];
      return json(res, {
        id: r.id,
        topic: r.topic,
        method: r.method,
        result_data: r.result_data,
        ai_analysis: r.ai_analysis || '',
        created_at: r.created_at,
      });
    } catch (e) {
      console.error('Mhys get error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // POST /api/mhys-records — 创建排盘记录
  if (req.method === 'POST' && pathname === '/api/mhys-records') {
    const { topic, method, resultData } = body;
    if (!topic || !resultData) return json(res, { error: '缺少必要参数' }, 400);

    const payload = checkAuth(req);
    const userId = payload ? payload.username : null;
    const id = 'mhys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    try {
      await db.query(
        'INSERT INTO mhys_records (id, user_id, topic, method, result_data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, userId, topic, method || 'unknown', JSON.stringify(resultData), now]
      );
      return json(res, { id, created_at: now });
    } catch (e) {
      console.error('Mhys create error:', e);
      return json(res, { error: '保存失败' }, 500);
    }
  }

  // PATCH /api/mhys-records/:id/ai — 保存AI解读结果
  if (req.method === 'PATCH' && pathname.match(/^\/api\/mhys-records\/[^/]+\/ai$/)) {
    const id = pathname.split('/')[3];
    const { analysis } = body;
    if (!analysis) return json(res, { error: '缺少解读内容' }, 400);
    try {
      // 不要求登录——临时排盘也能存（不过临时记录可能没topic所以不会保存到这里）
      const [existing] = await db.query('SELECT id FROM mhys_records WHERE id = ?', [id]);
      if (existing.length === 0) return json(res, { error: '记录不存在' }, 404);
      await db.query('UPDATE mhys_records SET ai_analysis = ? WHERE id = ?', [analysis, id]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Mhys AI save error:', e);
      return json(res, { error: '保存失败' }, 500);
    }
  }

  // DELETE /api/mhys-records/:id — 删除排盘记录
  if (req.method === 'DELETE' && pathname.startsWith('/api/mhys-records/') && pathname.split('/').length === 4) {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    const id = pathname.split('/').pop();
    try {
      await db.query('DELETE FROM mhys_records WHERE id = ? AND user_id = ?', [id, payload.username]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Mhys delete error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // ===== 六爻排盘记录 API =====

  // GET /api/liuyao-records — 获取排盘记录列表
  if (req.method === 'GET' && pathname === '/api/liuyao-records') {
    const payload = checkAuth(req);
    if (!payload) return json(res, []);
    try {
      const [rows] = await db.query(
        'SELECT id, topic, method, created_at, result_data FROM liuyao_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
        [payload.username]
      );
      return json(res, rows.map(r => {
        let divTime = null, recTime = null;
        try {
          const rd = typeof r.result_data === 'string' ? JSON.parse(r.result_data) : r.result_data;
          if (rd && rd.divinationTime) divTime = rd.divinationTime;
          if (rd && rd.recordTime) recTime = rd.recordTime;
        } catch(e) {}
        return {
          id: r.id,
          topic: r.topic,
          method: r.method,
          created_at: r.created_at,
          divinationTime: divTime,
          recordTime: recTime,
        };
      }));
    } catch (e) {
      console.error('Liuyao list error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/liuyao-records/:id — 获取单条排盘记录（管理员可查看任意记录）
  if (req.method === 'GET' && pathname.startsWith('/api/liuyao-records/') && pathname.split('/').length === 4) {
    const payload = checkAuth(req);
    const id = pathname.split('/').pop();
    try {
      let rows;
      if (payload && payload.role === 'admin') {
        // 管理员：查看任意记录
        [rows] = await db.query('SELECT * FROM liuyao_records WHERE id = ?', [id]);
      } else if (payload) {
        [rows] = await db.query('SELECT * FROM liuyao_records WHERE id = ? AND (user_id = ? OR user_id IS NULL)', [id, payload.username]);
      } else {
        [rows] = await db.query('SELECT * FROM liuyao_records WHERE id = ? AND user_id IS NULL', [id]);
      }
      if (rows.length === 0) return json(res, { error: '记录不存在' }, 404);
      const r = rows[0];
      return json(res, {
        id: r.id,
        topic: r.topic,
        method: r.method,
        result_data: r.result_data,
        ai_analysis: r.ai_analysis || '',
        created_at: r.created_at,
      });
    } catch (e) {
      console.error('Liuyao get error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // POST /api/liuyao-records — 创建排盘记录
  if (req.method === 'POST' && pathname === '/api/liuyao-records') {
    const { topic, method, resultData } = body;
    if (!topic || !resultData) return json(res, { error: '缺少必要参数' }, 400);

    const payload = checkAuth(req);
    const userId = payload ? payload.username : null;
    const id = 'ly_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    try {
      await db.query(
        'INSERT INTO liuyao_records (id, user_id, topic, method, result_data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, userId, topic, method || 'coin', JSON.stringify(resultData), now]
      );
      return json(res, { id, created_at: now });
    } catch (e) {
      console.error('Liuyao create error:', e);
      return json(res, { error: '保存失败' }, 500);
    }
  }

  // PATCH /api/liuyao-records/:id/ai — 保存AI解读结果
  if (req.method === 'PATCH' && pathname.match(/^\/api\/liuyao-records\/[^/]+\/ai$/)) {
    const id = pathname.split('/')[3];
    const { analysis } = body;
    if (!analysis) return json(res, { error: '缺少解读内容' }, 400);
    try {
      const [existing] = await db.query('SELECT id FROM liuyao_records WHERE id = ?', [id]);
      if (existing.length === 0) return json(res, { error: '记录不存在' }, 404);
      await db.query('UPDATE liuyao_records SET ai_analysis = ? WHERE id = ?', [analysis, id]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Liuyao AI save error:', e);
      return json(res, { error: '保存失败' }, 500);
    }
  }

  // DELETE /api/liuyao-records/:id — 删除排盘记录
  if (req.method === 'DELETE' && pathname.startsWith('/api/liuyao-records/') && pathname.split('/').length === 4) {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    const id = pathname.split('/').pop();
    try {
      await db.query('DELETE FROM liuyao_records WHERE id = ? AND user_id = ?', [id, payload.username]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Liuyao delete error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // GET /api/admin/mhys-records — 管理员查看所有排盘记录
  if (req.method === 'GET' && pathname === '/api/admin/mhys-records') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        'SELECT id, user_id, topic, method, created_at FROM mhys_records ORDER BY created_at DESC LIMIT 200'
      );
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        topic: r.topic,
        method: r.method,
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin mhys list error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // DELETE /api/admin/mhys-records/:id — 管理员删除排盘记录
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/mhys-records/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.split('/').pop();
    try {
      await db.query('DELETE FROM mhys_records WHERE id = ?', [id]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Admin mhys delete error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // GET /api/admin/liuyao-records — 管理员查看所有六爻排盘记录
  if (req.method === 'GET' && pathname === '/api/admin/liuyao-records') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        'SELECT id, user_id, topic, method, created_at FROM liuyao_records ORDER BY created_at DESC LIMIT 200'
      );
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        topic: r.topic,
        method: r.method,
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin liuyao list error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // DELETE /api/admin/liuyao-records/:id — 管理员删除六爻排盘记录
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/liuyao-records/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.split('/').pop();
    try {
      await db.query('DELETE FROM liuyao_records WHERE id = ?', [id]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Admin liuyao delete error:', e);
      return json(res, { error: '删除失败' }, 500);
    }
  }

  // ===== 梅花易数 AI 解析 API（流式） =====
  // POST /api/mhys/ai-analyze — AI智能解卦（SSE流式 + RAG检索）
  if (req.method === 'POST' && pathname === '/api/mhys/ai-analyze') {
    const { topic, hexagrams, followUp, context, recordId } = body;
    if (!hexagrams) return json(res, { error: '缺少必要参数' }, 400);

    // Token 限制检查（已登录用户）
    const payload = checkAuth(req);
    const username = payload ? payload.username : null;
    if (username) {
      try {
        const [rows] = await db.query('SELECT token_used, tier FROM users WHERE username = ?', [username]);
        if (rows.length > 0) {
          const tier = rows[0].tier || 0;
          const limit = getTokenLimit(tier);
          if (limit !== null && rows[0].token_used >= limit) {
            res.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-cache',
            });
            res.write('抱歉，你的AI解析次数已用完。');
            res.write('如需继续使用，请联系管理员升级账户。');
            res.end();
            return;
          }
        }
      } catch (e) { /* 数据库错误不阻塞 */ }
    }

    // RAG 检索：搜索 meihua + yijing 分类
    let ragContext = '';
    let ragSources = [];
    try {
      const searchQuery = topic || (hexagrams.benGua ? hexagrams.benGua.name + '卦' : '梅花易数解卦');
      const ragRes = await fetch('http://localhost:8800/api/retrieve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, top_k: 3, categories: ['meihua', 'yijing'], similarity_threshold: 0.3 }),
      });
      const ragData = await ragRes.json();
      if (ragData.results && ragData.results.length > 0) {
        ragContext = ragData.results.map((r, i) => `【古籍 ${i + 1}】《${r.book_name}》${r.chapter ? ' - ' + r.chapter : ''}\n${r.text}`).join('\n\n');
        // 去重来源书籍
        const seen = new Set();
        ragSources = ragData.results.filter(r => { const k = r.book_name; return seen.has(k) ? false : seen.add(k); }).map(r => r.book_name);
      }
    } catch (e) { console.error('RAG retrieve error:', e.message); }

    const prompt = followUp
      ? (topic ? buildFollowUpPrompt(topic, followUp, context, hexagrams) : buildMhysPrompt(followUp, hexagrams))
      : buildMhysPrompt(topic, hexagrams, ragContext);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      // 参考古籍通过 header 传给前端
      const ragHeader = ragSources.length > 0 ? ragSources.join("|") : "";
      res.setHeader("X-Rag-Sources", ragHeader);
      // 先估算输入 token
      const inputTokens = estimateTokens(prompt);
      const outputText = await streamDeepSeek(prompt, res, username ? 0 : 1200);
      // 流完成后计数 token 并更新（即使用户已断开也继续执行）
      if (outputText && username) {
        const outputTokens = estimateTokens(outputText);
        const totalTokens = inputTokens + outputTokens;
        try {
          await db.query('UPDATE users SET token_used = token_used + ? WHERE username = ?', [totalTokens, username]);
          const [updated] = await db.query('SELECT token_used, tier FROM users WHERE username = ?', [username]);
          if (updated.length > 0) {
            var used = updated[0].token_used;
            var limit = getTokenLimit(updated[0].tier || 0);
            var remainText = limit === null ? '无限' : (limit - used).toLocaleString();
            res.write('\n\n---\n消耗 Token：输入 ' + inputTokens + ' + 输出 ' + outputTokens + ' = ' + totalTokens + ' ｜ 剩余：' + remainText);
          }
        } catch (e) { /* 静默失败 */ }
      }

      // 后台自动保存到排盘记录（即使用户已断开页面）
      if (outputText && recordId) {
        let analysisText = outputText;
        const tokenIdx = analysisText.lastIndexOf('\n消耗 Token：');
        if (tokenIdx > 0) analysisText = analysisText.substring(0, tokenIdx).trim();
        try {
          await db.query('UPDATE mhys_records SET ai_analysis = ? WHERE id = ?', [analysisText, recordId]);
        } catch (e) { console.error('Mhys auto-save error:', e); }
      }
      res.end();
    } catch (e) {
      console.error('Mhys AI stream error:', e.message);
      if (!res.writableEnded) {
        try { res.write('data: [ERROR] 解卦中断，请稍后重试\n\n'); } catch {}
        try { res.end(); } catch {}
      }
    }
    return;
  }

  // POST /api/liuyao/ai-analyze — 六爻AI智能解卦（SSE流式 + RAG检索）
  if (req.method === 'POST' && pathname === '/api/liuyao/ai-analyze') {
    const { topic, hexagrams, followUp, context, recordId } = body;
    if (!hexagrams) return json(res, { error: '缺少必要参数' }, 400);

    const payload = checkAuth(req);
    const username = payload ? payload.username : null;
    if (username) {
      try {
        const [rows] = await db.query('SELECT token_used, tier FROM users WHERE username = ?', [username]);
        if (rows.length > 0) {
          const tier = rows[0].tier || 0;
          const limit = getTokenLimit(tier);
          if (limit !== null && rows[0].token_used >= limit) {
            res.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-cache',
            });
            res.write('抱歉，你的AI解析次数已用完。');
            res.write('如需继续使用，请联系管理员升级账户。');
            res.end();
            return;
          }
        }
      } catch (e) { /* 静默 */ }
    }

    // RAG 检索：使用 liuyao + yijing 分类，多维度检索
    let ragContext = '';
    let ragSources = [];
    try {
      const benGuaName = hexagrams.benGua ? hexagrams.benGua.name : '';
      // 构建结构化检索查询：融合卦名+事项+断卦方法论关键要素
      const searchQueries = [
        topic ? (topic + ' ' + benGuaName) : (benGuaName || '六爻解卦'),
        benGuaName + ' 用神 世应 动爻 六亲',
        benGuaName + ' 空亡 月破 应期 生克',
      ];
      const allResults = [];
      for (const q of searchQueries.slice(0, 2)) {  // 取前2个查询，避免太多
        const ragRes = await fetch('http://localhost:8800/api/retrieve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, top_k: 3, categories: ['liuyao', 'yijing'], similarity_threshold: 0.3 }),
        });
        const ragData = await ragRes.json();
        if (ragData.results) allResults.push(...ragData.results);
      }
      // 去重并按分数排序
      const seen = new Set();
      const unique = [];
      allResults.sort((a, b) => b.score - a.score);
      for (const r of allResults) {
        const key = r.text.slice(0, 60);
        if (!seen.has(key)) { seen.add(key); unique.push(r); }
      }
      const topResults = unique.slice(0, 3);
      if (topResults.length > 0) {
        ragContext = topResults.map((r, i) => `【古籍 ${i + 1}】《${r.book_name}》${r.chapter ? ' - ' + r.chapter : ''}
${r.text}`).join('\n\n');
        const seenBooks = new Set();
        ragSources = topResults.filter(r => { const k = r.book_name; return seenBooks.has(k) ? false : seenBooks.add(k); }).map(r => r.book_name);
      }
    } catch (e) { console.error('Liuyao RAG error:', e.message); }

    const prompt = followUp
      ? (topic ? buildLiuyaoFollowUpPrompt(topic, followUp, context, hexagrams) : buildLiuyaoPrompt(followUp, hexagrams))
      : buildLiuyaoPrompt(topic, hexagrams, ragContext);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      // 参考古籍通过 header 传给前端，不在流前输出（避免用户误以为卡住）
      const ragHeader = ragSources.length > 0 ? ragSources.join('|') : '';
      res.setHeader('X-Rag-Sources', ragHeader);
      // 先估算输入 token
      const inputTokens = estimateTokens(prompt);
      const outputText = await streamDeepSeekLiuyao(prompt, res, username ? 0 : 1200);
      // 流完成后计数 token 并更新（即使用户已断开也继续执行）
      if (outputText && username) {
        const outputTokens = estimateTokens(outputText);
        const totalTokens = inputTokens + outputTokens;
        try {
          await db.query('UPDATE users SET token_used = token_used + ? WHERE username = ?', [totalTokens, username]);
          const [updated] = await db.query('SELECT token_used, tier FROM users WHERE username = ?', [username]);
          if (updated.length > 0) {
            var used = updated[0].token_used;
            var limit = getTokenLimit(updated[0].tier || 0);
            var remainText = limit === null ? '无限' : (limit - used).toLocaleString();
            res.write('\n\n---\n消耗 Token：输入 ' + inputTokens + ' + 输出 ' + outputTokens + ' = ' + totalTokens + ' ｜ 剩余：' + remainText);
          }
        } catch (e) { /* 静默 */ }
      }

      // 后台自动保存到排盘记录（即使用户已断开页面）
      if (outputText && recordId) {
        let analysisText = outputText;
        const tokenIdx = analysisText.lastIndexOf('\n消耗 Token：');
        if (tokenIdx > 0) analysisText = analysisText.substring(0, tokenIdx).trim();
        try {
          await db.query('UPDATE liuyao_records SET ai_analysis = ? WHERE id = ?', [analysisText, recordId]);
        } catch (e) { console.error('Liuyao auto-save error:', e); }
      }
      res.end();
    } catch (e) {
      console.error('Liuyao AI stream error:', e.message);
      if (!res.writableEnded) {
        try { res.write('data: [ERROR] 解卦中断，请稍后重试\n\n'); } catch {}
        try { res.end(); } catch {}
      }
    }
    return;
  }

  // ===== 用户 Token 用量 API =====
  // GET /api/user/tokens — 获取当前用户的 token 用量
  if (req.method === 'GET' && pathname === '/api/user/tokens') {
    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录' }, 401);
    try {
      // 确保用户在 MySQL 中存在（首次查询时自动创建）
      await ensureDbUser(payload.username);
      const [rows] = await db.query('SELECT token_used, tier FROM users WHERE username = ?', [payload.username]);
      if (rows.length === 0) return json(res, { tokenUsed: 0, tokenLimit: 100000, tier: 0 });
      const tier = rows[0].tier || 0;
      const tokenLimit = getTokenLimit(tier);
      return json(res, { tokenUsed: rows[0].token_used, tokenLimit, tier });
    } catch (e) {
      console.error('Token usage error:', e);
      return json(res, { error: '查询失败' }, 500);
    }
  }

  // GET /api/admin/divination-users — 管理员查看有排盘记录的用户（分组卡片，含梅花+六爻）
  if (req.method === 'GET' && pathname === '/api/admin/divination-users') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      // 合并两个表的用户
      const [mhysRows] = await db.query(
        `SELECT user_id, COUNT(*) as cnt, MAX(created_at) as latest
         FROM mhys_records WHERE user_id IS NOT NULL AND user_id != '' GROUP BY user_id`
      );
      const [lyRows] = await db.query(
        `SELECT user_id, COUNT(*) as cnt, MAX(created_at) as latest
         FROM liuyao_records WHERE user_id IS NOT NULL AND user_id != '' GROUP BY user_id`
      );
      // 合并
      const userMap = {};
      for (const r of mhysRows) {
        userMap[r.user_id] = { userId: r.user_id, mhysCount: r.cnt, liuyaoCount: 0, latestAt: r.latest };
      }
      for (const r of lyRows) {
        if (userMap[r.user_id]) {
          userMap[r.user_id].liuyaoCount = r.cnt;
          if (new Date(r.latest) > new Date(userMap[r.user_id].latestAt)) userMap[r.user_id].latestAt = r.latest;
        } else {
          userMap[r.user_id] = { userId: r.user_id, mhysCount: 0, liuyaoCount: r.cnt, latestAt: r.latest };
        }
      }
      const users = Object.values(userMap).sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
      return json(res, users);
    } catch (e) {
      console.error('Admin divination users error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/divination-records/:userId — 管理员查看某用户的所有排盘记录（梅花+六爻）
  if (req.method === 'GET' && pathname.startsWith('/api/admin/divination-records/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const urlParts = pathname.split('/');
    const userId = urlParts[urlParts.length - 1];
    try {
      // 并行查询两个表
      const [mhysRows] = await db.query(
        'SELECT id, user_id, topic, method, result_data, created_at FROM mhys_records WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
      const [lyRows] = await db.query(
        'SELECT id, user_id, topic, method, result_data, created_at FROM liuyao_records WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );

      const mapRow = (r, type) => {
        let divTime = null;
        try {
          const rd = typeof r.result_data === 'string' ? JSON.parse(r.result_data) : r.result_data;
          if (rd && rd.divinationTime) divTime = rd.divinationTime;
        } catch(e) {}
        return {
          id: r.id,
          userId: r.user_id,
          topic: r.topic,
          method: r.method,
          resultData: r.result_data,
          createdAt: r.created_at,
          divinationTime: divTime,
          type: type,
        };
      };

      const records = [
        ...mhysRows.map(r => mapRow(r, 'mhys')),
        ...lyRows.map(r => mapRow(r, 'liuyao')),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return json(res, records);
    } catch (e) {
      console.error('Admin divination records error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/chart-users — 管理员查看有命盘的用户（分组卡片）
  if (req.method === 'GET' && pathname === '/api/admin/chart-users') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        `SELECT user_id, COUNT(*) as count, MAX(created_at) as latest
         FROM charts
         GROUP BY user_id
         ORDER BY latest DESC`
      );
      return json(res, rows.map(r => ({
        userId: r.user_id,
        count: r.count,
        latestAt: r.latest,
      })));
    } catch (e) {
      console.error('Admin chart users error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/charts-flat — 管理员查看所有命盘（扁平列表，供卡片跳转）
  if (req.method === 'GET' && pathname === '/api/admin/charts-flat') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        'SELECT id, user_id, name, gender, birth_year, birth_month, birth_day, birth_hour, calendar, true_solar, birthplace, created_at FROM charts ORDER BY created_at DESC LIMIT 200'
      );
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        gender: r.gender,
        birth: { year: r.birth_year, month: r.birth_month, day: r.birth_day, hour: r.birth_hour, calendar: r.calendar },
        trueSolarTime: !!r.true_solar,
        birthplace: r.birthplace || '',
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin charts-flat error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/mhys-flat — 管理员查看所有排盘记录（扁平列表，供卡片跳转）

  // ══════ Prompt 管理 API ══════

  // GET /api/admin/prompts — 获取所有 prompt 模板（含默认值）
  if (req.method === 'GET' && pathname === '/api/admin/prompts') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    var custom = readPrompts();
    var defaults = {
      mhys_system: '你是梅花易数解卦师。回答清晰、理性、有启发性，避免绝对化断语，多用"可能""倾向"。可主动反问补充背景。',
      mhys_prompt: '以下是一组梅花易数排盘数据。\n\n【求测事项】{{topic}}\n\n【卦象】\n本卦：{{benGuaUpper}}上{{benGuaLower}}下 → {{benGuaName}}\n互卦：{{huGuaUpper}}上{{huGuaLower}}下 → {{huGuaName}}\n变卦：{{bianGuaUpper}}上{{bianGuaLower}}下 → {{bianGuaName}}\n错卦：{{cuoGuaUpper}}上{{cuoGuaLower}}下 → {{cuoGuaName}}\n综卦：{{zongGuaUpper}}上{{zongGuaLower}}下 → {{zongGuaName}}\n\n【体用】体卦：{{tiName}}（{{tiElement}}）｜用卦：{{yongName}}（{{yongElement}}）\n生克：{{tiyongVerdict}} — {{tiyongDesc}}\n动爻：{{movingYao}}\n\n请按三段回复，每段以"---"分隔：\n\n【一、回答】大白话直接说结论（吉/凶/平/转机），结合变卦判断走向。不含卦象推导术语。\n\n【二、现状】用本卦说当前状况，用互卦点隐藏变数。也说大白话，不出现卦象推导。\n\n【三、解卦思路】推演：本卦定大局→互卦析过程→变卦断结局，错综对照。说明体用生克影响。可含卦象术语。末尾提醒卦象非绝对。\n\n避免绝对化断语（"必死""大吉"等），多用"可能""倾向"。语气干脆老练。用**加粗**标结论重点（会显示金色），###子标题适度。\n\n{{ragContext}}\n\n【四、补充】末尾引导用户补充背景："如有更多具体情况可补充，方便做更细致解读"——语气自然，单独一段。',
      mhys_notopic: '你是一位梅花易数解卦师。用户还没说问什么事，请用一句话简短询问。',
      mhys_followup: '针对「{{topic}}」的追问：\n\n【之前解读】{{context}}\n\n【追问】{{followUp}}\n\n请直接回答追问，不重复完整分析。结构：\n【一、回答】——结论和建议，不用卦象术语。\n【二、思路】（可选）——一两句推演依据。',
      liuyao_system: '你是六爻纳甲解卦师。断卦必须严格遵循七层标准流程：①定用神（据事项性别取六亲）→②看世应（世为己应为人，分人我吉凶）→③察日月（日主月提定旺衰，爻不敌日月）→④辨动爻（动为变化之机，独发力量最大）→⑤析生克（元神生用则吉，忌神克用则凶，贪生贪合可忘克）→⑥审空亡月破（辨真空假空，空忌吉空用凶）→⑦推应期（出空填实、冲墓冲合、生旺墓绝）。输出分三块：结论（直说吉凶，人话）→现状（世应六神说当下）→推演（七层逐步展开，引具体爻位六亲六神，含应期判断）。避免绝对断语，多用可能/倾向。用**加粗**标重点。',
      liuyao_prompt: '以下是一组六爻排盘数据。请严格按照六爻断卦标准流程逐层分析。\n\n【求测事项】{{topic}}\n【求测者性别】{{gender}}\n\n【卦象】\n本卦：{{benGuaUpper}}上{{benGuaLower}}下 → {{benGuaName}}\n变卦：{{bianGuaUpper}}上{{bianGuaLower}}下 → {{bianGuaName}}\n\n══════ 断卦方法论（必须逐层执行） ══════\n\n【第一层·定用神】根据求测事项和性别确定用神……（可复制现有完整模板，变量用 {{变量名}} 替换）\n\n请严格按以下结构回复，每段以"---"分隔：\n\n【一、结论】直接说吉凶结论，1-2句话。结合用神旺衰与忌神动否。大白话。\n\n【二、现状分析】描述当前状况：世应关系、六神氛围、爻位事态阶段。不出现推导。\n\n【三、解卦推演】按七层方法论逐步推演，引用具体爻位六亲六神，含应期判断。可含术语。\n\n用**加粗**标重点。避免绝对化断语。\n\n{{ragContext}}\n\n【补充引导】末尾引导用户补充背景。',
      liuyao_notopic: '你是一位六爻纳甲解卦师。用户还没说问什么事，请先回应排盘数据（本卦变卦名+世应位置），然后用一句话询问求测事项。',
      liuyao_followup: '针对「{{topic}}」的追问：\n\n【之前解读】{{context}}\n\n【追问】{{followUp}}\n\n直接回答追问，不重复完整七层分析。聚焦追问涉及的层面。结构：\n【回答】——结论和建议，不用卦象术语。\n【依据】——简短推演依据（1-3句，引用原卦爻位）。',
    };
    var keys = Object.keys(defaults);
    var list = keys.map(function(k) {
      return {
        key: k,
        defaultValue: defaults[k],
        customValue: custom[k] || null,
        isCustom: !!custom[k],
      };
    });
    return json(res, list);
  }

  // POST /api/admin/prompts/:key — 保存/更新自定义 prompt
  if (req.method === 'POST' && pathname.startsWith('/api/admin/prompts/') && pathname.split('/').length === 5) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const key = pathname.split('/').pop();
    var custom = readPrompts();
    custom[key] = body.value || '';
    writePrompts(custom);
    return json(res, { ok: true, key: key });
  }

  // DELETE /api/admin/prompts/:key — 重置为默认
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/prompts/') && pathname.split('/').length === 5) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const key = pathname.split('/').pop();
    var custom = readPrompts();
    delete custom[key];
    writePrompts(custom);
    return json(res, { ok: true, key: key });
  }

  // ===== 建议（Suggestions）API =====

  // POST /api/suggestions — 提交建议（需登录）
  if (req.method === 'POST' && pathname === '/api/suggestions') {
    const { overall, ui, feature, ai, responseSpeed, accuracy, content } = body;
    if (!content || !content.trim()) return json(res, { error: '请输入具体建议内容' }, 400);

    const payload = checkAuth(req);
    if (!payload) return json(res, { error: '请先登录后再提交建议' }, 401);
    const userId = payload.username;
    const id = 'sug_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const now = Date.now();

    try {
      await db.query(
        'INSERT INTO suggestions (id, user_id, username, overall_rating, ui_rating, feature_rating, ai_rating, response_speed_rating, accuracy_rating, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, userId, userId, overall || 0, ui || 0, feature || 0, ai || 0, responseSpeed || 0, accuracy || 0, content.trim(), now]
      );
      // 每个用户只保留最新的 3 条建议，防止恶意刷内存
      const [[{ cnt }]] = await db.query('SELECT COUNT(*) as cnt FROM suggestions WHERE user_id = ?', [userId]);
      if (cnt > 3) {
        const excess = cnt - 3;
        await db.query(
          'DELETE FROM suggestions WHERE user_id = ? ORDER BY created_at ASC LIMIT ?',
          [userId, excess]
        );
      }
      return json(res, { ok: true, id });
    } catch (e) {
      console.error('Suggestion save error:', e);
      return json(res, { error: '保存失败' }, 500);
    }
  }

  // GET /api/admin/suggestion-users — 管理员查看提交过建议的用户（分组卡片）
  if (req.method === 'GET' && pathname === '/api/admin/suggestion-users') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        `SELECT user_id, COUNT(*) as count, MAX(created_at) as latest
         FROM suggestions
         WHERE user_id IS NOT NULL AND user_id != 'anonymous'
         GROUP BY user_id
         ORDER BY latest DESC`
      );
      return json(res, rows.map(r => ({
        userId: r.user_id,
        count: r.count,
        latestAt: r.latest,
      })));
    } catch (e) {
      console.error('Admin suggestion users error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/suggestion-detail/:userId — 管理员查看某用户的建议详情
  if (req.method === 'GET' && pathname.startsWith('/api/admin/suggestion-detail/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const userId = pathname.split('/').pop();
    try {
      const [rows] = await db.query(
        'SELECT id, user_id, username, overall_rating, ui_rating, feature_rating, ai_rating, response_speed_rating, accuracy_rating, content, created_at FROM suggestions WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        ratings: {
          overall: r.overall_rating,
          ui: r.ui_rating,
          feature: r.feature_rating,
          ai: r.ai_rating,
          responseSpeed: r.response_speed_rating,
          accuracy: r.accuracy_rating,
        },
        content: r.content,
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin suggestion detail error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/suggestions — 管理员查看所有建议
  if (req.method === 'GET' && pathname === '/api/admin/suggestions') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        'SELECT id, user_id, username, overall_rating, ui_rating, feature_rating, ai_rating, response_speed_rating, accuracy_rating, content, created_at FROM suggestions ORDER BY created_at DESC LIMIT 200'
      );
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        ratings: {
          overall: r.overall_rating,
          ui: r.ui_rating,
          feature: r.feature_rating,
          ai: r.ai_rating,
          responseSpeed: r.response_speed_rating,
          accuracy: r.accuracy_rating,
        },
        content: r.content,
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin suggestions error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  if (req.method === 'GET' && pathname === '/api/admin/mhys-flat') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query(
        'SELECT id, user_id, topic, method, created_at FROM mhys_records ORDER BY created_at DESC LIMIT 200'
      );
      return json(res, rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        topic: r.topic,
        method: r.method,
        createdAt: r.created_at,
      })));
    } catch (e) {
      console.error('Admin mhys-flat error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/chart-detail/:id — 管理员获取单个命盘详情
  if (req.method === 'GET' && pathname.startsWith('/api/admin/chart-detail/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.replace('/api/admin/chart-detail/', '');
    try {
      const [rows] = await db.query('SELECT * FROM charts WHERE id = ?', [id]);
      if (rows.length === 0) return json(res, { error: '命盘不存在' }, 404);
      const r = rows[0];
      return json(res, {
        id: r.id, name: r.name, gender: r.gender,
        birth: { year: r.birth_year, month: r.birth_month, day: r.birth_day, hour: r.birth_hour, minute: r.birth_minute, calendar: r.calendar },
        trueSolarTime: !!r.true_solar, birthplace: r.birthplace || '',
        latitude: r.latitude, longitude: r.longitude,
        bazi: r.bazi, lunar: r.lunar_year ? { year: r.lunar_year, month: r.lunar_month, day: r.lunar_day } : null,
        createdAt: r.created_at,
      });
    } catch (e) {
      console.error('Admin chart-detail error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // ===== 参考书籍管理 =====

  // GET /api/admin/books — 获取书籍列表（支持 ?category= & ?folder= 筛选）
  if (req.method === 'GET' && pathname === '/api/admin/books') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const url = new URL(req.url, 'http://localhost');
      const cat = url.searchParams.get('category') || '';
      const folder = url.searchParams.get('folder') || '';
      let query = 'SELECT id, title, category, folder, author, description, status, chunks_count, created_at, updated_at FROM reference_books WHERE 1=1';
      let params = [];
      if (cat) { query += ' AND category = ?'; params.push(cat); }
      if (folder) { query += ' AND folder = ?'; params.push(folder); }
      query += ' ORDER BY folder, category, created_at DESC';
      const [rows] = await db.query(query, params);
      return json(res, rows.map(r => ({
        id: r.id,
        title: r.title,
        category: r.category,
        folder: r.folder || '',
        author: r.author || '',
        description: r.description || '',
        status: r.status || 'pending',
        chunksCount: r.chunks_count || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })));
    } catch (e) {
      console.error('Admin books list error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // POST /api/admin/books — 添加书籍
  if (req.method === 'POST' && pathname === '/api/admin/books') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      if (!body.title || !body.category) return json(res, { error: '书名和分类不能为空' }, 400);
      const now = Date.now();
      const [result] = await db.query(
        'INSERT INTO reference_books (title, category, folder, author, description, content, status, chunks_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          body.title,
          body.category,
          body.folder || '',
          body.author || '',
          body.description || '',
          body.content || '',
          'pending',
          0,
          now,
          now,
        ]
      );
      return json(res, { id: result.insertId, title: body.title, category: body.category, folder: body.folder || '', status: 'pending', chunksCount: 0, createdAt: now, updatedAt: now });
    } catch (e) {
      console.error('Admin books add error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // GET /api/admin/books/:id — 获取单本书详情（含全文）
  if (req.method === 'GET' && pathname.startsWith('/api/admin/books/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.replace('/api/admin/books/', '');
    try {
      const [rows] = await db.query('SELECT * FROM reference_books WHERE id = ?', [id]);
      if (rows.length === 0) return json(res, { error: '书籍不存在' }, 404);
      const r = rows[0];
      return json(res, {
        id: r.id,
        title: r.title,
        category: r.category,
        folder: r.folder || '',
        author: r.author || '',
        description: r.description || '',
        content: r.content || '',
        status: r.status || 'pending',
        chunksCount: r.chunks_count || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    } catch (e) {
      console.error('Admin books detail error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // PATCH /api/admin/books/:id — 更新书籍
  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/books/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.replace('/api/admin/books/', '');
    try {
      const fields = [];
      const values = [];
      if (body.title !== undefined) { fields.push('title = ?'); values.push(body.title); }
      if (body.category !== undefined) { fields.push('category = ?'); values.push(body.category); }
      if (body.folder !== undefined) { fields.push('folder = ?'); values.push(body.folder); }
      if (body.author !== undefined) { fields.push('author = ?'); values.push(body.author); }
      if (body.description !== undefined) { fields.push('description = ?'); values.push(body.description); }
      if (body.content !== undefined) { fields.push('content = ?'); values.push(body.content); }
      if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
      if (body.chunksCount !== undefined) { fields.push('chunks_count = ?'); values.push(body.chunksCount); }
      if (!fields.length) return json(res, { error: '没有需要更新的字段' }, 400);
      fields.push('updated_at = ?');
      values.push(Date.now(), id);
      await db.query(`UPDATE reference_books SET ${fields.join(', ')} WHERE id = ?`, values);
      return json(res, { id: parseInt(id), ok: true });
    } catch (e) {
      console.error('Admin books update error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // DELETE /api/admin/books/:id — 删除书籍
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/books/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.replace('/api/admin/books/', '');
    try {
      await db.query('DELETE FROM reference_books WHERE id = ?', [id]);
      return json(res, { ok: true });
    } catch (e) {
      console.error('Admin books delete error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // POST /api/admin/books/ingest/:id — 单本书入库到向量知识库
  if (req.method === 'POST' && pathname.startsWith('/api/admin/books/ingest/')) {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    const id = pathname.replace('/api/admin/books/ingest/', '');
    try {
      const [rows] = await db.query('SELECT * FROM reference_books WHERE id = ?', [id]);
      if (!rows.length) return json(res, { error: '书籍不存在' }, 404);
      const book = rows[0];
      if (!book.content) return json(res, { error: '书籍内容为空' }, 400);

      // 调用 RAG 后端入库
      const ragRes = await fetch('http://localhost:8800/api/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_name: book.title, category: book.category, content: book.content, chapter: '', metadata: {} }),
      });
      const ragData = await ragRes.json();

      if (ragRes.ok && ragData.chunks_created > 0) {
        await db.query('UPDATE reference_books SET status=?, chunks_count=?, updated_at=? WHERE id=?',
          ['ingested', ragData.chunks_created, Date.now(), id]);
        return json(res, { ok: true, chunks: ragData.chunks_created, status: 'ingested' });
      } else {
        await db.query('UPDATE reference_books SET status=?, updated_at=? WHERE id=?',
          ['error', Date.now(), id]);
        return json(res, { error: ragData.detail || '入库失败' }, 500);
      }
    } catch (e) {
      console.error('Book ingest error:', e);
      await db.query('UPDATE reference_books SET status=?, updated_at=? WHERE id=?', ['error', Date.now(), id]).catch(() => {});
      return json(res, { error: e.message }, 500);
    }
  }

  // POST /api/admin/books/ingest-all — 批量入库所有待入库书籍
  if (req.method === 'POST' && pathname === '/api/admin/books/ingest-all') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    // 异步后台执行，立即返回
    json(res, { ok: true, message: '批量入库已开始，请刷新页面查看进度' });
    batchIngestBooks();
    return;
  }

  // GET /api/admin/book-folders — 获取所有文件夹列表
  if (req.method === 'GET' && pathname === '/api/admin/book-folders') {
    const payload = parseToken(req);
    if (!payload || payload.role !== 'admin') return json(res, { error: '未授权' }, 401);
    try {
      const [rows] = await db.query('SELECT folder, COUNT(*) as cnt FROM reference_books WHERE folder != "" GROUP BY folder ORDER BY folder');
      return json(res, rows.map(r => ({ name: r.folder, count: r.cnt })));
    } catch (e) {
      console.error('Admin folders error:', e);
      return json(res, { error: '数据库错误' }, 500);
    }
  }

  // 404
  json(res, { error: 'Not found' }, 404);
}

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7));
}
function parseToken(req) {
  // Support both Bearer header and ?token= query param
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return verifyToken(auth.slice(7));
  const url = new URL(req.url, 'http://localhost');
  const tk = url.searchParams.get('token');
  if (tk) return verifyToken(tk);
  return null;
}

async function parseBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

// ===== 梅花易数 AI 解析（流式） =====

function buildMhysPrompt(topic, hexagrams, ragContext) {
  var custom = readPrompts();

  if (!topic) {
    var noTopicTpl = custom.mhys_notopic;
    if (noTopicTpl) return renderPrompt(noTopicTpl, mhysTemplateVars('', hexagrams));
    return '你是一位梅花易数解卦师。用户还没说问什么事，请用一句话简短询问。';
  }

  var vars = mhysTemplateVars(topic, hexagrams);
  vars.ragContext = ragContext || '';

  var tpl = custom.mhys_prompt;
  if (tpl) return renderPrompt(tpl, vars);

  // ↓↓↓ 默认模板 ↓↓↓
  const bg = hexagrams.benGua, hg = hexagrams.huGua, bng = hexagrams.bianGua;
  const cg = hexagrams.cuoGua, zg = hexagrams.zongGua;
  const ti = hexagrams.ti, yong = hexagrams.yong;

  let p = `以下是一组梅花易数排盘数据。

【求测事项】${topic}

【卦象】
本卦：${bg.upperTri.name}上${bg.lowerTri.name}下 → ${bg.name}
互卦：${hg.upperTri.name}上${hg.lowerTri.name}下 → ${hg.name}
变卦：${bng.upperTri.name}上${bng.lowerTri.name}下 → ${bng.name}
错卦：${cg.upperTri.name}上${cg.lowerTri.name}下 → ${cg.name}
综卦：${zg.upperTri.name}上${zg.lowerTri.name}下 → ${zg.name}

【体用】体卦：${ti.tri.name}（${ti.tri.element}）｜用卦：${yong.tri.name}（${yong.tri.element}）
生克：${hexagrams.verdict.text} — ${hexagrams.verdict.desc}
`;

  if (bg.movingYao && bg.movingYao.length) {
    p += `动爻：本卦第${bg.movingYao.join('、')}爻动
`;
  }

  p += `
请按三段回复，每段以"---"分隔：

【一、回答】大白话直接说结论（吉/凶/平/转机），结合变卦判断走向。不含卦象推导术语。

【二、现状】用本卦说当前状况，用互卦点隐藏变数。也说大白话，不出现卦象推导。

【三、解卦思路】推演：本卦定大局→互卦析过程→变卦断结局，错综对照。说明体用生克影响。可含卦象术语。末尾提醒卦象非绝对。

避免绝对化断语（"必死""大吉"等），多用"可能""倾向"。语气干脆老练。用**加粗**标结论重点（会显示金色），###子标题适度。`;

  if (ragContext) {
    p += `

【参考古籍】请优先引用以下古籍佐证，注明出处：

${ragContext}`;
  }

  p += `

【四、补充】末尾引导用户补充背景：「如有更多具体情况可补充，方便做更细致解读」——语气自然，单独一段。`;

  return p;
}

function getTokenLimit(tier) {
  // tier 0=普通用户 1=会员 2=SVIP
  // null = 不限
  switch (tier) {
    case 1: return 5000000;
    case 2: return null;
    default: return 100000;
  }
}

async function ensureDbUser(username) {
  if (!username || !db) return;
  try {
    const [rows] = await db.query('SELECT username FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      await db.query(
        'INSERT INTO users (phone, username, password_hash, nick_name, ai_count, token_used, tier, created_at, last_active) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)',
        [username, username, '', username, Date.now(), Date.now()]
      );
    }
  } catch (e) {
    // 并发重复插入可能冲突，忽略
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const english = text.length - chinese;
  return Math.ceil(chinese * 0.6 + english * 0.25) + 10;
}

// ══════ Prompt 模板引擎 ══════
const PROMPTS_FILE = path.join(__dirname, 'data', 'prompts.json');

function readPrompts() {
  try { return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf-8')); }
  catch { return {}; }
}
function writePrompts(data) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 模板变量替换
function renderPrompt(template, vars) {
  if (!template) return null;
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), String(val ?? ''));
  }
  return result;
}

// 梅花易数模板变量提取
function mhysTemplateVars(topic, hexagrams) {
  const bg = hexagrams.benGua || {}, hg = hexagrams.huGua || {}, bng = hexagrams.bianGua || {};
  const cg = hexagrams.cuoGua || {}, zg = hexagrams.zongGua || {};
  const ti = hexagrams.ti || {}, yong = hexagrams.yong || {};
  const v = hexagrams.verdict || {};
  const movingYao = bg.movingYao && bg.movingYao.length ? '第' + bg.movingYao.join('、') + '爻动' : '无动爻';
  return {
    topic: topic || '',
    benGuaName: bg.name || '', benGuaUpper: (bg.upperTri || {}).name || '', benGuaLower: (bg.lowerTri || {}).name || '',
    huGuaName: hg.name || '', huGuaUpper: (hg.upperTri || {}).name || '', huGuaLower: (hg.lowerTri || {}).name || '',
    bianGuaName: bng.name || '', bianGuaUpper: (bng.upperTri || {}).name || '', bianGuaLower: (bng.lowerTri || {}).name || '',
    cuoGuaName: cg.name || '', cuoGuaUpper: (cg.upperTri || {}).name || '', cuoGuaLower: (cg.lowerTri || {}).name || '',
    zongGuaName: zg.name || '', zongGuaUpper: (zg.upperTri || {}).name || '', zongGuaLower: (zg.lowerTri || {}).name || '',
    tiName: (ti.tri || {}).name || '', tiElement: (ti.tri || {}).element || '',
    yongName: (yong.tri || {}).name || '', yongElement: (yong.tri || {}).element || '',
    tiyongVerdict: v.text || '', tiyongDesc: v.desc || '',
    movingYao: movingYao,
    ragContext: '',
  };
}

// 六爻模板变量提取
function liuyaoTemplateVars(topic, hexagrams) {
  const bg = hexagrams.benGua || {}, bng = hexagrams.bianGua || {};
  var gender = hexagrams.gender;
  var genderLabel = '未知';
  if (gender === 'male') genderLabel = '男';
  else if (gender === 'female') genderLabel = '女';
  return {
    topic: topic || '',
    gender: genderLabel,
    benGuaName: bg.name || '', benGuaUpper: (bg.upperTri || {}).name || '', benGuaLower: (bg.lowerTri || {}).name || '',
    bianGuaName: bng.name || '', bianGuaUpper: (bng.upperTri || {}).name || '', bianGuaLower: (bng.lowerTri || {}).name || '',
    ragContext: '',
  };
}

function buildFollowUpPrompt(topic, followUp, context, hexagrams) {
  var custom = readPrompts();
  var tpl = custom.mhys_followup;
  if (tpl) {
    var vars = mhysTemplateVars(topic, hexagrams);
    vars.followUp = followUp || '';
    vars.context = (context || '').slice(-1200);
    return renderPrompt(tpl, vars);
  }
  let p = `针对「${topic}」的追问：

【之前解读】${(context || '').slice(-1000)}

【追问】${followUp}

请直接回答追问，不重复完整分析。结构：
【一、回答】——结论和建议，不用卦象术语。
【二、思路】（可选）——一两句推演依据。`;
  return p;
}

async function streamDeepSeek(prompt, res, maxOutputChars) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: config.deepseek.apiKey,
    baseURL: config.deepseek.baseURL,
  });

  var custom = readPrompts();
  var systemPrompt = custom.mhys_system || '你是梅花易数解卦师。回答清晰、理性、有启发性，避免绝对化断语，多用"可能""倾向"。可主动反问补充背景。';

  const stream = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    stream: true,
    max_tokens: maxOutputChars ? Math.ceil(maxOutputChars / 0.6) : 3000,
    temperature: 0.7,
  });

  let fullText = '';
  let stopped = false;
  for await (const chunk of stream) {
    if (stopped) continue;
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      fullText += content;
      // 未登录用户达到字数上限后截断
      if (maxOutputChars && fullText.length >= maxOutputChars) {
        stopped = true;
        var loginPrompt = '\n\n---\n\n> ⚠️ 未登录用户的解析有字数限制。\n> 🔑 [登录](/login/)即可解锁完整AI解析（最少100次/10万token免费额度）';
        fullText += loginPrompt;
        try { res.write(loginPrompt); } catch(e) {}
        try { stream.controller.abort(); } catch(e) {}
      } else {
        try { res.write(content); } catch(e) {}
      }
    }
  }
  return fullText;
}

function buildLiuyaoPrompt(topic, hexagrams, ragContext) {
  var custom = readPrompts();

  if (!topic) {
    var noTopicTpl = custom.liuyao_notopic;
    if (noTopicTpl) return renderPrompt(noTopicTpl, liuyaoTemplateVars('', hexagrams));
    return '你是一位六爻纳甲解卦师。用户还没说问什么事，请先回应排盘数据（本卦变卦名+世应位置），然后用一句话询问求测事项。';
  }

  var vars = liuyaoTemplateVars(topic, hexagrams);
  vars.ragContext = ragContext || '';

  var tpl = custom.liuyao_prompt;
  if (tpl) return renderPrompt(tpl, vars);

  // ↓↓↓ 默认模板 ↓↓↓
  const bg = hexagrams.benGua || {};
  const bng = hexagrams.bianGua || {};
  var gender = hexagrams.gender;
  var genderLabel = '未知';
  if (gender === 'male') genderLabel = '男';
  else if (gender === 'female') genderLabel = '女';

  let p = '以下是一组六爻排盘数据。请严格按照六爻断卦标准流程逐层分析。\n\n';
  p += '【求测事项】' + topic + '\n';
  p += '【求测者性别】' + genderLabel + '\n\n';
  p += '【卦象】\n';
  p += '本卦：' + (bg.name || '未知') + '\n';
  p += '变卦：' + (bng.name || '未知') + '\n';
  p += ((bg.upperTri && bg.upperTri.name) || '未知') + '上' + ((bg.lowerTri && bg.lowerTri.name) || '未知') + '下\n';
  p += ((bng.upperTri && bng.upperTri.name) || '未知') + '上' + ((bng.lowerTri && bng.lowerTri.name) || '未知') + '下\n\n';

  p += '══════ 断卦方法论（必须逐层执行） ══════\n\n';

  p += '【第一层·定用神】\n';
  p += '根据求测事项和性别确定用神：\n';
  p += '- 男测事业/功名/官司/疾病 → 用神为官鬼爻\n';
  p += '- 女测丈夫/感情对象 → 用神为官鬼爻\n';
  p += '- 男测妻子/感情对象 → 用神为妻财爻\n';
  p += '- 测财运/货物/金银 → 用神为妻财爻\n';
  p += '- 测考试/文书/长辈/房屋 → 用神为父母爻\n';
  p += '- 测子女/医药/宠物/解忧 → 用神为子孙爻\n';
  p += '- 测兄弟朋友/口舌争执 → 用神为兄弟爻\n';
  p += '生用神之爻为元神（吉），克用神之爻为忌神（凶）。用神多现时：取持世之爻优先，其次取临月日之爻，再次取月破/旬空之爻。\n\n';

  p += '【第二层·看世应】\n';
  p += '世爻为己身、为求测者；应爻为他人、为对方、为所测之事的环境。\n';
  p += '- 世应相生相合 → 人我和谐，事易成\n';
  p += '- 世应相克相冲 → 人我对立，事多阻\n';
  p += '- 世爻旺相 → 自身状态好，有能力成事\n';
  p += '- 世爻休囚空破 → 自身无力，被动受制\n';
  p += '- 世应俱空 → 双方都不实在，事情虚无\n';
  p += '- 应爻生世爻 → 对方主动有利于我\n\n';

  p += '【第三层·察日月】\n';
  p += '日辰为六爻之主宰，月建为万卦之提纲。日月生扶用神则吉，日月刑克用神则凶。\n';
  p += '- 日月如君如将，爻神莫敢不从——旺动之爻也不敌日月之力\n';
  p += '- 日建不受旬空之困，月建不落旬空——日月本身永不为空\n';
  p += '- 月建定旺相休囚死：当令者旺、令生者相、生令者休、克令者囚、令克者死\n';
  p += '- 月破之爻（月建冲之）当月无力，出月方可恢复\n';
  p += '- 日冲静爻为暗动（短暂有力），日冲动爻为冲散（力减）\n\n';

  p += '【第四层·辨动爻】\n';
  p += '动爻是变化的发动机。动为始、变为终。\n';
  p += '- 一爻独发其势最大，虽休囚亦能制旺爻（不敌日月除外）\n';
  p += '- 多爻动时取阴爻为主（阴主未来），同阴同阳取上一爻\n';
  p += '- 六爻皆动看变卦为主\n';
  p += '- 动爻被日辰或变爻合住 → "动值合而绊住"，暂时不能发挥作用\n';
  p += '- 变爻只能生克本动爻，不能生克本卦其他静爻\n';
  p += '- 变爻空破死绝 → 动爻不受其生克\n\n';

  p += '【第五层·析生克】\n';
  p += '围绕用神分析六亲生克关系：\n';
  p += '- 元神（生用神者）动 → 大吉，如时雨滋苗\n';
  p += '- 忌神（克用神者）动 → 大凶，如秋霜杀草\n';
  p += '- 贪生忘克：忌神动克用神，但若有爻生忌神，忌神转而"贪生"顾不上克用神 → 转吉\n';
  p += '- 贪合忘克：忌神被日辰或他爻合住 → 减凶\n';
  p += '- 连续相生：A生B、B生C、C生用神 → 力量传导，层层加强\n';
  p += '- 六合卦 → 事易成；六冲卦 → 事易散（诉讼/分手/出行反以六冲为吉）\n\n';

  p += '【第六层·断空亡与月破】\n';
  p += '空亡之法重在辨别真假：\n';
  p += '- 旺相之爻值空 → 过旬可用，非真空\n';
  p += '- 月建生扶之爻值空 → 半空，暂不利\n';
  p += '- 月建克之且值空 → 真空，彻底无用\n';
  p += '- 动爻值空 → 不惟不空，反为全动（动不为空）\n';
  p += '- 月破值空 → 空上加空，大凶\n';
  p += '- 空于忌则吉（坏人不在），空于用则凶（主角缺席）\n';
  p += '- 空逢冲而有用的前提：旺相有气，冲则填实\n\n';

  p += '【第七层·推应期】\n';
  p += '应期即事件发生的时间，从以下线索综合判断：\n';
  p += '- 用神旬空 → 应期在出旬之日或冲空之日\n';
  p += '- 用神入墓 → 应期在冲墓之日（如金入丑墓，未日冲开）\n';
  p += '- 动爻被合绊 → 应期在冲合之日\n';
  p += '- 月破之爻 → 应期在出月或值月之日\n';
  p += '- 用神休囚 → 应期在长生/帝旺之日\n';
  p += '- 忌神旺动 → 应期在忌神入墓/绝地之日（凶事应期）\n';
  p += '- 静爻待冲 → 应期在冲动之日（暗动）\n\n';

  p += '【结论公式】\n';
  p += '用神旺相 + 元神生扶 + 忌神安静/空亡 → 大吉，事必成\n';
  p += '用神旺相 + 忌神动但被合住/贪生忘克 → 先阻后成\n';
  p += '用神休囚 + 元神动来生 → 有救，延迟但可成\n';
  p += '用神休囚 + 忌神旺动克之 + 无元神救助 → 大凶，事不成\n';
  p += '用神真空/月破 + 忌神当令 → 彻底无望\n\n';

  p += '══════ 输出格式 ══════\n\n';
  p += '请严格按以下结构回复，每段以"---"分隔：\n\n';
  p += '【一、结论】直接说吉凶结论（吉/凶/平/转机/先难后成），1-2句话。结合用神旺衰与忌神动否。大白话，不用术语。\n\n';
  p += '【二、现状分析】用人话描述当前状况：世应关系反映的双方状态、六神揭示的氛围（青龙主喜/朱雀主口舌/白虎主凶/玄武主暗昧）、爻位反映的事态阶段。不出现推导过程。\n\n';
  p += '【三、解卦推演】按以上七层方法论逐步推演：定用神→看世应→察日月→辨动爻→析元神忌神生克→审空亡月破→推应期。每步引用卦中具体爻位和六亲六神。可含专业术语。末尾给出应期判断，并提醒卦象非绝对。\n\n';
  p += '用**加粗**标结论重点，###子标题适度。避免绝对化断语，多用"可能""倾向"。';

  if (ragContext) {
    p += '\n\n【参考古籍】请优先引用以下古籍原文佐证，注明出处：\n\n' + ragContext;
  }

  p += '\n\n【补充引导】末尾引导用户补充背景："如有更多具体情况可补充，方便做更细致解读"——语气自然，单独一段。';
  return p;
}

function buildLiuyaoFollowUpPrompt(topic, followUp, context, hexagrams) {
  var custom = readPrompts();
  var tpl = custom.liuyao_followup;
  if (tpl) {
    var vars = liuyaoTemplateVars(topic, hexagrams);
    vars.followUp = followUp || '';
    vars.context = (context || '').slice(-1200);
    return renderPrompt(tpl, vars);
  }
  var p = '针对「' + topic + '」的追问：\n\n';
  p += '【之前解读】' + ((context || '').slice(-1200)) + '\n\n';
  p += '【追问】' + followUp + '\n\n';
  p += '直接回答追问，不重复完整七层分析。聚焦追问涉及的层面（如问应期则重点推应期，问空亡则重点辨空亡真假）。结构：\n【回答】——结论和建议，不用卦象术语。\n【依据】——简短推演依据（1-3句，引用原卦爻位）。';
  return p;
}

async function streamDeepSeekLiuyao(prompt, res, maxOutputChars) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: config.deepseek.apiKey,
    baseURL: config.deepseek.baseURL,
  });

  var custom = readPrompts();
  var systemPrompt = custom.liuyao_system || '你是六爻纳甲解卦师。断卦必须严格遵循七层标准流程：①定用神→②看世应→③察日月→④辨动爻→⑤析生克→⑥审空亡月破→⑦推应期。输出分三块：结论（直说吉凶，人话）→现状（世应六神说当下）→推演（七层逐步展开，引具体爻位六亲六神，含应期判断）。避免绝对断语，多用可能/倾向。用**加粗**标重点。';

  const stream = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    stream: true,
    max_tokens: maxOutputChars ? Math.ceil(maxOutputChars / 0.6) : 3000,
  });

  let fullText = '';
  let stopped = false;
  for await (const chunk of stream) {
    if (stopped) continue;
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      fullText += content;
      if (maxOutputChars && fullText.length >= maxOutputChars) {
        stopped = true;
        var loginPrompt = '\n\n---\n\n> ⚠️ 未登录用户仅限预览，完整解析需登录。\n> 🔑 [登录](/login/)即可解锁完整AI解析（最少100次/10万token免费额度）';
        fullText += loginPrompt;
        try { res.write(loginPrompt); } catch(e) {}
        try { stream.controller.abort(); } catch(e) {}
      } else {
        try { res.write(content); } catch(e) {}
      }
    }
  }
  return fullText;
}

// 批量入库后台任务
async function batchIngestBooks() {
  try {
    const [rows] = await db.query("SELECT * FROM reference_books WHERE content IS NOT NULL AND content != '' AND status = 'pending' ORDER BY category, title");
    console.log(`[BatchIngest] 开始批量入库 ${rows.length} 本书...`);
    let done = 0, failed = 0;
    for (const book of rows) {
      try {
        const ragRes = await fetch('http://localhost:8800/api/ingest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_name: book.title, category: book.category, content: book.content, chapter: '', metadata: {} }),
        });
        const ragData = await ragRes.json();
        if (ragRes.ok && ragData.chunks_created > 0) {
          await db.query('UPDATE reference_books SET status=?, chunks_count=?, updated_at=? WHERE id=?',
            ['ingested', ragData.chunks_created, Date.now(), book.id]);
          done++;
          console.log(`[BatchIngest] ✅ (${done}/${rows.length}) ${book.title} → ${ragData.chunks_created} chunks`);
        } else {
          await db.query('UPDATE reference_books SET status=?, updated_at=? WHERE id=?', ['error', Date.now(), book.id]);
          failed++;
          console.log(`[BatchIngest] ❌ ${book.title}: ${ragData.detail || 'unknown'}`);
        }
      } catch (e) {
        await db.query('UPDATE reference_books SET status=?, updated_at=? WHERE id=?', ['error', Date.now(), book.id]).catch(() => {});
        failed++;
        console.log(`[BatchIngest] ❌ ${book.title}: ${e.message}`);
      }
    }
    console.log(`[BatchIngest] 完成！成功 ${done} 本，失败 ${failed} 本`);
  } catch (e) {
    console.error('[BatchIngest] 批量入库出错:', e);
  }
}

// Start
http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`Auth server v2 running on http://127.0.0.1:${PORT}`);
});
