'use strict';

/** 诊断：服务器进程被强杀后，SSH 客户端多久才能感知断开 */

const path = require('path');
const Module = require('module');
process.env.NODE_PATH = path.resolve(__dirname, '..', 'app', 'node_modules');
Module._initPaths();

const { spawn } = require('child_process');
const { Client } = require('ssh2');

const PORT = 2242;
const t0 = Date.now();
const log = (msg) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${msg}`);

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-sshd.js'), String(PORT)], { stdio: 'ignore' });
mock.on('exit', (code, sig) => log(`mock 进程退出 code=${code} signal=${sig}`));

setTimeout(() => {
  const c = new Client();
  c.on('ready', () => {
    log('SSH 已连接');
    setTimeout(() => {
      log('>>> 强杀 mock 进程');
      mock.kill('SIGKILL');
    }, 1500);
  });
  c.on('error', (e) => log('error 事件: ' + e.message));
  c.on('end', () => log('end 事件'));
  c.on('close', () => log('close 事件 ← 客户端感知断开'));
  c.on('handshake', () => log('handshake'));
  c.connect({
    host: '127.0.0.1', port: PORT, username: 'x', password: 'y',
    keepaliveInterval: 20000, keepaliveCountMax: 3,
  });
}, 1200);

setTimeout(() => { log('诊断结束（25 秒上限）'); process.exit(0); }, 25000);
