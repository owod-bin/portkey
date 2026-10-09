'use strict';

/* ============================================================
   Portkey · 客户端界面逻辑
   ============================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

const ICON = {
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 5.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h.5"/></svg>',
  probe: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8.5" r="5"/><path d="M12.5 12.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13"/><path d="M8 5.5V4a1.5 1.5 0 011.5-1.5h1A1.5 1.5 0 0112 4v1.5"/><path d="M5.5 5.5l.7 10.1a1.5 1.5 0 001.5 1.4h4.6a1.5 1.5 0 001.5-1.4l.7-10.1"/></svg>',
  edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3-9 9-3.6.6.6-3.6 9-9z"/></svg>',
  moon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 11.5A6.5 6.5 0 018.5 3.5a6.5 6.5 0 108 8z"/></svg>',
  sun: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3.6"/><path d="M10 2v1.8M10 16.2V18M18 10h-1.8M3.8 10H2M15.7 4.3l-1.3 1.3M5.6 14.4l-1.3 1.3M15.7 15.7l-1.3-1.3M5.6 5.6L4.3 4.3"/></svg>',
  bellOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 8.5a5.5 5.5 0 00-8.2-4.8M5 8.5c0 3-1.5 4.5-1.5 4.5h11"/><path d="M8.5 15.5a1.8 1.8 0 003 0"/><path d="M3 3l14 14"/></svg>',
  bellOn: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 8.5c0-3-2.5-5.5-5.5-5.5S4.5 5.5 4.5 8.5c0 3-1.5 4.5-1.5 4.5h14s-1.5-1.5-1.5-4.5"/><path d="M8.5 15.5a1.8 1.8 0 003 0"/></svg>',
  empty: '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="9" width="28" height="22" rx="3"/><path d="M6 16h28"/><path d="M14 23h12"/></svg>',
};

const PAGES = {
  overview: ['概览', '查看隧道状态与公网访问地址'],
  rules: ['端口映射', '把局域网里的服务映射到服务器公网端口'],
  server: ['服务器', '配置 SSH 登录信息，程序会自动完成服务器端设置'],
  logs: ['运行日志', '记录连接、配置与流量转发的全过程'],
};

let state = null;
let allLogs = [];
let logSeq = 0;
let logFilter = 'all';
let currentPage = 'overview';
let filled = false;
let busy = false;
let prevStatus = null;
let notifyEnabled = false;
let rateHistory = [];
let lastSample = null;

const THEME_KEY = 'portkey-theme';

// ---------------------------------------------------------------- 工具

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, kind) {
  const el = $('#toast');
  if (!el) return; // 页面不可用时静默忽略，避免轮询因异常中断
  el.textContent = msg;
  el.className = 'toast show' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// ---------------------------------------------------------------- 弹窗
// 不用浏览器原生 confirm/prompt：它们可能被浏览器静默阻止，导致按钮"点了没反应"

let modalResolve = null;

function showModal(opts) {
  return new Promise((resolve) => {
    const mask = $('#modal');
    if (!mask) return resolve(null);
    $('#modal-title').textContent = opts.title || '';
    $('#modal-desc').textContent = opts.desc || '';
    const inp = $('#modal-input');
    inp.style.display = opts.input ? '' : 'none';
    inp.value = opts.value === undefined || opts.value === null ? '' : opts.value;
    inp.placeholder = opts.placeholder || '';
    const ok = $('#modal-ok');
    ok.textContent = opts.okText || '确定';
    ok.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    mask.style.display = 'grid';
    modalResolve = resolve;
    setTimeout(() => {
      if (opts.input) { inp.focus(); inp.select(); } else ok.focus();
    }, 40);
  });
}

function closeModal(result) {
  const mask = $('#modal');
  if (mask) mask.style.display = 'none';
  const r = modalResolve;
  modalResolve = null;
  if (r) r(result);
}

function askConfirm(title, desc, okText, danger) {
  return showModal({ title, desc, okText, danger }).then((r) => r === true);
}

function askInput(title, desc, value, placeholder) {
  return showModal({ title, desc, input: true, value, placeholder })
    .then((r) => (typeof r === 'string' ? r : null));
}

function bindModal() {
  const mask = $('#modal');
  if (!mask) return;
  const confirmNow = () => {
    const inp = $('#modal-input');
    closeModal(inp.style.display === 'none' ? true : inp.value);
  };
  $('#modal-ok').addEventListener('click', confirmNow);
  $('#modal-cancel').addEventListener('click', () => closeModal(null));
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(null); });
  document.addEventListener('keydown', (e) => {
    if (mask.style.display === 'none') return;
    if (e.key === 'Escape') closeModal(null);
    else if (e.key === 'Enter') confirmNow();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) { return false; }
  }
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((body && body.error) || '请求失败');
  return body || {};
}

function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function duration(ms) {
  ms = Number(ms) || 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

function fmtRate(bps) {
  bps = Number(bps) || 0;
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}

// ---------------------------------------------------------------- 主题

function applyTheme(t) {
  const dark = t === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const btn = $('#btn-theme');
  if (btn) btn.innerHTML = dark ? ICON.sun : ICON.moon;
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
  if (!saved) {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    saved = prefersDark ? 'dark' : 'light';
  }
  applyTheme(saved);
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  drawChart();
}

// ---------------------------------------------------------------- 桌面通知

function updateNotifyButton() {
  const btn = $('#btn-notify');
  if (!btn) return;
  btn.innerHTML = notifyEnabled ? ICON.bellOn : ICON.bellOff;
  btn.style.color = notifyEnabled ? 'var(--brand)' : '';
}

function notify(title, body) {
  if (!notifyEnabled) return;
  try { new Notification(title, { body, silent: false }); } catch (_) {}
}

async function toggleNotify() {
  if (notifyEnabled) {
    notifyEnabled = false;
    updateNotifyButton();
    toast('已关闭桌面通知');
    return;
  }
  if (typeof window.Notification === 'undefined') {
    return toast('当前环境不支持桌面通知', 'error');
  }
  let perm = window.Notification.permission;
  if (perm === 'default') {
    try { perm = await window.Notification.requestPermission(); } catch (_) {}
  }
  if (perm !== 'granted') return toast('未获得通知权限，请在浏览器设置中允许', 'error');
  notifyEnabled = true;
  updateNotifyButton();
  toast('已开启桌面通知', 'ok');
  notify('Portkey', '隧道状态变化时会在这里提醒你');
}

function detectStatusChange() {
  if (prevStatus && prevStatus !== state.status) {
    if (state.status === 'reconnecting') {
      notify('隧道已断开', '正在自动重连…');
    } else if (state.status === 'online' && prevStatus !== 'connecting' && prevStatus !== 'configuring') {
      notify('隧道已恢复', `${state.server.host} 连接正常`);
    } else if (state.status === 'error') {
      notify('连接失败', state.lastError || '请检查服务器信息');
    }
  }
  prevStatus = state.status;
}

// ---------------------------------------------------------------- 速率采样与曲线

function sampleRate() {
  const s = (state && state.stats) || {};
  const now = Date.now();
  const bin = Number(s.bytesIn) || 0;
  const bout = Number(s.bytesOut) || 0;

  if (!lastSample) {
    lastSample = { t: now, bytesIn: bin, bytesOut: bout };
    return;
  }
  const dt = (now - lastSample.t) / 1000;
  if (dt < 0.5) return;

  const inRate = Math.max(0, (bin - lastSample.bytesIn) / dt);
  const outRate = Math.max(0, (bout - lastSample.bytesOut) / dt);
  lastSample = { t: now, bytesIn: bin, bytesOut: bout };

  rateHistory.push({ inRate, outRate });
  if (rateHistory.length > 60) rateHistory.shift();

  const el1 = $('#rate-in');
  const el2 = $('#rate-out');
  if (el1) el1.textContent = fmtRate(inRate);
  if (el2) el2.textContent = fmtRate(outRate);
}

function drawChart() {
  const canvas = $('#rate-chart');
  if (!canvas || !canvas.getContext) return;
  const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
  if (!rect.width) return;

  const dpr = window.devicePixelRatio || 1;
  const W = rect.width;
  const H = rect.height || 150;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cs = getComputedStyle(document.documentElement);
  const gridColor = (cs.getPropertyValue('--border') || '#e6eaf0').trim() || '#e6eaf0';
  const mutedColor = (cs.getPropertyValue('--text-3') || '#94a3b8').trim() || '#94a3b8';

  const padL = 6, padR = 6, padT = 12, padB = 6;
  const cw = W - padL - padR;
  const ch = H - padT - padB;

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = Math.round(padT + (ch * i) / 3) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cw, y);
    ctx.stroke();
  }

  if (rateHistory.length < 2) {
    ctx.fillStyle = mutedColor;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待数据…', W / 2, H / 2);
    return;
  }

  const max = Math.max(2048, ...rateHistory.map((p) => Math.max(p.inRate, p.outRate)));
  const n = rateHistory.length;
  const xAt = (i) => padL + (cw * i) / (n - 1);
  const yAt = (v) => padT + ch - (ch * Math.min(v, max)) / max;

  const drawSeries = (key, color) => {
    ctx.beginPath();
    rateHistory.forEach((p, i) => {
      const x = xAt(i), y = yAt(p[key]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 面积
    ctx.lineTo(xAt(n - 1), padT + ch);
    ctx.lineTo(xAt(0), padT + ch);
    ctx.closePath();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  drawSeries('inRate', '#3b82f6');
  drawSeries('outRate', '#10b981');
}

// ---------------------------------------------------------------- 服务器状态

function renderServerStats() {
  const box = $('#server-stats');
  if (!box) return;
  const ss = state.serverStats;
  const osEl = $('#server-os');
  if (osEl) osEl.textContent = state.os || '';
  const subEl = $('#server-sub');

  if (!ss) {
    box.innerHTML = `<div class="srv-empty">${state.status === 'online' ? '正在采集…' : '连接服务器后显示 CPU / 内存 / 磁盘 / 网络'}</div>`;
    if (subEl) subEl.textContent = state.status === 'online' ? '通过 SSH 每 5 秒采集' : '连接后通过 SSH 每 5 秒采集';
    return;
  }
  if (subEl) subEl.textContent = `更新于 ${new Date(ss.at).toTimeString().slice(0, 8)} · 每 5 秒刷新`;

  const bar = (p) => `<div class="bar"><i class="${p >= 90 ? 'err' : p >= 70 ? 'warn' : ''}" style="width:${Math.min(100, Math.max(0, p))}%"></i></div>`;
  const items = [];

  if (ss.cpuPercent !== null && ss.cpuPercent !== undefined) {
    items.push(`<div class="srv-item"><span class="k">CPU 使用率 · ${ss.cores} 核</span><span class="v">${ss.cpuPercent}%</span>${bar(ss.cpuPercent)}</div>`);
  }
  if (ss.load) {
    items.push(`<div class="srv-item"><span class="k">平均负载 1 / 5 / 15 分钟</span><span class="v">${ss.load.map((x) => x.toFixed(2)).join(' / ')}</span></div>`);
  }
  if (ss.mem) {
    items.push(`<div class="srv-item"><span class="k">内存 · 共 ${ss.mem.totalMB} MB</span><span class="v">${ss.mem.usedMB} MB <small>${ss.mem.percent}%</small></span>${bar(ss.mem.percent)}</div>`);
  }
  if (ss.disk) {
    items.push(`<div class="srv-item"><span class="k">磁盘 · 共 ${ss.disk.totalGB} GB</span><span class="v">${ss.disk.usedGB} GB <small>${ss.disk.percent}%</small></span>${bar(ss.disk.percent)}</div>`);
  }
  if (ss.netRate) {
    items.push(`<div class="srv-item"><span class="k">服务器网卡速率</span><span class="v">↓ ${fmtRate(ss.netRate.rx)} <small>↑ ${fmtRate(ss.netRate.tx)}</small></span></div>`);
  }
  if (ss.uptime) {
    items.push(`<div class="srv-item"><span class="k">服务器运行时长</span><span class="v">${duration(ss.uptime * 1000)}</span></div>`);
  }

  box.innerHTML = items.length
    ? `<div class="srv-grid">${items.join('')}</div>`
    : '<div class="srv-empty">服务器未返回可用的系统信息（可能不是 Linux）</div>';
}

function goPage(name) {
  if (!PAGES[name]) name = 'overview';
  currentPage = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $('#page-title').textContent = PAGES[name][0];
  $('#page-desc').textContent = PAGES[name][1];
}

// ---------------------------------------------------------------- 渲染

function statusMeta() {
  const map = {
    online: ['online', '已连接'],
    connecting: ['busy', '连接中…'],
    configuring: ['busy', '配置服务器…'],
    reconnecting: ['busy', state.statusText || '重连中…'],
    error: ['error', state.lastError || '连接失败'],
    idle: ['', state.statusText || '未连接'],
  };
  return map[state.status] || map.idle;
}

function renderHeader() {
  const [cls, text] = statusMeta();
  $('#status-pill').className = 'pill ' + cls;
  $('#status-text').textContent = text;
  $('#side-dot').className = 'dot ' + cls;
  $('#side-status').textContent = text;
  $('#side-host').textContent = state.server.host
    ? `${state.server.username}@${state.server.host}:${state.server.port}`
    : '尚未配置服务器';

  const btn = $('#btn-connect');
  if (state.status === 'online') {
    btn.textContent = '断开连接';
    btn.className = 'btn';
    btn.disabled = false;
  } else if (state.status === 'connecting' || state.status === 'configuring') {
    btn.textContent = '连接中…';
    btn.className = 'btn primary';
    btn.disabled = true;
  } else {
    btn.textContent = '一键连接';
    btn.className = 'btn primary';
    btn.disabled = false;
  }
  $('#btn-restart').style.display = state.status === 'online' ? '' : 'none';
}

function renderHero() {
  const [cls] = statusMeta();
  $('#hero-dot').className = 'hero-dot ' + cls;

  const s = state.stats || {};
  let title = '尚未连接', sub = '';

  if (state.status === 'online') {
    title = '隧道已连接';
    sub = `${state.server.username}@${state.server.host}:${state.server.port}` +
      (state.os ? ` · ${state.os}` : '') +
      (s.startedAt ? ` · 已运行 ${duration(Date.now() - s.startedAt)}` : '');
  } else if (state.status === 'connecting') {
    title = '正在连接服务器…';
    sub = `${state.server.username}@${state.server.host}:${state.server.port}`;
  } else if (state.status === 'configuring') {
    title = '正在配置服务器…';
    sub = '自动修改 sshd 配置、放行防火墙端口';
  } else if (state.status === 'reconnecting') {
    title = '连接已断开，正在重连…';
    sub = state.statusText || '';
  } else if (state.status === 'error') {
    title = '连接失败';
    sub = state.lastError || '请检查服务器信息与网络';
  } else if (state.server.host) {
    title = '尚未连接';
    sub = `已保存服务器 ${state.server.host}，点右上角「一键连接」`;
  } else {
    sub = '先在「服务器」页填写 SSH 信息，然后点「一键连接」';
  }

  $('#hero-title').textContent = title;
  $('#hero-sub').textContent = sub;

  const side = [];
  if (state.status === 'online') {
    side.push(`<div class="hero-stat"><b>${s.activeStreams || 0}</b><span>当前连接</span></div>`);
    side.push(`<div class="hero-stat"><b>${bytes((s.bytesIn || 0) + (s.bytesOut || 0))}</b><span>累计流量</span></div>`);
    side.push(`<div class="hero-stat"><b>${s.reconnects || 0}</b><span>重连次数</span></div>`);
  }
  $('#hero-side').innerHTML = side.join('');
}

function renderStats() {
  const s = state.stats || {};
  const rules = state.rules || [];
  const cards = [
    { v: rules.filter((r) => r.live).length, k: '已开放端口' },
    { v: rules.length, k: '映射规则' },
    { v: s.activeStreams || 0, k: '当前连接' },
    { v: bytes((s.bytesIn || 0) + (s.bytesOut || 0)), k: '累计流量' },
  ];
  $('#stats').innerHTML = cards.map((c) =>
    `<div class="metric"><b>${esc(c.v)}</b><span>${esc(c.k)}</span></div>`
  ).join('');
}

function alertBox(num, title, desc, kind) {
  return `<div class="alert ${kind || ''}">
    <span class="alert-num">${esc(num)}</span>
    <div class="alert-body"><b>${esc(title)}</b><span>${esc(desc)}</span></div>
  </div>`;
}

function renderAlert() {
  const hasServer = !!state.server.host;
  const online = state.status === 'online';
  const hasRule = (state.rules || []).length > 0;

  let html = '';
  if (state.status === 'error') {
    html = alertBox('!', '连接出错', state.lastError || '请检查服务器信息与网络', 'err');
  } else if (!hasServer) {
    html = alertBox(1, '先填写服务器信息', '打开左侧「服务器」，填入公网 IP 和 SSH 密码，保存后即可连接');
  } else if (!online) {
    html = alertBox(2, '下一步：一键连接', '程序会自动登录服务器、开启端口转发并放行防火墙，全程无需登录服务器');
  } else if (!hasRule) {
    html = alertBox(3, '最后一步：添加端口映射', '告诉程序要把内网哪个端口发布出去，例如 内网 80 → 公网 8080');
  }
  $('#overview-alert').innerHTML = html;
}

function renderReleaseAlert() {
  const box = $('#release-alert');
  if (!state.pendingRelease) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="alert warn">
    <span class="alert-num">!</span>
    <div class="alert-body">
      <b>有端口尚未释放</b>
      <span>已停用或删除的端口仍被服务器占用，重启隧道即可释放（会短暂中断现有连接）</span>
    </div>
    <button class="btn tiny" id="btn-release">立即重启隧道</button>
  </div>`;
}

function renderAddrs() {
  const host = state.server.host;
  const live = (state.rules || []).filter((r) => r.live);
  const box = $('#addr-list');

  if (!live.length) {
    box.innerHTML = `<div class="empty">${ICON.empty}
      <b>暂无可用地址</b>
      <span>${(state.rules || []).length ? '映射已存在，连接服务器后会自动开放' : '添加端口映射后，这里会显示公网访问地址'}</span>
    </div>`;
    return;
  }
  box.innerHTML = `<div class="addr-list">${live.map((r) => {
    const isWeb = r.protocol === 'http' || r.protocol === 'https';
    const addr = r.url || r.address || `${host}:${r.remotePort}`;
    const kind = isWeb ? (r.protocol === 'https' ? '网页 HTTPS' : '网页 HTTP') : 'TCP 服务';
    return `<div class="addr-item">
      <div class="addr-main">
        <span class="addr-name">${esc(r.name || '未命名')} · 内网 ${esc(r.localHost)}:${r.localPort} · ${kind}</span>
        <code>${esc(addr)}</code>
      </div>
      <div class="row-tail">
        <button class="btn tiny" data-act="copy" data-text="${esc(addr)}">复制</button>
        ${isWeb ? `<a class="btn tiny" href="${esc(r.url)}" target="_blank">打开</a>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderReport() {
  const steps = state.progress || [];
  const html = steps.length
    ? steps.map((s) => `<li class="${esc(s.status)}">
        <div class="tl-title">${esc(s.title)}</div>
        ${s.detail ? `<div class="tl-detail">${esc(s.detail)}</div>` : ''}
      </li>`).join('')
    : '<li class="tl-empty">连接服务器后，这里会显示自动配置的每一步结果</li>';
  $('#provision-report').innerHTML = html;
  $('#provision-report2').innerHTML = html;
}

function renderRules() {
  const rules = state.rules || [];
  const host = state.server.host || '';
  $('#nav-rule-count').textContent = rules.length;

  if (!rules.length) {
    $('#rules-table').innerHTML = `<div class="empty">${ICON.empty}
      <b>还没有端口映射</b>
      <span>在上方填写内网地址与端口，添加后即可通过公网访问</span>
    </div>`;
    $('#rules-summary').textContent = '暂无映射';
  } else {
    const live = rules.filter((r) => r.live).length;
    $('#rules-summary').textContent = `共 ${rules.length} 条，其中 ${live} 条已开放`;
    $('#rules-table').innerHTML = `<div class="list">${rules.map((r) => {
      const badge = r.live
        ? '<span class="badge on">已开放</span>'
        : (r.enabled ? '<span class="badge warn">待连接</span>' : '<span class="badge off">已停用</span>');
      const kind = r.protocol === 'https' ? 'HTTPS' : r.protocol === 'http' ? 'HTTP' : 'TCP';
      const addr = r.url || r.address || '';
      const tf = r.traffic || { bytesIn: 0, bytesOut: 0, streams: 0, active: 0 };
      const total = tf.bytesIn + tf.bytesOut;
      const tfText = total > 0
        ? ` · 流量 <code>${bytes(total)}</code> · 累计连接 <code>${tf.streams}</code>${tf.active ? ` · 当前 <code>${tf.active}</code>` : ''}`
        : '';
      return `<div class="row">
        <div class="row-main">
          <div class="row-title">${esc(r.name || '端口 ' + r.remotePort)}${badge}<span class="badge off">${kind}</span></div>
          <div class="row-sub">内网服务 <code>${esc(r.localHost)}:${r.localPort}</code> · 公网端口 <code>${r.remotePort}</code>${tfText}</div>
        </div>
        <div class="row-addr">${addr ? `<code>${esc(addr)}</code>` : '<span class="muted tiny">未配置服务器</span>'}</div>
        <div class="row-tail">
          ${addr ? `<button class="icon-btn" title="复制地址" data-act="copy" data-text="${esc(addr)}">${ICON.copy}</button>` : ''}
          <button class="icon-btn" title="探测内网服务" data-act="probe" data-id="${esc(r.id)}">${ICON.probe}</button>
          <button class="icon-btn" title="修改备注" data-act="rename" data-id="${esc(r.id)}">${ICON.edit}</button>
          <label class="toggle" title="${r.enabled ? '点击停用' : '点击启用'}">
            <input type="checkbox" data-act="toggle" data-id="${esc(r.id)}" ${r.enabled ? 'checked' : ''}><i></i>
          </label>
          <button class="icon-btn danger" title="删除" data-act="del" data-id="${esc(r.id)}">${ICON.trash}</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  $('#add-hint').textContent = host
    ? `添加后访问地址形如 http://${host}:公网端口（需在云服务器安全组放行该端口）`
    : '提示：先在「服务器」页配置服务器，添加映射后即可通过公网访问';
  const ips = (state.localIPs || []).join('、');
  $('#lan-ips').textContent = ips ? '本机内网 IP ' + ips : '';
}

function renderLogs() {
  const box = $('#logbox');
  const list = logFilter === 'all'
    ? allLogs
    : allLogs.filter((l) => (logFilter === 'info'
      ? (l.level === 'info' || l.level === 'ok' || l.level === 'step')
      : l.level === logFilter));

  if (!list.length) {
    box.innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }
  box.innerHTML = list.map((l) =>
    `<div class="l-${esc(l.level)}"><span class="t">[${esc(l.time)}]</span> ${esc(l.msg)}${l.detail ? ` <span class="d">${esc(l.detail)}</span>` : ''}</div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

function renderAll() {
  // 页面已不可用时（例如点了退出程序）直接返回，避免轮询持续报错
  if (!$('#status-text') || !$('#stats')) return;
  renderHeader();
  renderHero();
  renderStats();
  renderAlert();
  renderAddrs();
  renderReport();
  renderRules();
  renderReleaseAlert();
  renderServerStats();
  drawChart();
}

function fillForm() {
  const s = state.server || {};
  const set = (sel, val) => {
    const el = $(sel);
    if (el && document.activeElement !== el) el.value = val === undefined || val === null ? '' : val;
  };
  set('#s-host', s.host);
  set('#s-port', s.port || 22);
  set('#s-user', s.username);
  set('#s-key', s.privateKeyPath);
  if (s.hasPassword) $('#s-pass').placeholder = '已保存，留空表示不修改';
  $('#o-remember').checked = s.remember !== false;
  $('#o-autoconnect').checked = !!(state.options || {}).autoConnect;
  $('#o-autoreconnect').checked = (state.options || {}).autoReconnect !== false;
  $('#server-note').textContent = s.hasPassword ? '登录密码已在本机加密保存' : '尚未保存登录密码';
}

// ---------------------------------------------------------------- 轮询

async function refresh() {
  try {
    const s = await api('/api/state');
    state = s;
    if (!filled) { fillForm(); filled = true; }
    detectStatusChange();
    sampleRate();
    renderAll();
  } catch (err) {
    toast('无法连接本地服务：' + err.message, 'error');
  }
}

async function pollLogs() {
  try {
    const r = await api('/api/logs?since=' + logSeq);
    if (r.logs && r.logs.length) {
      allLogs = allLogs.concat(r.logs);
      if (allLogs.length > 400) allLogs = allLogs.slice(-400);
      logSeq = r.seq || r.logs[r.logs.length - 1].id;
      if (currentPage === 'logs') renderLogs();
    }
  } catch (_) {}
}

// ---------------------------------------------------------------- 动作

function serverPayload() {
  const p = {
    host: $('#s-host').value.trim(),
    port: Number($('#s-port').value) || 22,
    username: $('#s-user').value.trim() || 'root',
    remember: $('#o-remember').checked,
  };
  if ($('#s-pass').value) p.password = $('#s-pass').value;
  if ($('#s-sudo').value) p.sudoPassword = $('#s-sudo').value;
  if ($('#s-key').value.trim()) p.privateKeyPath = $('#s-key').value.trim();
  return p;
}

function optionsPayload() {
  return { autoConnect: $('#o-autoconnect').checked, autoReconnect: $('#o-autoreconnect').checked };
}

async function doConnect() {
  if (busy) return;
  busy = true;
  try {
    const r = await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ server: serverPayload(), options: optionsPayload() }),
    });
    if (r.state) { state = r.state; renderAll(); }
    toast(r.ok ? '隧道已建立' : (r.error || '连接失败'), r.ok ? 'ok' : 'error');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busy = false;
    refresh();
  }
}

async function doDisconnect() {
  try {
    const r = await api('/api/disconnect', { method: 'POST' });
    if (r.state) { state = r.state; renderAll(); }
    toast('已断开连接');
  } catch (err) { toast(err.message, 'error'); }
}

async function doExport() {
  const pwd = await askInput(
    '导出配置',
    '留空：只导出服务器地址与映射规则，不含密码\n填写：把登录凭据一并加密导出，导入时需要同一口令',
    '',
    '选填，留空则不含凭据'
  );
  if (pwd === null) return;
  try {
    const r = await api('/api/export', { method: 'POST', body: JSON.stringify({ password: pwd }) });
    if (!r.ok) return toast(r.error || '导出失败', 'error');
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portkey-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(pwd ? '已导出（含加密凭据）' : '已导出（不含凭据）', 'ok');
  } catch (err) { toast(err.message, 'error'); }
}

async function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    return toast('文件不是有效的 JSON', 'error');
  }
  let pwd = '';
  if (data && data.credentials) {
    pwd = await askInput('输入配置口令', '该配置包含加密凭据，请输入导出时设置的口令', '', '导出口令');
    if (pwd === null) return;
  }
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.stringify({ data, password: pwd }) });
    if (!r.ok) return toast(r.error || '导入失败', 'error');
    filled = false;
    await refresh();
    toast(`导入成功：${r.rules} 条映射`, 'ok');
    if (state.status === 'online') toast('配置已更新，建议重新连接使其生效');
  } catch (err) { toast(err.message, 'error'); }
}

async function doProvision() {
  try {
    const r = await api('/api/provision', { method: 'POST' });
    if (r.steps) { state.progress = r.steps; renderReport(); }
    toast(r.ok ? '服务器配置完成' : (r.error || '配置未完成，请查看报告'), r.ok ? 'ok' : 'error');
  } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) return goPage(nav.dataset.page);

  const goto = e.target.closest('[data-goto]');
  if (goto) return goPage(goto.dataset.goto);

  const seg = e.target.closest('#log-filter button');
  if (seg) {
    logFilter = seg.dataset.lv;
    $$('#log-filter button').forEach((b) => b.classList.toggle('active', b === seg));
    return renderLogs();
  }

  const btn = e.target.closest('[data-act]');
  if (btn && btn.dataset.act !== 'toggle') {
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    try {
      if (act === 'copy') {
        const ok = await copyText(btn.dataset.text || '');
        toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中复制', ok ? 'ok' : 'error');
      } else if (act === 'probe') {
        const r = (state.rules || []).find((x) => x.id === id);
        if (!r) return;
        const p = await api('/api/probe', { method: 'POST', body: JSON.stringify({ host: r.localHost, port: r.localPort }) });
        toast(p.ok ? `内网 ${r.localHost}:${r.localPort} 可访问` : `内网不可达：${p.error}`, p.ok ? 'ok' : 'error');
      } else if (act === 'rename') {
        const r = (state.rules || []).find((x) => x.id === id);
        const name = await askInput('修改备注', '给这条映射起一个容易辨认的名字', r ? r.name : '', '例如 家里 NAS');
        if (name === null) return;
        const res = await api('/api/rules/' + encodeURIComponent(id), {
          method: 'PATCH', body: JSON.stringify({ name: String(name).trim() }),
        });
        if (res.state) { state = res.state; renderAll(); }
        toast('备注已更新', 'ok');
      } else if (act === 'del') {
        const r = (state.rules || []).find((x) => x.id === id);
        const okDel = await askConfirm('删除映射', `确定删除「${(r && r.name) || id}」吗？删除后无法恢复。`, '删除', true);
        if (!okDel) return;
        const res = await api('/api/rules/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.state) { state = res.state; renderAll(); }
        toast(res.needRestart ? '已删除，重启隧道后端口释放' : '已删除', 'ok');
      }
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  switch (e.target.id) {
    case 'btn-connect':
      if (state && state.status === 'online') doDisconnect(); else doConnect();
      break;
    case 'btn-save':
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ server: serverPayload(), options: optionsPayload() }) });
        toast('配置已保存，正在连接…', 'ok');
        await refresh();
        doConnect();
      } catch (err) { toast(err.message, 'error'); }
      break;
    case 'btn-add': {
      const body = {
        localHost: $('#r-host').value.trim() || '127.0.0.1',
        localPort: Number($('#r-local').value),
        remotePort: Number($('#r-remote').value),
        protocol: $('#r-proto').value,
        name: $('#r-name').value.trim(),
      };
      if (!body.localPort || !body.remotePort) return toast('请填写内网端口和公网端口', 'error');
      try {
        const r = await api('/api/rules', { method: 'POST', body: JSON.stringify(body) });
        if (!r.ok) return toast(r.error, 'error');
        $('#r-local').value = ''; $('#r-remote').value = ''; $('#r-name').value = '';
        $('#r-proto').value = 'auto';
        if (r.state) { state = r.state; renderAll(); }
        toast(r.state && r.state.status === 'online' ? '映射已添加，公网端口已开放' : '映射已添加，连接服务器后生效', 'ok');
      } catch (err) { toast(err.message, 'error'); }
      break;
    }
    case 'btn-restart':
      toast('正在重启隧道…');
      try {
        const r = await api('/api/restart', { method: 'POST' });
        if (r.state) { state = r.state; renderAll(); }
        toast(r.ok ? '隧道已重建' : (r.error || '重启失败'), r.ok ? 'ok' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      break;
    case 'btn-test':
      toast('正在测试 SSH 连接…');
      try {
        const r = await api('/api/test', { method: 'POST', body: JSON.stringify({ server: serverPayload() }) });
        toast(r.ok ? `连接成功${r.info ? ' · ' + r.info : ''}` : (r.error || '测试失败'), r.ok ? 'ok' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      break;
    case 'btn-release':
      toast('正在重启隧道…');
      try {
        const r = await api('/api/restart', { method: 'POST' });
        if (r.state) { state = r.state; renderAll(); }
        toast(r.ok ? '端口已释放' : (r.error || '重启失败'), r.ok ? 'ok' : 'error');
      } catch (err) { toast(err.message, 'error'); }
      break;
    case 'btn-provision':
    case 'btn-provision2':
      doProvision();
      break;
    case 'btn-theme':
      toggleTheme();
      break;
    case 'btn-notify':
      toggleNotify();
      break;
    case 'btn-export':
      doExport();
      break;
    case 'btn-import':
      $('#import-file').click();
      break;
    case 'btn-clear-view':
      allLogs = [];
      renderLogs();
      break;
    case 'btn-quit':
      if (await askConfirm('退出程序', '退出后隧道将断开，需要重新启动程序才能恢复。', '退出', true)) {
        await fetch('/api/quit', { method: 'POST' });
        document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#94a3b8;font-family:system-ui">程序已退出，可以关闭此窗口</div>';
      }
      break;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act="toggle"]');
  if (!el) return;
  const id = el.dataset.id;
  try {
    const r = await api('/api/rules/' + encodeURIComponent(id), {
      method: 'PATCH', body: JSON.stringify({ enabled: el.checked }),
    });
    if (r.state) { state = r.state; renderAll(); }
    if (r.needRestart) toast('已停用，点「重启隧道」释放端口');
  } catch (err) {
    toast(err.message, 'error');
    el.checked = !el.checked;
  }
});

// ---------------------------------------------------------------- 启动

(async function init() {
  initTheme();
  updateNotifyButton();
  bindModal();
  goPage('overview');

  const fileInput = $('#import-file');
  if (fileInput) fileInput.addEventListener('change', onImportFile);
  window.addEventListener('resize', () => drawChart());

  await refresh();
  await pollLogs();
  renderLogs();
  setInterval(refresh, 2000);
  setInterval(pollLogs, 1500);
})();
