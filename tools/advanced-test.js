'use strict';

/**
 * 深度测试：二进制完整性、并发、大流量、断线重连、
 * 边界输入、配置持久化、单实例、配置损坏恢复等
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TEST_DATA = path.join(__dirname, '.adv-data');
const SSH_PORT = 2232;
const LAN_PORT = 18091;
const PUB_PORT = 18110;
const WEB_PORT = 7791;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, info) {
  results.push({ name, ok: !!ok, info: info || '' });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${info ? '  → ' + info : ''}`);
}

const base = () => `http://127.0.0.1:${WEB_PORT}`;

async function api(pathname, body, method = 'POST') {
  const res = await fetch(base() + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

// agent:false —— 每次请求独立建连，便于精确校验连接计数
function getText(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

function getBuffer(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, buf: Buffer.alloc(0), error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, buf: Buffer.alloc(0), error: 'timeout' }); });
  });
}

async function waitFor(fn, timeout = 25000, interval = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const r = await fn(); if (r) return r; } catch (_) {}
    await sleep(interval);
  }
  return null;
}

// 1MB 可复现的二进制数据
const BINARY = (() => {
  const b = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7 + 13) % 251;
  return b;
})();
const BINARY_MD5 = crypto.createHash('md5').update(BINARY).digest('hex');

async function main() {
  console.log('\n=== 互联网穿透 · 深度测试 ===\n');
  const children = [];
  let app = null;
  let mock = null;

  const spawnNode = (file, args, env) => {
    const child = spawn(NODE, [file].concat(args || []), {
      env: Object.assign({}, process.env, env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('  | ' + d));
    child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('  ! ' + d));
    children.push(child);
    return child;
  };

  const kill = (c) => { try { c.kill('SIGKILL'); } catch (_) {} };
  const startMock = () => { mock = spawnNode(path.join(__dirname, 'mock-sshd.js'), [String(SSH_PORT)]); return mock; };
  const startApp = () => { app = spawnNode(path.join(ROOT, 'app', 'src', 'main.js'), ['--no-window'], { PORTKEY_DATA: TEST_DATA }); return app; };

  const cleanup = () => { for (const c of children) kill(c); };

  try {
    fs.rmSync(TEST_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA, { recursive: true });
    fs.writeFileSync(path.join(TEST_DATA, 'config.json'), JSON.stringify({
      server: { host: '', port: 22, username: 'root', password: '', privateKeyPath: '', sudoPassword: '', remember: true },
      rules: [],
      options: { autoConnect: false, autoReconnect: true, webPort: WEB_PORT, launchWindow: false },
      provisionedHosts: {},
    }, null, 2));

    // ---------- 环境 ----------
    startMock();
    const sshUp = await waitFor(() => new Promise((res) => {
      const s = require('net').connect(SSH_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    }), 8000);
    check('模拟服务器就绪', sshUp);

    const lanServer = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/binary')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BINARY.length });
        res.end(BINARY);
        return;
      }
      if ((req.url || '').startsWith('/chunked')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        let n = 0;
        const t = setInterval(() => {
          if (n++ >= 50) { clearInterval(t); res.end(); return; }
          res.write('chunk-' + n + '\n');
        }, 5);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('LANSERVICE_OK');
    });
    await new Promise((r) => lanServer.listen(LAN_PORT, '127.0.0.1', r));

    startApp();
    const ready = await waitFor(async () => {
      const r = await getText(base() + '/api/state');
      return r.status === 200 ? r : null;
    }, 20000);
    check('客户端程序启动', !!ready);
    if (!ready) throw new Error('程序未能启动');

    // ---------- 连接与映射 ----------
    const conn = await api('/api/connect', {
      server: { host: '127.0.0.1', port: SSH_PORT, username: 'root', password: 'pw', sudoPassword: 'pw' },
    });
    check('一键连接成功', conn.ok === true, conn.error || '');
    check('连接后 pendingRelease 为 false', conn.state.pendingRelease === false);

    const add = await api('/api/rules', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT, name: '深度测试' });
    check('添加映射成功', add.ok === true, add.error || '');
    await sleep(400);

    // ---------- 1. 二进制完整性 ----------
    const bin = await getBuffer(`http://127.0.0.1:${PUB_PORT}/binary`);
    const md5 = crypto.createHash('md5').update(bin.buf).digest('hex');
    check('1MB 二进制经隧道传输完整', bin.status === 200 && md5 === BINARY_MD5,
      `status=${bin.status} 收到=${bin.buf.length}B md5=${md5 === BINARY_MD5 ? '一致' : '不一致'}`);

    // ---------- 2. 分块流式响应 ----------
    const chunked = await getText(`http://127.0.0.1:${PUB_PORT}/chunked`);
    check('分块流式响应正常', chunked.status === 200 && chunked.body.includes('chunk-50'),
      `chunk 数=${(chunked.body.match(/chunk-/g) || []).length}`);

    // ---------- 3. 并发连接 ----------
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => getText(`http://127.0.0.1:${PUB_PORT}/`))
    );
    const okCount = concurrent.filter((r) => r.status === 200 && r.body === 'LANSERVICE_OK').length;
    check('20 个并发连接全部成功', okCount === 20, `${okCount}/20`);

    // ---------- 4. 并发二进制（大流量）----------
    const concurrentBin = await Promise.all(
      Array.from({ length: 5 }, () => getBuffer(`http://127.0.0.1:${PUB_PORT}/binary`))
    );
    const binOk = concurrentBin.filter((r) => crypto.createHash('md5').update(r.buf).digest('hex') === BINARY_MD5).length;
    check('5 路并发 1MB 传输无损坏', binOk === 5, `${binOk}/5`);

    // ---------- 5. 统计与状态 ----------
    await sleep(1200); // 等连接回收
    const st = await api('/api/state', undefined, 'GET');
    check('活跃连接数已归零', st.stats.activeStreams === 0, String(st.stats.activeStreams));
    check('累计流量已统计', st.stats.bytesIn + st.stats.bytesOut > 5 * 1024 * 1024,
      `${((st.stats.bytesIn + st.stats.bytesOut) / 1048576).toFixed(1)} MB`);
    check('总连接数已累计', st.stats.totalStreams >= 26, String(st.stats.totalStreams));

    // ---------- 6. 边界输入 ----------
    const cases = [
      ['端口为 0', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: 0 }, false],
      ['端口超范围', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: 70000 }, false],
      ['端口为负数', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: -1 }, false],
      ['端口为字符串', { localHost: '127.0.0.1', localPort: 'abc', remotePort: 12345 }, false],
      ['端口重复', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT }, false],
      ['缺少内网端口', { localHost: '127.0.0.1', remotePort: 12346 }, false],
    ];
    for (const [name, body, expectOk] of cases) {
      const r = await api('/api/rules', body);
      check(`边界输入被拒绝：${name}`, r.ok === expectOk, r.error || '（未报错）');
    }

    // ---------- 6b. 服务类型自动识别 ----------
    const protoCases = [
      [80, 'http', 'HTTP 网页端口'],
      [8080, 'http', 'HTTP 备用端口'],
      [443, 'https', 'HTTPS 端口'],
      [3389, 'tcp', '远程桌面端口'],
      [22, 'tcp', 'SSH 端口'],
    ];
    for (let i = 0; i < protoCases.length; i++) {
      const [lp, expect, label] = protoCases[i];
      const rp = PUB_PORT + 20 + i;
      const res = await api('/api/rules', { localHost: '127.0.0.1', localPort: lp, remotePort: rp, name: label });
      const rule = res.ok ? res.state.rules.find((r) => r.remotePort === rp) : null;
      check(`服务类型自动识别：内网 ${lp} → ${expect}`, !!rule && rule.protocol === expect, rule ? rule.protocol : (res.error || ''));
      if (rule) await api('/api/rules/' + rule.id, undefined, 'DELETE');
    }
    const explicit = await api('/api/rules', { localHost: '127.0.0.1', localPort: 3389, remotePort: PUB_PORT + 30, protocol: 'http', name: '手动指定' });
    const exRule = explicit.state.rules.find((r) => r.remotePort === PUB_PORT + 30);
    check('可手动指定服务类型', exRule && exRule.protocol === 'http', exRule ? exRule.protocol : '');
    if (exRule) await api('/api/rules/' + exRule.id, undefined, 'DELETE');

    // ---------- 7. 特殊字符与超长备注 ----------
    const weird = await api('/api/rules', {
      localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT + 5,
      name: '<script>alert(1)</script>"\'`&中文测试',
    });
    check('特殊字符备注可保存', weird.ok === true, weird.error || '');
    if (weird.ok) {
      const saved = weird.state.rules.find((r) => r.remotePort === PUB_PORT + 5);
      check('备注内容原样保存', saved && saved.name === '<script>alert(1)</script>"\'`&中文测试', saved ? saved.name : '');
      await api('/api/rules/' + saved.id, undefined, 'DELETE');
    }

    const longName = 'x'.repeat(500);
    const longRes = await api('/api/rules', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT + 6, name: longName });
    check('超长备注不会崩溃', typeof longRes.ok === 'boolean', longRes.error || 'ok');
    if (longRes.ok) {
      const s2 = longRes.state.rules.find((r) => r.remotePort === PUB_PORT + 6);
      await api('/api/rules/' + s2.id, undefined, 'DELETE');
    }

    // ---------- 8. 重命名 ----------
    const rid = add.state.rules.find((r) => r.remotePort === PUB_PORT).id;
    const renamed = await api('/api/rules/' + rid, { name: '改过的备注' }, 'PATCH');
    check('重命名映射成功', renamed.ok === true && renamed.state.rules.find((r) => r.id === rid).name === '改过的备注',
      renamed.error || '');

    // ---------- 9. 端口待释放状态 ----------
    const off = await api('/api/rules/' + rid, { enabled: false }, 'PATCH');
    check('停用映射提示需重启', off.ok === true && off.needRestart === true, JSON.stringify({ needRestart: off.needRestart }));
    check('pendingRelease 已置位', off.state.pendingRelease === true);

    const restarted = await api('/api/restart', {});
    check('重启隧道成功', restarted.ok === true, restarted.error || '');
    check('重启后 pendingRelease 清除', restarted.state.pendingRelease === false);
    check('重启后规则仍为停用', restarted.state.rules.find((r) => r.id === rid).enabled === false);
    check('重启后已开放端口数为 0', restarted.state.rules.filter((r) => r.live).length === 0);

    const on = await api('/api/rules/' + rid, { enabled: true }, 'PATCH');
    check('重新启用映射', on.ok === true, on.error || '');
    await sleep(400);
    const back = await getText(`http://127.0.0.1:${PUB_PORT}/`);
    check('重新启用后可再次访问', back.status === 200 && back.body === 'LANSERVICE_OK', 'status=' + back.status);

    // ---------- 10. 探测接口 ----------
    const probeOk = await api('/api/probe', { host: '127.0.0.1', port: LAN_PORT });
    check('探测可达服务返回成功', probeOk.ok === true, JSON.stringify(probeOk));
    const probeBad = await api('/api/probe', { host: '127.0.0.1', port: 1 });
    check('探测不可达服务返回失败', probeBad.ok === false, probeBad.error || '');

    // ---------- 11. 测试连接接口 ----------
    const testOk = await api('/api/test', { server: { host: '127.0.0.1', port: SSH_PORT, username: 'root', password: 'pw' } });
    check('测试连接：正确信息通过', testOk.ok === true, testOk.info || '');
    const testBad = await api('/api/test', { server: { host: '127.0.0.1', port: 1, username: 'root', password: 'pw' } });
    check('测试连接：错误端口失败', testBad.ok === false, testBad.error || '');

    // ---------- 12. 重复连接不泄漏 ----------
    const again = await api('/api/connect', { server: { host: '127.0.0.1', port: SSH_PORT, username: 'root', password: 'pw', sudoPassword: 'pw' } });
    check('已在线时再次连接可正常完成', again.ok === true && again.state.status === 'online', again.error || '');
    await sleep(300);
    const after = await getText(`http://127.0.0.1:${PUB_PORT}/`);
    check('重复连接后映射依然可用', after.status === 200, 'status=' + after.status);

    // ---------- 13. 服务器资源采集（需在线，且要两次采样才有差值）----------
    await sleep(6500);
    const srvState = await api('/api/state', undefined, 'GET');
    const ss = srvState.serverStats;
    check('采集到服务器资源信息', !!ss);
    check('CPU 使用率已计算', !!ss && typeof ss.cpuPercent === 'number', ss ? ss.cpuPercent + '%' : '');
    check('内存使用率正确', !!ss && ss.mem && ss.mem.percent === 25, ss && ss.mem ? `${ss.mem.usedMB}/${ss.mem.totalMB} MB (${ss.mem.percent}%)` : '');
    check('磁盘使用率正确', !!ss && ss.disk && ss.disk.percent === 30, ss && ss.disk ? `${ss.disk.usedGB}/${ss.disk.totalGB} GB (${ss.disk.percent}%)` : '');
    check('负载与核数已采集', !!ss && !!ss.load && ss.cores === 2, ss ? `load=${ss.load.join('/')} cores=${ss.cores}` : '');
    check('网卡速率已计算', !!ss && !!ss.netRate, ss && ss.netRate ? `↓${ss.netRate.rx} ↑${ss.netRate.tx} B/s` : '');

    const trafficRule = srvState.rules.find((r) => r.remotePort === PUB_PORT);
    check('按映射统计流量', !!trafficRule && trafficRule.traffic.bytesIn + trafficRule.traffic.bytesOut > 0,
      trafficRule ? (trafficRule.traffic.bytesIn + trafficRule.traffic.bytesOut) + ' B' : '');
    check('按映射统计连接数', !!trafficRule && trafficRule.traffic.streams > 0,
      trafficRule ? String(trafficRule.traffic.streams) : '');

    // ---------- 13. 断线自动重连 ----------
    kill(mock);
    await sleep(500);
    const mockGone = await new Promise((res) => {
      const s = require('net').connect(SSH_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(false); });
      s.on('error', () => res(true));
    });
    check('模拟服务器已停止', mockGone);

    let wentDown = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try {
        const s = await api('/api/state', undefined, 'GET');
        if (process.env.VERBOSE) console.log(`    [debug ${i + 1}s] status=${s.status} text=${s.statusText}`);
        if (s.status === 'reconnecting' || s.status === 'idle' || s.status === 'error') { wentDown = s; break; }
      } catch (_) {}
    }
    check('服务器断开后进入重连状态', !!wentDown, wentDown ? wentDown.status : '15 秒内未检测到');

    startMock();
    const recovered = await waitFor(async () => {
      const s = await api('/api/state', undefined, 'GET');
      return s.status === 'online' ? s : null;
    }, 40000, 500);
    check('服务器恢复后自动重连成功', !!recovered, recovered ? '已恢复' : '超时未恢复');
    if (recovered) {
      await sleep(600);
      const afterReconnect = await getText(`http://127.0.0.1:${PUB_PORT}/`);
      check('重连后端口映射自动重建', afterReconnect.status === 200 && afterReconnect.body === 'LANSERVICE_OK',
        'status=' + afterReconnect.status);
    }

    // ---------- 14. 单实例保护 ----------
    const second = spawn(NODE, [path.join(ROOT, 'app', 'src', 'main.js'), '--no-window'], {
      env: Object.assign({}, process.env, { PORTKEY_DATA: TEST_DATA }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 12000);
      second.on('exit', () => { clearTimeout(t); resolve(true); });
    });
    try { second.kill('SIGKILL'); } catch (_) {}
    check('重复启动时第二个实例自动退出', exited);
    const stillAlive = await api('/api/state', undefined, 'GET');
    check('原实例未受影响', stillAlive.status === 'online', stillAlive.status);

    // ---------- 15. 配置持久化 ----------
    const beforeRules = stillAlive.rules.length;
    kill(app);
    await sleep(800);
    startApp();
    const reloaded = await waitFor(async () => {
      const r = await getText(base() + '/api/state');
      return r.status === 200 ? JSON.parse(r.body) : null;
    }, 20000);
    check('重启程序后配置仍在', !!reloaded && reloaded.server.host === '127.0.0.1', reloaded ? reloaded.server.host : '');
    check('重启程序后映射仍在', !!reloaded && reloaded.rules.length === beforeRules,
      reloaded ? `${reloaded.rules.length}/${beforeRules}` : '');
    check('重启后为未连接状态', !!reloaded && reloaded.status === 'idle', reloaded ? reloaded.status : '');

    // ---------- 17. 配置导出 / 导入 ----------
    const exp1 = await api('/api/export', { password: '' });
    check('导出配置（不含凭据）', exp1.ok === true && exp1.data.server.host === '127.0.0.1' && !exp1.data.credentials, '');
    check('导出包含映射规则', exp1.ok === true && exp1.data.rules.length > 0, String(exp1.data.rules.length));

    const exp2 = await api('/api/export', { password: 'Secret-Pass-123' });
    check('导出配置（含加密凭据）', exp2.ok === true && !!exp2.data.credentials);
    check('导出内容不含明文密码字段', exp2.data.server.password === undefined && exp2.data.server.sudoPassword === undefined);
    check('导出文件不含明文口令', !JSON.stringify(exp2.data).includes('Secret-Pass-123'));

    const badImport = await api('/api/import', { data: exp2.data, password: '错误口令' });
    check('错误口令导入被拒绝', badImport.ok === false, badImport.error || '');

    const goodImport = await api('/api/import', { data: exp2.data, password: 'Secret-Pass-123' });
    check('正确口令导入成功', goodImport.ok === true, goodImport.error || '');
    check('导入后映射数量一致', goodImport.rules === exp1.data.rules.length, `${goodImport.rules}/${exp1.data.rules.length}`);

    const afterImport = await api('/api/state', undefined, 'GET');
    check('导入后服务器信息正确', afterImport.server.host === '127.0.0.1' && afterImport.server.username === 'root');

    const badFile = await api('/api/import', { data: { foo: 'bar' }, password: '' });
    check('非法文件被拒绝', badFile.ok === false, badFile.error || '');
    const notJson = await api('/api/import', { data: 'hello', password: '' });
    check('非对象内容被拒绝', notJson.ok === false, notJson.error || '');

    // ---------- 18. 配置文件损坏恢复 ----------
    kill(app);
    await sleep(1200);
    fs.writeFileSync(path.join(TEST_DATA, 'config.json'), '{ 这不是合法的 JSON ');
    const app3 = startApp();
    await sleep(4000);
    check('配置损坏时程序不崩溃', app3.exitCode === null, app3.exitCode === null ? '' : '进程已退出');
    check('损坏配置已备份', fs.existsSync(path.join(TEST_DATA, 'config.json.broken')));
    check('已重建可用的配置文件', (() => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(TEST_DATA, 'config.json'), 'utf8'));
        return c && typeof c === 'object' && c.options;
      } catch (_) { return false; }
    })());

    lanServer.close();
  } catch (err) {
    check('测试执行', false, err.message);
  } finally {
    cleanup();
    await sleep(400);
    try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.info ? ' :: ' + f.info : '')));
    process.exit(1);
  }
  process.exit(0);
}

main();
