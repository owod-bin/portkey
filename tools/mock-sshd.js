'use strict';

/**
 * 测试用：模拟一台 Linux 公网服务器（SSH 服务）
 * 支持密码登录、命令执行、以及真实的远程端口转发（tcpip-forward）
 * 仅用于本地端到端测试，不参与正式运行。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 依赖装在 app/node_modules，这里显式指向，便于单独运行
const Module = require('module');
process.env.NODE_PATH = path.resolve(__dirname, '..', 'app', 'node_modules');
Module._initPaths();

const { Server } = require('ssh2');

const PORT = Number(process.argv[2] || 2222);
const KEY_FILE = path.join(__dirname, 'mock-hostkey.pem');

function hostKey() {
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE);
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fs.writeFileSync(KEY_FILE, privateKey);
  return privateKey;
}

let tick = 0;

function mockExec(cmd) {
  const c = String(cmd);
  // 服务器资源采集（模拟 /proc 数据，数值随采样次数递增，便于校验速率与使用率）
  if (/\/proc\/loadavg/.test(c)) {
    tick++;
    const busy = 1000 + tick * 100;
    const total = 4000 + tick * 400;
    return {
      out: [
        'LOAD 0.15 0.10 0.05',
        'MEM 2048000 512000',
        'DISK 40960 12288',
        `NET ${1048576 + tick * 1024} ${524288 + tick * 512}`,
        `CPU ${busy} ${total}`,
        'UP 86400',
        'CORES 2',
      ].join('\n') + '\n',
    };
  }
  if (/id -u/.test(c)) return { out: '0\nroot\n' };
  if (/cat \/etc\/os-release/.test(c)) return { out: 'PRETTY_NAME="Ubuntu 22.04 LTS（模拟服务器）"\n' };
  if (/sshd -T/.test(c) && /grep/.test(c)) return { out: 'gatewayports no\nallowtcpforwarding yes\n' };
  if (/sshd -t/.test(c)) return { out: '' };
  if (/FW_DONE/.test(c)) {
    const m = /for p in ([\d ]+)/.exec(c);
    const ports = m ? m[1].trim().split(/\s+/) : [];
    return { out: ports.map((p) => `ufw:${p}`).join('\n') + '\nFW_DONE\n' };
  }
  if (/echo WROTE/.test(c)) return { out: 'WROTE\n' };
  if (/systemctl reload|service ssh/.test(c)) return { out: '' };
  if (/PORTKEY_OK/.test(c)) return { out: 'PORTKEY_OK\nLinux x86_64\n' };
  if (/echo ping/.test(c)) return { out: 'ping\n' };
  return { out: '' };
}

const listeners = new Map();

const server = new Server({ hostKeys: [hostKey()] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password') ctx.accept();
    else ctx.accept();
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        const r = mockExec(info && info.command ? info.command : '');
        const stream = accept();
        if (r.out) stream.write(r.out);
        stream.exit(0);
        stream.end();
      });
    });

    client.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') {
        const port = info.bindPort;
        if (listeners.has(port)) return reject();
        const srv = net.createServer((sock) => {
          client.forwardOut(info.bindAddr, port, sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, (err, stream) => {
            if (err) { sock.destroy(); return; }
            sock.pipe(stream);
            stream.pipe(sock);
          });
        });
        srv.on('error', () => {});
        srv.listen(port, info.bindAddr === '0.0.0.0' ? undefined : info.bindAddr, () => {
          listeners.set(port, srv);
          console.log(`[mock] 已监听转发端口 ${port}`);
          accept(port);
        });
        return;
      }
      if (name === 'cancel-tcpip-forward') {
        const srv = listeners.get(info.bindPort);
        if (srv) { srv.close(); listeners.delete(info.bindPort); }
        return accept();
      }
      accept();
    });
  });

  client.on('end', () => {
    for (const [, srv] of listeners) srv.close();
    listeners.clear();
  });
  client.on('close', () => {
    for (const [, srv] of listeners) srv.close();
    listeners.clear();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-sshd] 监听 127.0.0.1:${PORT}`);
});
