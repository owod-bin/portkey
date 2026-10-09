'use strict';

/**
 * 界面渲染测试：用 jsdom 加载真实页面并执行前端脚本，
 * 校验各区块是否按预期渲染（无需真实浏览器）
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
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function makeState(overrides) {
  return Object.assign({
    localIPs: ['192.168.1.100'],
    status: 'online',
    statusText: '已连接',
    lastError: '',
    server: { host: '1.2.3.4', port: 22, username: 'root', hasPassword: true, hasKey: false, privateKeyPath: '', remember: true },
    options: { autoConnect: false, autoReconnect: true, webPort: 7788, launchWindow: true },
    os: 'Ubuntu 22.04 LTS',
    progress: [
      { key: 'os', title: '识别服务器系统', status: 'ok', detail: 'Ubuntu 22.04 LTS' },
      { key: 'write', title: '写入 sshd 配置', status: 'ok', detail: '已开启 GatewayPorts' },
    ],
    stats: { startedAt: Date.now() - 90000, activeStreams: 2, totalStreams: 10, bytesIn: 1024, bytesOut: 2048, forwardedPorts: [8080], reconnects: 0 },
    rules: [
      { id: 'r1', name: '家里 NAS', localHost: '127.0.0.1', localPort: 80, remotePort: 8080, protocol: 'http', enabled: true, live: true, url: 'http://1.2.3.4:8080', address: '1.2.3.4:8080', traffic: { bytesIn: 1024, bytesOut: 2048, streams: 5, active: 1 } },
      { id: 'r2', name: '远程桌面', localHost: '192.168.1.50', localPort: 3389, remotePort: 33890, protocol: 'tcp', enabled: true, live: true, url: '', address: '1.2.3.4:33890' },
      { id: 'r3', name: '', localHost: '127.0.0.1', localPort: 9999, remotePort: 9999, protocol: 'tcp', enabled: false, live: false, url: '', address: '' },
    ],
  }, overrides || {});
}

async function runScenario(title, statePayload, asserts) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1:7788/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async (url) => {
    const u = String(url);
    let body = {};
    if (u.includes('/api/state')) body = statePayload;
    else if (u.includes('/api/logs')) body = { logs: [{ id: 1, time: '12:00:00', level: 'info', msg: '隧道已建立', detail: '端口 8080' }], seq: 1 };
    return { ok: true, status: 200, json: async () => body };
  };
  window.eval(appJs);
  await new Promise((r) => setTimeout(r, 400));

  console.log(`\n-- ${title} --`);
  asserts(window.document, window);
  window.close();
}

(async function main() {
  console.log('\n=== 界面渲染测试 ===');

  await runScenario('已连接 · 有映射', makeState(), (doc) => {
    check('顶部状态显示已连接', txt(doc.querySelector('#status-text')) === '已连接', txt(doc.querySelector('#status-text')));
    check('状态胶囊样式为 online', doc.querySelector('#status-pill').className.includes('online'), doc.querySelector('#status-pill').className);
    check('主按钮切换为断开连接', txt(doc.querySelector('#btn-connect')) === '断开连接', txt(doc.querySelector('#btn-connect')));
    check('侧栏状态同步', txt(doc.querySelector('#side-status')) === '已连接');
    check('侧栏显示服务器地址', txt(doc.querySelector('#side-host')) === 'root@1.2.3.4:22', txt(doc.querySelector('#side-host')));
    check('侧栏状态点变绿', doc.querySelector('#side-dot').className.includes('online'));
    check('主状态区标题正确', txt(doc.querySelector('#hero-title')) === '隧道已连接', txt(doc.querySelector('#hero-title')));
    check('主状态区含系统与运行时长', txt(doc.querySelector('#hero-sub')).includes('Ubuntu') && txt(doc.querySelector('#hero-sub')).includes('已运行'), txt(doc.querySelector('#hero-sub')));
    check('主状态区展示 3 项统计', doc.querySelectorAll('#hero-side .hero-stat').length === 3, String(doc.querySelectorAll('#hero-side .hero-stat').length));
    check('指标卡渲染 4 项', doc.querySelectorAll('#stats .metric').length === 4, String(doc.querySelectorAll('#stats .metric').length));
    check('已开放端口数为 2', txt(doc.querySelector('#stats .metric b')) === '2', txt(doc.querySelector('#stats .metric b')));
    check('访问地址列表有 2 条', doc.querySelectorAll('#addr-list .addr-item').length === 2, String(doc.querySelectorAll('#addr-list .addr-item').length));
    check('网页映射显示 http 地址', txt(doc.querySelector('#addr-list code')) === 'http://1.2.3.4:8080', txt(doc.querySelector('#addr-list code')));
    check('网页映射含打开链接', !!doc.querySelector('#addr-list a[href="http://1.2.3.4:8080"]'));
    check('TCP 映射显示裸地址', txt(doc.querySelectorAll('#addr-list code')[1]) === '1.2.3.4:33890', txt(doc.querySelectorAll('#addr-list code')[1]));
    check('TCP 映射不显示打开按钮', doc.querySelectorAll('#addr-list .addr-item')[1].querySelector('a') === null);
    check('地址标注服务类型', txt(doc.querySelector('#addr-list')).includes('网页 HTTP') && txt(doc.querySelector('#addr-list')).includes('TCP 服务'));
    check('映射列表渲染 3 行', doc.querySelectorAll('#rules-table .row').length === 3, String(doc.querySelectorAll('#rules-table .row').length));
    check('已开放徽章显示', txt(doc.querySelector('#rules-table')).includes('已开放'));
    check('已停用徽章显示', txt(doc.querySelector('#rules-table')).includes('已停用'));
    check('映射行显示协议标签', txt(doc.querySelector('#rules-table')).includes('HTTP') && txt(doc.querySelector('#rules-table')).includes('TCP'));
    check('启停开关状态正确', doc.querySelector('#rules-table .toggle input').checked === true && doc.querySelectorAll('#rules-table .toggle input')[2].checked === false);
    check('侧栏映射数量徽章', txt(doc.querySelector('#nav-rule-count')) === '3', txt(doc.querySelector('#nav-rule-count')));
    check('配置报告渲染 2 步', doc.querySelectorAll('#provision-report li').length === 2, String(doc.querySelectorAll('#provision-report li').length));
    check('配置报告同步到服务器页', doc.querySelectorAll('#provision-report2 li').length === 2);
    check('三步引导已隐藏', txt(doc.querySelector('#overview-alert')) === '', txt(doc.querySelector('#overview-alert')));
    check('表单回填服务器地址', doc.querySelector('#s-host').value === '1.2.3.4');
    check('映射统计文案正确', txt(doc.querySelector('#rules-summary')).includes('2 条已开放'), txt(doc.querySelector('#rules-summary')));
    check('本机内网 IP 已显示', txt(doc.querySelector('#lan-ips')).includes('192.168.1.100'));
    check('默认停留在概览页', doc.querySelector('#page-overview').classList.contains('active'));
    check('重启按钮可见', doc.querySelector('#btn-restart').style.display !== 'none');
    check('服务器页有测试连接按钮', !!doc.querySelector('#btn-test'));
    check('每行都有重命名按钮', doc.querySelectorAll('#rules-table [data-act="rename"]').length === 3,
      String(doc.querySelectorAll('#rules-table [data-act="rename"]').length));
    check('每行都有探测按钮', doc.querySelectorAll('#rules-table [data-act="probe"]').length === 3);
    check('每行都有删除按钮', doc.querySelectorAll('#rules-table [data-act="del"]').length === 3);
    check('无待释放端口时不显示提示条', txt(doc.querySelector('#release-alert')) === '', txt(doc.querySelector('#release-alert')));
  });

  await runScenario('有端口待释放', makeState({
    pendingRelease: true,
    rules: [{ id: 'r9', name: '已停用的服务', localHost: '127.0.0.1', localPort: 80, remotePort: 8080, enabled: false, live: false, url: '' }],
  }), (doc) => {
    check('显示端口待释放提示', txt(doc.querySelector('#release-alert')).includes('有端口尚未释放'), txt(doc.querySelector('#release-alert')));
    check('提示条带重启按钮', !!doc.querySelector('#btn-release'));
    check('停用行显示已停用徽章', txt(doc.querySelector('#rules-table')).includes('已停用'));
    check('待释放时地址列表为空', txt(doc.querySelector('#addr-list')).includes('暂无可用地址'));
  });

  await runScenario('未连接 · 未配置服务器', makeState({
    status: 'idle', statusText: '未连接', os: '', progress: [], rules: [],
    stats: { startedAt: null, activeStreams: 0, totalStreams: 0, bytesIn: 0, bytesOut: 0, forwardedPorts: [], reconnects: 0 },
    server: { host: '', port: 22, username: 'root', hasPassword: false, hasKey: false, privateKeyPath: '', remember: true },
  }), (doc) => {
    check('按钮显示一键连接', txt(doc.querySelector('#btn-connect')) === '一键连接', txt(doc.querySelector('#btn-connect')));
    check('引导提示第 1 步', txt(doc.querySelector('#overview-alert')).includes('先填写服务器信息'), txt(doc.querySelector('#overview-alert')));
    check('主状态区提示未连接', txt(doc.querySelector('#hero-title')) === '尚未连接', txt(doc.querySelector('#hero-title')));
    check('访问地址为空状态', txt(doc.querySelector('#addr-list')).includes('暂无可用地址'));
    check('映射列表为空状态', txt(doc.querySelector('#rules-table')).includes('还没有端口映射'));
    check('侧栏提示尚未配置', txt(doc.querySelector('#side-host')) === '尚未配置服务器');
    check('重启按钮隐藏', doc.querySelector('#btn-restart').style.display === 'none');
    check('流量显示 0 B', txt(doc.querySelector('#stats')).includes('0 B'));
    check('配置报告为空提示', txt(doc.querySelector('#provision-report')).includes('连接服务器后'));
    check('未连接时资源面板给出提示', txt(doc.querySelector('#server-stats')).includes('连接服务器后'), txt(doc.querySelector('#server-stats')));
  });

  await runScenario('已配置但未连接', makeState({
    status: 'idle', statusText: '未连接', os: '', progress: [], rules: [],
    stats: { startedAt: null, activeStreams: 0, totalStreams: 0, bytesIn: 0, bytesOut: 0, forwardedPorts: [], reconnects: 0 },
  }), (doc) => {
    check('引导提示第 2 步', txt(doc.querySelector('#overview-alert')).includes('下一步：一键连接'), txt(doc.querySelector('#overview-alert')));
    check('主状态区提示已保存服务器', txt(doc.querySelector('#hero-sub')).includes('已保存服务器'), txt(doc.querySelector('#hero-sub')));
  });

  await runScenario('连接失败', makeState({
    status: 'error', lastError: '登录失败：用户名或密码错误', os: '', progress: [], rules: [],
  }), (doc) => {
    check('状态胶囊为 error', doc.querySelector('#status-pill').className.includes('error'), doc.querySelector('#status-pill').className);
    check('主状态区显示连接失败', txt(doc.querySelector('#hero-title')) === '连接失败', txt(doc.querySelector('#hero-title')));
    check('错误详情展示', txt(doc.querySelector('#hero-sub')).includes('登录失败'), txt(doc.querySelector('#hero-sub')));
    check('引导条显示错误', txt(doc.querySelector('#overview-alert')).includes('连接出错'));
  });

  await runScenario('服务器资源面板', makeState({
    serverStats: {
      at: Date.now(), load: [0.15, 0.1, 0.05], cores: 2, uptime: 86400, cpuPercent: 25,
      mem: { totalMB: 2000, usedMB: 500, percent: 25 },
      disk: { totalGB: 40, usedGB: 12, percent: 30 },
      netRate: { rx: 1024, tx: 512 },
      netTotal: { rx: 1048576, tx: 524288 },
    },
  }), (doc) => {
    const t = txt(doc.querySelector('#server-stats'));
    check('显示 CPU 使用率', t.includes('25%'), t.slice(0, 60));
    check('显示平均负载', t.includes('0.15'), '');
    check('显示内存占用', t.includes('500 MB'), '');
    check('显示磁盘占用', t.includes('12 GB'), '');
    check('显示服务器运行时长', t.includes('1 天'), '');
    check('进度条渲染 3 条', doc.querySelectorAll('#server-stats .bar').length === 3, String(doc.querySelectorAll('#server-stats .bar').length));
    check('展示服务器系统版本', txt(doc.querySelector('#server-os')).includes('Ubuntu'), txt(doc.querySelector('#server-os')));
  });

  await runScenario('主题与工具栏', makeState(), (doc, win) => {
    check('侧栏有主题切换按钮', !!doc.querySelector('#btn-theme'));
    check('侧栏有通知按钮', !!doc.querySelector('#btn-notify'));
    check('已应用主题属性', ['light', 'dark'].includes(doc.documentElement.getAttribute('data-theme')), String(doc.documentElement.getAttribute('data-theme')));
    const before = doc.documentElement.getAttribute('data-theme');
    doc.querySelector('#btn-theme').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const after = doc.documentElement.getAttribute('data-theme');
    check('点击可切换深浅色', before !== after, `${before} → ${after}`);
    check('主题选择已持久化', win.localStorage.getItem('portkey-theme') === after, String(win.localStorage.getItem('portkey-theme')));
    check('概览页有速率曲线画布', !!doc.querySelector('#rate-chart'));
    check('速率图例含下载与上传', txt(doc.querySelector('#chart-card')).includes('下载') && txt(doc.querySelector('#chart-card')).includes('上传'));
    check('服务器状态卡片存在', !!doc.querySelector('#server-stats'));
    check('在线但无数据时提示采集中', txt(doc.querySelector('#server-stats')).includes('正在采集'), txt(doc.querySelector('#server-stats')));
    check('服务器页有导出按钮', !!doc.querySelector('#btn-export'));
    check('服务器页有导入按钮', !!doc.querySelector('#btn-import'));
    check('映射行显示流量统计', txt(doc.querySelector('#rules-table')).includes('流量'), '');
  });

  await runScenario('页面切换', makeState(), (doc, win) => {
    const nav = doc.querySelector('.nav-item[data-page="rules"]');
    nav.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('切换到端口映射页', doc.querySelector('#page-rules').classList.contains('active') && !doc.querySelector('#page-overview').classList.contains('active'));
    check('页头标题同步', txt(doc.querySelector('#page-title')) === '端口映射', txt(doc.querySelector('#page-title')));
    check('导航项高亮同步', nav.classList.contains('active'));

    const seg = doc.querySelector('#log-filter button[data-lv="warn"]');
    seg.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('日志筛选可切换', seg.classList.contains('active'));

    const goto = doc.querySelector('[data-goto="rules"]');
    doc.querySelector('.nav-item[data-page="overview"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    goto.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('快捷跳转按钮生效', doc.querySelector('#page-rules').classList.contains('active'));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.info ? ' :: ' + f.info : '')));
    process.exit(1);
  }
  process.exit(0);
})();
