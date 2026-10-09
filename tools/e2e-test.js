'use strict';

/**
 * 端到端测试：
 *   模拟服务器(mock-sshd) + 模拟内网服务 + 真实启动客户端程序
 *   验证「一键连接 → 自动配置 → 添加映射 → 公网端口可访问内网服务」
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TEST_DATA = path.join(__dirname, '.testdata');
const SSH_PORT = 2222;
const LAN_PORT = 18099;
const PUB_PORT = 18100;
const WEB_PORT = 7799;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, info) {
  results.push({ name, ok: !!ok, info: info || '' });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${info ? '  → ' + info : ''}`);
}

function get(url, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function waitFor(fn, timeout = 20000, interval = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const r = await fn(); if (r) return r; } catch (_) {}
    await sleep(interval);
  }
  return null;
}

async function main() {
  console.log('\n=== 互联网穿透 客户端 端到端测试 ===\n');
  const children = [];

  // 准备干净的测试数据目录
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA, { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA, 'config.json'), JSON.stringify({
    server: { host: '', port: 22, username: 'root', password: '', privateKeyPath: '', sudoPassword: '', remember: true },
    rules: [],
    options: { autoConnect: false, autoReconnect: false, webPort: WEB_PORT, launchWindow: false },
    provisionedHosts: {},
  }, null, 2));

  const spawnNode = (file, args, env) => {
    const child = spawn(NODE, [file].concat(args || []), {
      env: Object.assign({}, process.env, env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('  | ' + d.toString()));
    child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('  ! ' + d.toString()));
    children.push(child);
    return child;
  };

  const cleanup = () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
  };

  try {
    // 1. 模拟公网服务器
    spawnNode(path.join(__dirname, 'mock-sshd.js'), [String(SSH_PORT)]);
    const sshOk = await waitFor(() => new Promise((res) => {
      const s = require('net').connect(SSH_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    }), 8000);
    check('模拟服务器 SSH 就绪', sshOk, `127.0.0.1:${SSH_PORT}`);

    // 2. 模拟内网服务（局域网里要暴露的服务）
    const lanServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('LANSERVICE_OK');
    });
    await new Promise((r) => lanServer.listen(LAN_PORT, '127.0.0.1', r));
    check('模拟内网服务启动', true, `127.0.0.1:${LAN_PORT}`);

    // 3. 启动客户端程序
    const app = spawnNode(path.join(ROOT, 'app', 'src', 'main.js'), ['--no-window'], { PORTKEY_DATA: TEST_DATA });
    const ready = await waitFor(async () => {
      const r = await get(`http://127.0.0.1:${WEB_PORT}/api/state`);
      return r.status === 200 ? r : null;
    }, 20000);
    check('客户端程序启动（本地服务可用）', !!ready, `http://127.0.0.1:${WEB_PORT}`);
    if (!ready) throw new Error('客户端未能启动');

    const base = `http://127.0.0.1:${WEB_PORT}`;
    let st = JSON.parse(ready.body);
    check('初始状态为未连接', st.status === 'idle', 'status=' + st.status);

    // 4. 一键连接（自动配置服务器）
    const conn = await post(base + '/api/connect', {
      server: { host: '127.0.0.1', port: SSH_PORT, username: 'root', password: 'test123', sudoPassword: 'test123' },
    });
    check('一键连接成功', conn.ok === true, conn.error || '');
    check('连接后状态为 online', conn.state && conn.state.status === 'online', conn.state ? conn.state.status : '');
    check('自动配置服务器已执行', !!(conn.state && conn.state.progress && conn.state.progress.length),
      conn.state && conn.state.progress ? conn.state.progress.length + ' 个步骤' : '');
    const osStep = (conn.state.progress || []).find((s) => s.key === 'os');
    check('识别到服务器系统', !!(osStep && osStep.status === 'ok'), osStep ? osStep.detail : '');
    const gwStep = (conn.state.progress || []).find((s) => s.key === 'write');
    check('已开启 GatewayPorts 配置', !!(gwStep && (gwStep.status === 'ok' || gwStep.status === 'skip')), gwStep ? gwStep.detail : '');

    // 5. 添加端口映射
    const add = await post(base + '/api/rules', {
      localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT, name: '测试服务',
    });
    check('添加端口映射', add.ok === true, add.error || '');
    check('映射标记为已开放', !!(add.state && add.state.rules.some((r) => r.live)), '');

    // 6. 关键验证：通过"公网端口"访问到内网服务
    await sleep(500);
    const pub = await get(`http://127.0.0.1:${PUB_PORT}/`);
    check('公网端口可访问内网服务', pub.status === 200 && pub.body === 'LANSERVICE_OK',
      `status=${pub.status} body=${JSON.stringify((pub.body || '').slice(0, 40))}`);

    // 7. 内网连通性探测接口
    const probe = await post(base + '/api/probe', { host: '127.0.0.1', port: LAN_PORT });
    check('内网探测接口正常', probe.ok === true, JSON.stringify(probe));

    // 8. 多端口并发
    const add2 = await post(base + '/api/rules', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT + 1 });
    check('添加第二个映射', add2.ok === true, add2.error || '');
    await sleep(400);
    const pub2 = await get(`http://127.0.0.1:${PUB_PORT + 1}/`);
    check('第二个端口同样可用', pub2.status === 200 && pub2.body === 'LANSERVICE_OK', 'status=' + pub2.status);

    // 9. 重复端口应被拒绝
    const dup = await post(base + '/api/rules', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: PUB_PORT });
    check('重复公网端口被拒绝', dup.ok === false, dup.error || '');

    // 10. 非法端口应被拒绝
    const bad = await post(base + '/api/rules', { localHost: '127.0.0.1', localPort: LAN_PORT, remotePort: 99999 });
    check('非法端口被拒绝', bad.ok === false, bad.error || '');

    // 11. 停用映射
    const ruleId = add.state.rules.find((r) => r.remotePort === PUB_PORT).id;
    const off = await fetch(base + '/api/rules/' + ruleId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json());
    check('停用映射成功', off.ok === true, '');

    // 12. 断开连接
    const disc = await post(base + '/api/disconnect', {});
    check('断开连接', disc.ok === true && disc.state.status === 'idle', disc.state.status);

    // 13. 配置文件已加密保存
    const raw = fs.readFileSync(path.join(TEST_DATA, 'config.json'), 'utf8');
    check('密码加密存储（非明文）', !raw.includes('test123'), '');
    const saved = JSON.parse(raw);
    check('服务器信息已保存', saved.server.host === '127.0.0.1' && saved.server.port === SSH_PORT, '');
    check('映射规则已持久化', saved.rules.length === 2, saved.rules.length + ' 条');

    lanServer.close();
  } catch (err) {
    check('测试执行', false, err.message);
  } finally {
    cleanup();
    await sleep(300);
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
