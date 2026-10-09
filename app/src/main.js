#!/usr/bin/env node
'use strict';

/**
 * 互联网穿透 —— 客户端启动入口
 * 启动本地服务，并自动拉起独立窗口的客户端界面（无需安装，绿色运行）
 */

const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const { Config, DATA_DIR } = require('./config');
const { Logger } = require('./logger');
const { TunnelManager } = require('./tunnel');
const { startWeb } = require('./web');

const log = new Logger(1000);
const config = new Config();
const tunnel = new TunnelManager(config, log);

const BROWSERS = [
  { name: 'Edge', paths: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'] },
  { name: 'Chrome', paths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'] },
];

function findBrowser() {
  for (const b of BROWSERS) {
    for (const p of b.paths) {
      if (fs.existsSync(p)) return { name: b.name, exe: p };
    }
  }
  return null;
}

function openInDefaultBrowser(url) {
  exec(`start "" "${url}"`, (err) => {
    if (err) log.warn(`无法自动打开界面，请手动访问 ${url}`);
    else log.ok('已在默认浏览器中打开界面');
  });
}

function openClientWindow(url) {
  const browser = findBrowser();
  const profileDir = path.join(DATA_DIR, 'client-profile');
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  if (browser) {
    const args = [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1180,820',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
    ];
    try {
      const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        log.warn(`独立窗口启动失败（${err.message}），改用默认浏览器`);
        openInDefaultBrowser(url);
      });
      child.unref();
      log.ok(`已启动客户端窗口（${browser.name}）`);
      return { ok: true, browser: browser.name };
    } catch (err) {
      log.warn('窗口启动失败：' + err.message);
    }
  }
  openInDefaultBrowser(url);
  return { ok: false, browser: '默认浏览器' };
}

const PID_FILE = path.join(DATA_DIR, 'app.pid');

/** 读取 PID 文件并确认进程仍在运行 */
function runningInstancePid() {
  try {
    if (!fs.existsSync(PID_FILE)) return 0;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid || pid === process.pid) return 0;
    process.kill(pid, 0); // 只探测存在性，不发送信号
    return pid;
  } catch (_) {
    return 0;
  }
}

/** 在端口区间内找到已在运行的实例 */
async function findRunningPort(base) {
  for (let p = base; p < base + 20; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/state`, { signal: AbortSignal.timeout(700) });
      if (res.ok) {
        const body = await res.json();
        if (body && typeof body.status === 'string') return p;
      }
    } catch (_) {}
  }
  return 0;
}

async function main() {
  const opts = config.options();
  const noWindow = process.argv.includes('--no-window') || process.env.PORTKEY_NO_WINDOW === '1';
  const basePort = Number(opts.webPort) || 7788;
  log.info('Portkey 客户端启动中…');

  // 单实例：已经运行时不再重复启动，只把窗口拉出来
  const existing = runningInstancePid();
  if (existing) {
    const running = await findRunningPort(basePort);
    if (running) {
      log.warn(`程序已在运行（PID ${existing}），直接打开已有界面`);
      if (!noWindow) openClientWindow(`http://127.0.0.1:${running}`);
      else log.info(`已有实例界面地址：http://127.0.0.1:${running}`);
      process.exit(0);
    }
    log.warn(`发现残留的进程记录（PID ${existing}），将重新启动`);
  }

  // 记录进程号，供 停止.bat 精确结束进程
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (_) {}
  const clearPid = () => {
    try {
      const cur = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (cur === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch (_) {}
  };
  process.on('exit', clearPid);

  const { port } = await startWeb(tunnel, config, log, basePort);
  const url = `http://127.0.0.1:${port}`;
  log.ok(`本地服务已就绪：${url}`);

  if (opts.launchWindow !== false && !noWindow) {
    setTimeout(() => openClientWindow(url), 300);
  }

  // 自动连接
  if (opts.autoConnect && config.server().host) {
    log.info('配置为启动时自动连接，正在连接…');
    tunnel.connect().catch((err) => log.error('自动连接失败：' + err.message));
  }

  const shutdown = async () => {
    log.info('正在退出…');
    try { await tunnel.disconnect(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
