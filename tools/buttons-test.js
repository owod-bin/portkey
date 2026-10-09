'use strict';

/**
 * 按钮全覆盖测试：逐个点击界面上每个按钮，断言它确实发起了预期的请求或产生了预期变化。
 * 用于发现"点了没反应"的按钮。
 *
 * 注意：界面已不再使用浏览器原生 confirm/prompt（可能被静默阻止），
 * 全部改为自定义弹窗，因此这里通过点击 #modal-ok / #modal-cancel 来模拟用户确认。
 */

const fs = require('fs');
const path = require('path');

const Module = require('module');
process.env.NODE_PATH = path.resolve(__dirname, 'node_modules');
Module._initPaths();

const { JSDOM } = require('jsdom');

const PUBLIC = path.resolve(__dirname, '..', 'app', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info: info || '' });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${info ? '  → ' + info : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function makeState(overrides) {
  return Object.assign({
    localIPs: ['192.168.1.100'],
    version: '1.0.0',
    pid: 1234,
    status: 'online',
    statusText: '已连接',
    lastError: '',
    pendingRelease: false,
    server: { host: '1.2.3.4', port: 22, username: 'root', hasPassword: true, hasKey: false, privateKeyPath: '', remember: true },
    options: { autoConnect: false, autoReconnect: true, webPort: 7788, launchWindow: true },
    os: 'Ubuntu 22.04 LTS',
    progress: [{ key: 'os', title: '识别服务器系统', status: 'ok', detail: 'Ubuntu' }],
    stats: { startedAt: Date.now() - 60000, activeStreams: 1, totalStreams: 9, bytesIn: 2048, bytesOut: 4096, forwardedPorts: [8080], reconnects: 0, perRule: {} },
    serverStats: null,
    rules: [
      { id: 'r1', name: '家里 NAS', localHost: '127.0.0.1', localPort: 80, remotePort: 8080, protocol: 'http', enabled: true, live: true, url: 'http://1.2.3.4:8080', address: '1.2.3.4:8080', traffic: { bytesIn: 1, bytesOut: 2, streams: 1, active: 0 } },
    ],
  }, overrides || {});
}

async function setup(statePayload) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1:7788/', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];

  window.fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    let body = null;
    try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (_) {}
    calls.push({ url: String(url), method, body });
    const u = String(url);
    let resp;
    if (u.includes('/api/state')) resp = statePayload;
    else if (u.includes('/api/logs')) resp = { logs: [{ id: 1, time: '10:00:00', level: 'info', msg: '测试日志', detail: '' }], seq: 1 };
    else if (u.includes('/api/probe')) resp = { ok: true, error: '' };
    else if (u.includes('/api/test')) resp = { ok: true, info: 'Linux' };
    else if (u.includes('/api/export')) resp = { ok: true, data: { app: 'portkey', server: {}, rules: [] } };
    else if (u.includes('/api/import')) resp = { ok: true, rules: 2, state: statePayload };
    else if (u.includes('/api/connect')) resp = { ok: true, state: statePayload };
    else if (u.includes('/api/rules')) resp = { ok: true, rule: { id: 'r9' }, state: statePayload, needRestart: false };
    else resp = { ok: true, state: statePayload };
    return { ok: true, status: 200, json: async () => resp };
  };

  window.eval(appJs);
  await sleep(300);
  calls.length = 0;

  const doc = window.document;
  const api = {
    doc,
    win: window,
    calls,
    click: (sel) => {
      const el = typeof sel === 'string' ? doc.querySelector(sel) : sel;
      if (!el) throw new Error('找不到元素：' + sel);
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      return el;
    },
    change: (sel) => {
      const el = typeof sel === 'string' ? doc.querySelector(sel) : sel;
      if (!el) throw new Error('找不到元素：' + sel);
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
      return el;
    },
    modalOpen: () => doc.querySelector('#modal').style.display !== 'none',
    modalTitle: () => txt(doc.querySelector('#modal-title')),
    modalType: (v) => { doc.querySelector('#modal-input').value = v; },
    ok: () => { api.click('#modal-ok'); return sleep(80); },
    cancel: () => { api.click('#modal-cancel'); return sleep(60); },
    hit: (frag, method) => calls.some((c) => c.url.includes(frag) && (!method || c.method === method)),
    hits: (frag) => calls.filter((c) => c.url.includes(frag)),
    clearCalls: () => { calls.length = 0; },
  };
  return api;
}

(async function main() {
  console.log('\n=== 按钮功能全覆盖测试 ===\n');

  // ---------------- 代码层面：不该再用原生弹窗 ----------------
  {
    console.log('-- 弹窗实现方式 --');
    check('不再使用原生 confirm()', !/(^|[^a-zA-Z])confirm\s*\(/.test(appJs));
    check('不再使用原生 prompt()', !/(^|[^a-zA-Z])prompt\s*\(/.test(appJs));
    check('页面内置了自定义弹窗', html.includes('id="modal"') && html.includes('id="modal-ok"'));
  }

  // ---------------- 页头 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 页头按钮 --');
    s.click('#btn-connect');
    await sleep(50);
    check('「断开连接」按钮生效（在线时）', s.hit('/api/disconnect', 'POST'));

    const s2 = await setup(makeState({ status: 'idle', statusText: '未连接' }));
    s2.click('#btn-connect');
    await sleep(50);
    check('「一键连接」按钮生效（离线时）', s2.hit('/api/connect', 'POST'));
    check('连接请求带上了服务器信息', (s2.hits('/api/connect')[0] || {}).body
      && s2.hits('/api/connect')[0].body.server.host === '1.2.3.4');

    const s3 = await setup(makeState());
    s3.click('#btn-restart');
    await sleep(50);
    check('「重启隧道」按钮生效', s3.hit('/api/restart', 'POST'));
  }

  // ---------------- 侧栏 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 侧栏按钮 --');
    const before = s.doc.documentElement.getAttribute('data-theme');
    s.click('#btn-theme');
    await sleep(30);
    check('「主题切换」按钮生效', s.doc.documentElement.getAttribute('data-theme') !== before,
      `${before} → ${s.doc.documentElement.getAttribute('data-theme')}`);

    s.click('#btn-notify');
    await sleep(30);
    check('「桌面通知」按钮有反馈', txt(s.doc.querySelector('#toast')).length > 0, txt(s.doc.querySelector('#toast')));

    s.click('.nav-item[data-page="rules"]');
    await sleep(30);
    check('侧栏导航可切换页面', s.doc.querySelector('#page-rules').classList.contains('active'));

    s.click('.nav-item[data-page="logs"]');
    await sleep(30);
    check('侧栏导航可切到日志页', s.doc.querySelector('#page-logs').classList.contains('active'));

    s.click('#btn-clear-view');
    await sleep(30);
    check('「清屏」按钮清空了日志', txt(s.doc.querySelector('#logbox')) === '暂无日志', txt(s.doc.querySelector('#logbox')));
  }

  // ---------------- 退出（会清空页面，单独一个场景）----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 退出程序 --');
    s.click('#btn-quit');
    await sleep(80);
    check('「退出程序」先弹确认框', s.modalOpen(), s.modalTitle());
    check('确认框标题正确', s.modalTitle().includes('退出'), s.modalTitle());
    await s.ok();
    await sleep(60);
    check('确认后程序退出', s.doc.body.textContent.includes('程序已退出'), txt(s.doc.body).slice(0, 24));
  }

  // ---------------- 概览页 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 概览页按钮 --');
    s.click('[data-goto="rules"]');
    await sleep(30);
    check('「管理映射」跳转生效', s.doc.querySelector('#page-rules').classList.contains('active'));

    s.click('#btn-provision');
    await sleep(50);
    check('「重新配置」按钮生效', s.hit('/api/provision', 'POST'));

    const copyBtn = s.doc.querySelector('#addr-list [data-act="copy"]');
    check('访问地址有复制按钮', !!copyBtn);
    if (copyBtn) {
      s.clearCalls();
      s.click(copyBtn);
      await sleep(50);
      check('「复制地址」有反馈', txt(s.doc.querySelector('#toast')).length > 0, txt(s.doc.querySelector('#toast')));
    }
    const openLink = s.doc.querySelector('#addr-list a');
    check('访问地址有打开链接', !!openLink && openLink.getAttribute('href').startsWith('http'));
  }

  // ---------------- 端口映射页 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 端口映射页按钮 --');
    s.click('.nav-item[data-page="rules"]');
    await sleep(30);

    s.doc.querySelector('#r-local').value = '80';
    s.doc.querySelector('#r-remote').value = '8081';
    s.doc.querySelector('#r-name').value = '测试';
    s.click('#btn-add');
    await sleep(50);
    const addCall = s.hits('/api/rules').find((c) => c.method === 'POST');
    check('「添加映射」按钮生效', !!addCall);
    check('添加请求参数正确', !!addCall && addCall.body.localPort === 80 && addCall.body.remotePort === 8081,
      addCall ? JSON.stringify(addCall.body) : '');

    s.clearCalls();
    s.click('#rules-table [data-act="probe"]');
    await sleep(50);
    check('「探测」按钮生效', s.hit('/api/probe', 'POST'));

    s.clearCalls();
    s.click('#rules-table [data-act="rename"]');
    await sleep(80);
    check('「重命名」弹出输入框', s.modalOpen() && s.doc.querySelector('#modal-input').style.display !== 'none', s.modalTitle());
    s.modalType('新的备注名');
    await s.ok();
    const renameCall = s.hits('/api/rules/r1').find((c) => c.method === 'PATCH');
    check('「重命名」提交内容正确', !!renameCall && renameCall.body.name === '新的备注名',
      renameCall ? JSON.stringify(renameCall.body) : '未发出请求');

    s.clearCalls();
    s.click('#rules-table [data-act="rename"]');
    await sleep(80);
    await s.cancel();
    check('「重命名」取消后不提交', !s.hit('/api/rules/r1', 'PATCH'));

    s.clearCalls();
    s.click('#rules-table [data-act="del"]');
    await sleep(80);
    check('「删除」弹出确认框', s.modalOpen(), s.modalTitle());
    await s.ok();
    await sleep(60);
    check('「删除」确认后执行', s.hit('/api/rules/r1', 'DELETE'));

    s.clearCalls();
    s.click('#rules-table [data-act="del"]');
    await sleep(80);
    await s.cancel();
    check('「删除」取消后不执行', !s.hit('/api/rules/r1', 'DELETE'));

    s.clearCalls();
    const tgl = s.doc.querySelector('#rules-table .toggle input');
    tgl.checked = false;
    s.change(tgl);
    await sleep(60);
    const patch = s.hits('/api/rules/r1').find((c) => c.method === 'PATCH');
    check('「启停开关」发送正确状态', !!patch && patch.body.enabled === false,
      patch ? JSON.stringify(patch.body) : '未发出请求');

    const copy2 = s.doc.querySelector('#rules-table [data-act="copy"]');
    if (copy2) {
      s.clearCalls();
      s.click(copy2);
      await sleep(50);
      check('映射行「复制地址」有反馈', txt(s.doc.querySelector('#toast')).length > 0);
    }
  }

  // ---------------- 服务器页 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 服务器页按钮 --');
    s.click('.nav-item[data-page="server"]');
    await sleep(30);

    s.click('#btn-test');
    await sleep(50);
    check('「测试连接」按钮生效', s.hit('/api/test', 'POST'));

    s.clearCalls();
    s.click('#btn-provision2');
    await sleep(50);
    check('「仅配置服务器」按钮生效', s.hit('/api/provision', 'POST'));

    s.clearCalls();
    s.click('#btn-save');
    await sleep(80);
    check('「保存并连接」保存了配置', s.hit('/api/config', 'POST'));
    check('「保存并连接」随后发起连接', s.hit('/api/connect', 'POST'));

    s.clearCalls();
    s.click('#btn-export');
    await sleep(80);
    check('「导出配置」弹出输入框', s.modalOpen(), s.modalTitle());
    await s.ok();
    await sleep(80);
    check('「导出配置」按钮生效', s.hit('/api/export', 'POST'));

    let fileClicked = false;
    const fileInput = s.doc.querySelector('#import-file');
    fileInput.addEventListener('click', () => { fileClicked = true; });
    s.click('#btn-import');
    await sleep(50);
    check('「导入配置」触发文件选择', fileClicked);
    check('导入控件可被程序化点击（非 display:none）',
      !(fileInput.getAttribute('style') || '').includes('display:none'),
      fileInput.getAttribute('style') || '使用 .offscreen 类');
  }

  // ---------------- 待释放提示条 ----------------
  {
    const s = await setup(makeState({ pendingRelease: true }));
    console.log('\n-- 待释放提示条 --');
    s.click('.nav-item[data-page="rules"]');
    await sleep(30);
    check('提示条已渲染', txt(s.doc.querySelector('#release-alert')).includes('有端口尚未释放'));
    s.clearCalls();
    s.click('#btn-release');
    await sleep(50);
    check('「立即重启隧道」按钮生效', s.hit('/api/restart', 'POST'));
  }

  // ---------------- 日志筛选 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 日志筛选 --');
    s.click('.nav-item[data-page="logs"]');
    await sleep(30);
    s.click('#log-filter button[data-lv="warn"]');
    await sleep(30);
    check('日志筛选按钮生效', s.doc.querySelector('#log-filter button[data-lv="warn"]').classList.contains('active'));
    check('筛选后日志区有内容', txt(s.doc.querySelector('#logbox')).length > 0, txt(s.doc.querySelector('#logbox')).slice(0, 30));
  }

  // ---------------- 按钮完整性 ----------------
  {
    const s = await setup(makeState());
    console.log('\n-- 按钮完整性 --');
    const ids = ['btn-connect', 'btn-restart', 'btn-theme', 'btn-notify', 'btn-quit', 'btn-add',
      'btn-save', 'btn-test', 'btn-provision', 'btn-provision2', 'btn-export', 'btn-import',
      'btn-clear-view', 'modal-ok', 'modal-cancel'];
    const missing = ids.filter((id) => !s.doc.querySelector('#' + id));
    check('所有按钮都存在', missing.length === 0, missing.join(', ') || '全部存在');

    const orphans = [];
    s.doc.querySelectorAll('button').forEach((b) => {
      const known = b.id || b.dataset.act || b.dataset.page || b.dataset.goto || b.closest('#log-filter') || b.closest('.modal');
      if (!known) orphans.push(b.outerHTML.slice(0, 60));
    });
    check('没有无处理逻辑的按钮', orphans.length === 0, orphans.join(' | ') || '全部有绑定');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.info ? ' :: ' + f.info : '')));
    process.exit(1);
  }
  process.exit(0);
})();
