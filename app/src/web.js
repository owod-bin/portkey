'use strict';

/**
 * 本地 HTTP 服务：为客户端界面提供 API 与静态资源
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2e6) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) return json(res, 403, { error: 'forbidden' });
  const file = path.join(PUBLIC_DIR, rel);
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function localIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function startWeb(tunnel, config, log, port) {
  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (!urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);

    try {
      if (urlPath === '/api/state' && req.method === 'GET') {
        return json(res, 200, Object.assign({
          localIPs: localIPs(),
          version: require('../package.json').version,
          pid: process.pid,
        }, tunnel.state()));
      }

      if (urlPath === '/api/logs' && req.method === 'GET') {
        const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
        return json(res, 200, { logs: log.since(since), seq: log.seq });
      }

      if (urlPath === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.server) {
          const patch = {};
          for (const k of ['host', 'port', 'username', 'privateKeyPath', 'remember']) {
            if (body.server[k] !== undefined) patch[k] = body.server[k];
          }
          if (body.server.password !== undefined && body.server.password !== '') patch.password = body.server.password;
          if (body.server.sudoPassword !== undefined && body.server.sudoPassword !== '') patch.sudoPassword = body.server.sudoPassword;
          config.updateServer(patch);
        }
        if (body.options) config.updateOptions(body.options);
        log.info('配置已保存');
        return json(res, 200, { ok: true, state: tunnel.state() });
      }

      if (urlPath === '/api/export' && req.method === 'POST') {
        const body = await readBody(req);
        const data = config.exportData(body.password || '');
        log.info('已导出配置', data.credentials ? '包含加密凭据' : '不含凭据');
        return json(res, 200, { ok: true, data });
      }

      if (urlPath === '/api/import' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const r = config.importData(body.data, body.password || '');
          log.ok('配置导入成功', `服务器 ${r.host || '（未设置）'}，${r.rules} 条映射`);
          return json(res, 200, { ok: true, host: r.host, rules: r.rules, state: tunnel.state() });
        } catch (err) {
          log.warn('配置导入失败：' + err.message);
          return json(res, 200, { ok: false, error: err.message });
        }
      }

      if (urlPath === '/api/test' && req.method === 'POST') {
        const body = await readBody(req);
        const saved = config.server();
        const srv = Object.assign({}, saved, body.server || {});
        if (!srv.password && !srv.privateKeyPath) srv.password = saved.password;
        if (!srv.host) return json(res, 200, { ok: false, error: '请先填写服务器地址' });
        if (!srv.password && !srv.privateKeyPath) return json(res, 200, { ok: false, error: '请填写登录密码或指定私钥文件' });

        const { SshSession } = require('./ssh');
        const session = new SshSession(log);
        try {
          log.step('测试连接', `${srv.username}@${srv.host}:${srv.port}`);
          await session.connect(srv);
          const r = await session.exec('echo PORTKEY_OK; uname -s -m', { timeout: 12000 });
          session.close();
          const info = (r.stdout || '').replace(/PORTKEY_OK/, '').trim();
          log.ok('测试连接成功', info);
          return json(res, 200, { ok: true, info: info || '已登录' });
        } catch (err) {
          session.close();
          log.warn('测试连接失败：' + err.message);
          return json(res, 200, { ok: false, error: err.message });
        }
      }

      if (urlPath === '/api/connect' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          if (body.server) {
            const patch = {};
            for (const k of ['host', 'port', 'username', 'privateKeyPath']) {
              if (body.server[k] !== undefined) patch[k] = body.server[k];
            }
            if (body.server.password) patch.password = body.server.password;
            if (body.server.sudoPassword) patch.sudoPassword = body.server.sudoPassword;
            config.updateServer(patch);
          }
          await tunnel.connect();
          return json(res, 200, { ok: true, state: tunnel.state() });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message, state: tunnel.state() });
        }
      }

      if (urlPath === '/api/disconnect' && req.method === 'POST') {
        await tunnel.disconnect();
        return json(res, 200, { ok: true, state: tunnel.state() });
      }

      if (urlPath === '/api/restart' && req.method === 'POST') {
        try {
          await tunnel.restart();
          return json(res, 200, { ok: true, state: tunnel.state() });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message, state: tunnel.state() });
        }
      }

      if (urlPath === '/api/provision' && req.method === 'POST') {
        try {
          if (!tunnel.ssh || !tunnel.ssh.connected) throw new Error('请先连接服务器');
          const srv = config.server();
          const { provision } = require('./provision');
          const report = await provision(tunnel.ssh, log, {
            ports: tunnel.rules.filter((r) => r.enabled).map((r) => r.remotePort),
            sudoPassword: srv.sudoPassword || srv.password,
          });
          tunnel.progress = report.steps;
          return json(res, 200, { ok: report.ok, steps: report.steps });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message });
        }
      }

      if (urlPath === '/api/rules' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const rule = await tunnel.addRule(body);
          return json(res, 200, { ok: true, rule, state: tunnel.state() });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message });
        }
      }

      if (urlPath.startsWith('/api/rules/') && req.method === 'PATCH') {
        const id = decodeURIComponent(urlPath.slice('/api/rules/'.length));
        try {
          const body = await readBody(req);
          let result;
          if (body.enabled !== undefined) result = await tunnel.toggleRule(id, !!body.enabled);
          else result = await tunnel.updateRule(id, body);
          return json(res, 200, { ok: true, ...result, state: tunnel.state() });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message });
        }
      }

      if (urlPath.startsWith('/api/rules/') && req.method === 'DELETE') {
        const id = decodeURIComponent(urlPath.slice('/api/rules/'.length));
        try {
          const result = await tunnel.removeRule(id);
          return json(res, 200, { ok: true, ...result, state: tunnel.state() });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message });
        }
      }

      if (urlPath === '/api/probe' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await require('./tunnel').TunnelManager.probe(body.host || '127.0.0.1', Number(body.port), 3000);
        return json(res, 200, r);
      }

      if (urlPath === '/api/quit' && req.method === 'POST') {
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('接口错误：' + err.message);
      return json(res, 200, { ok: false, error: err.message });
    }
  });

  return new Promise(async (resolve, reject) => {
    const base = Number(port) || 7788;
    for (let p = base; p < base + 20; p++) {
      const free = await probePort(p);
      if (!free) {
        log.warn(`端口 ${p} 已被占用，尝试下一个`);
        continue;
      }
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', (err) => log.error('本地服务异常：' + err.message));
        resolve({ server, port: p });
      });
      return;
    }
    reject(new Error(`从 ${base} 开始的 20 个端口都被占用，请修改配置中的 webPort`));
  });
}

/** 检测端口是否可用 */
function probePort(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });
}

module.exports = { startWeb, localIPs };
