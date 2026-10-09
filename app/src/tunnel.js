'use strict';

/**
 * 隧道管理器：SSH 连接 + 自动配置 + 端口转发 + 断线重连
 */

const net = require('net');
const { EventEmitter } = require('events');
const { SshSession } = require('./ssh');
const { provision } = require('./provision');

/** 单客户端最大并发转发连接数 */
const MAX_STREAMS = 500;

/** 常见 Web 端口，用于自动判断映射协议 */
const HTTP_PORTS = new Set([80, 8000, 8080, 8081, 8888, 3000, 3001, 5000, 5173, 9000, 9090, 10080]);
const HTTPS_PORTS = new Set([443, 8443, 9443, 10443]);

function inferProtocol(localPort, explicit) {
  if (explicit && explicit !== 'auto') return explicit;
  const p = Number(localPort);
  if (HTTPS_PORTS.has(p)) return 'https';
  if (HTTP_PORTS.has(p)) return 'http';
  return 'tcp';
}

class TunnelManager extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log;
    this.ssh = null;
    this.status = 'idle';       // idle | connecting | configuring | online | error | reconnecting
    this.statusText = '未连接';
    this.lastError = '';
    this.manualStop = false;
    this.retryDelay = 3000;
    this.retryTimer = null;
    this.progress = [];         // 最近一次配置步骤
    this.serverOs = '';
    this.pendingRelease = false; // 有停用/删除的端口尚未释放
    this.stats = {
      startedAt: null,
      activeStreams: 0,
      totalStreams: 0,
      bytesIn: 0,
      bytesOut: 0,
      reconnects: 0,
      forwardedPorts: [],
      perRule: {},          // ruleId -> { bytesIn, bytesOut, streams, active }
    };
    this.connections = new Set();
    this.serverStats = null; // 服务器资源采集结果
    this._cpuPrev = null;
    this._netPrev = null;
  }

  perRuleStat(id) {
    if (!this.stats.perRule[id]) {
      this.stats.perRule[id] = { bytesIn: 0, bytesOut: 0, streams: 0, active: 0 };
    }
    return this.stats.perRule[id];
  }

  get rules() { return this.config.rules(); }

  setStatus(status, text) {
    this.status = status;
    this.statusText = text || '';
    this.emit('change');
  }

  // ---------------- 连接 ----------------

  async connect(opts = {}) {
    if (this.status === 'connecting' || this.status === 'configuring') {
      throw new Error('正在连接中，请稍候');
    }
    // 已在线时先释放旧连接，避免 SSH 会话泄漏
    if (this.ssh) {
      await this.disconnect();
    }
    this.manualStop = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    const srv = this.config.server();
    if (!srv.host) throw new Error('请先填写服务器地址');
    if (!srv.username) throw new Error('请填写登录用户名');
    if (!srv.password && !srv.privateKeyPath) throw new Error('请填写登录密码，或指定私钥文件');

    this.setStatus('connecting', `正在连接 ${srv.host}…`);
    this.log.step('开始连接', `${srv.username}@${srv.host}:${srv.port}`);

    const ssh = new SshSession(this.log);
    ssh.on('tcp connection', (details, accept, reject) => this.onTcpConnection(details, accept, reject));
    ssh.on('closed', () => this.onClosed());
    ssh.on('connError', (err) => this.log.warn('SSH 连接异常：' + err.message));

    try {
      await ssh.connect(srv);
    } catch (err) {
      this.lastError = err.message;
      this.setStatus('error', err.message);
      this.log.error('连接失败：' + err.message);
      throw err;
    }

    this.ssh = ssh;
    this.stats.startedAt = Date.now();

    // 自动配置服务器
    this.setStatus('configuring', '正在配置服务器…');
    try {
      const ports = this.rules.filter((r) => r.enabled).map((r) => r.remotePort);
      const report = await provision(ssh, this.log, {
        ports,
        sudoPassword: srv.sudoPassword || srv.password,
      });
      this.progress = report.steps;
      this.serverOs = report.os;
      if (report.ok) {
        this.config.markProvisioned(srv.host, report.os);
      }
    } catch (err) {
      this.log.warn('服务器配置未完全成功：' + err.message);
      this.progress = [{ key: 'provision', title: '配置服务器', status: 'warn', detail: err.message }];
    }

    this.setStatus('online', '已连接');
    this.retryDelay = 3000;
    this.pendingRelease = false; // 新连接下所有端口都是干净的

    const applied = await this.applyRules();
    this.log.ok('隧道就绪', applied.length ? `已开放端口：${applied.join('、')}` : '尚未添加端口映射');

    // 保活：每 25 秒发一个无害命令，避免被中间设备掐断
    this.keepaliveTimer = setInterval(() => this.keepalive(), 25000);

    // 服务器资源采集
    clearInterval(this.statsTimer);
    this.collectServerStats().catch(() => {});
    this.statsTimer = setInterval(() => this.collectServerStats().catch(() => {}), 5000);

    return { ok: true };
  }

  async keepalive() {
    if (!this.ssh || !this.ssh.connected) return;
    try {
      await this.ssh.exec('echo ping');
    } catch (_) {}
  }

  /** 通过 SSH 采集服务器负载 / 内存 / 磁盘 / 网络（一条命令搞定） */
  async collectServerStats() {
    if (!this.ssh || !this.ssh.connected) return null;
    const cmd = [
      `echo "LOAD $(cut -d' ' -f1-3 /proc/loadavg)"`,
      `echo "MEM $(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t, t-a}' /proc/meminfo)"`,
      `echo "DISK $(df -m / 2>/dev/null | awk 'NR==2{print $2, $3}')"`,
      `echo "NET $(awk -F'[: ]+' 'NR>2{rx+=$2; tx+=$10} END{print rx+0, tx+0}' /proc/net/dev)"`,
      `echo "CPU $(awk '/^cpu /{b=$2+$3+$4+$7+$8+$9; print b, b+$5+$6}' /proc/stat)"`,
      `echo "UP $(cut -d. -f1 /proc/uptime)"`,
      `echo "CORES $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"`,
    ].join('; ');

    let out = '';
    try {
      const r = await this.ssh.exec(cmd, { timeout: 8000 });
      out = r.stdout || '';
    } catch (err) {
      this.log.debug('服务器信息采集失败：' + err.message);
      return null;
    }
    if (!out.trim()) return null;

    const pick = (k) => {
      const m = new RegExp('^' + k + ' (.*)$', 'm').exec(out);
      return m ? m[1].trim() : '';
    };
    const nums = (s) => String(s).split(/\s+/).map(Number).filter((n) => Number.isFinite(n));

    const now = Date.now();
    const load = nums(pick('LOAD'));
    const mem = nums(pick('MEM'));
    const disk = nums(pick('DISK'));
    const net = nums(pick('NET'));
    const cpu = nums(pick('CPU'));
    const uptime = Number(pick('UP')) || 0;
    const cores = Number(pick('CORES')) || 1;

    // CPU 使用率需要两次采样求差值
    let cpuPercent = null;
    if (cpu.length === 2) {
      const prev = this._cpuPrev;
      if (prev) {
        const dBusy = cpu[0] - prev[0];
        const dTotal = cpu[1] - prev[1];
        if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, Math.round((dBusy / dTotal) * 100)));
      }
      this._cpuPrev = cpu;
    }

    // 网卡速率同样用差值
    let netRate = null;
    if (net.length === 2 && this._netPrev) {
      const dt = (now - this._netPrev.t) / 1000;
      if (dt > 0.5) {
        netRate = {
          rx: Math.max(0, Math.round((net[0] - this._netPrev.rx) / dt)),
          tx: Math.max(0, Math.round((net[1] - this._netPrev.tx) / dt)),
        };
      }
    }
    if (net.length === 2) this._netPrev = { rx: net[0], tx: net[1], t: now };

    this.serverStats = {
      at: now,
      load: load.length === 3 ? load : null,
      cores,
      uptime,
      cpuPercent,
      mem: mem.length === 2 && mem[0] > 0
        ? { totalMB: Math.round(mem[0] / 1024), usedMB: Math.round(mem[1] / 1024), percent: Math.round((mem[1] / mem[0]) * 100) }
        : null,
      disk: disk.length === 2 && disk[0] > 0
        ? { totalGB: +(disk[0] / 1024).toFixed(1), usedGB: +(disk[1] / 1024).toFixed(1), percent: Math.round((disk[1] / disk[0]) * 100) }
        : null,
      netRate,
      netTotal: net.length === 2 ? { rx: net[0], tx: net[1] } : null,
    };
    return this.serverStats;
  }

  onClosed() {
    clearInterval(this.keepaliveTimer);
    clearInterval(this.statsTimer);
    this.serverStats = null;
    this._cpuPrev = null;
    this._netPrev = null;
    this.connections.clear();
    this.stats.activeStreams = 0;
    this.stats.forwardedPorts = [];
    if (this.manualStop) {
      this.setStatus('idle', '已断开');
      return;
    }
    if (!this.config.options().autoReconnect) {
      this.setStatus('idle', '连接已断开');
      return;
    }
    this.setStatus('reconnecting', `${Math.round(this.retryDelay / 1000)} 秒后重连…`);
    this.log.warn(`连接断开，${Math.round(this.retryDelay / 1000)} 秒后自动重连`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      this.stats.reconnects++;
      this.retryDelay = Math.min(this.retryDelay * 2, 60000);
      try {
        await this.connect();
      } catch (_) {}
    }, this.retryDelay);
  }

  async disconnect() {
    this.manualStop = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.keepaliveTimer);
    clearInterval(this.statsTimer);
    this.serverStats = null;
    this._cpuPrev = null;
    this._netPrev = null;
    if (this.ssh) {
      this.ssh.removeAllListeners('closed');
      this.ssh.close();
      this.ssh = null;
    }
    this.stats.startedAt = null;
    this.stats.forwardedPorts = [];
    this.pendingRelease = false;
    this.setStatus('idle', '已断开');
    this.log.info('已断开连接');
  }

  /** 重连以释放/重建端口（ssh2 无法单独取消某个转发端口） */
  async restart() {
    this.log.info('正在重启隧道以重建端口…');
    await this.disconnect();
    await new Promise((r) => setTimeout(r, 500));
    await this.connect();
  }

  // ---------------- 端口映射 ----------------

  async applyRules() {
    if (!this.ssh || !this.ssh.connected) return [];
    const applied = [];
    const failed = [];
    for (const rule of this.rules.filter((r) => r.enabled)) {
      try {
        await this.ssh.forwardIn('0.0.0.0', rule.remotePort);
        applied.push(rule.remotePort);
        this.log.ok(`已开放公网端口 ${rule.remotePort}`, `→ ${rule.localHost}:${rule.localPort}`);
      } catch (err) {
        failed.push(`${rule.remotePort}: ${err.message}`);
        this.log.error(`端口 ${rule.remotePort} 开放失败：${err.message}`);
      }
    }
    this.stats.forwardedPorts = applied;
    if (failed.length) this.lastError = failed.join('；');
    return applied;
  }

  async addRule(input) {
    const localHost = String(input.localHost || '127.0.0.1').trim();
    const localPort = Number(input.localPort);
    const remotePort = Number(input.remotePort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('内网端口无效');
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('公网端口无效');
    if (this.rules.some((r) => r.remotePort === remotePort)) throw new Error(`公网端口 ${remotePort} 已被占用`);

    const rule = this.config.addRule({
      name: input.name || '',
      localHost, localPort, remotePort,
      protocol: input.protocol || 'auto',
      enabled: true,
    });
    this.log.info(`新增映射：公网 ${remotePort} → ${localHost}:${localPort}`);

    if (this.ssh && this.ssh.connected) {
      try {
        await this.ssh.forwardIn('0.0.0.0', remotePort);
        this.stats.forwardedPorts = Array.from(new Set(this.stats.forwardedPorts.concat([remotePort])));
        this.log.ok(`公网端口 ${remotePort} 已开放`);
      } catch (err) {
        this.log.error(`端口 ${remotePort} 开放失败：${err.message}`);
        throw new Error(err.message);
      }
      // 防火墙放行新端口
      try {
        await this.openFirewallFor([remotePort]);
      } catch (_) {}
    }
    this.emit('change');
    return rule;
  }

  async openFirewallFor(ports) {
    if (!this.ssh || !ports.length) return;
    const list = ports.join(' ');
    const script = `for p in ${list}; do ` +
      `(command -v ufw >/dev/null 2>&1 && ufw allow $p/tcp >/dev/null 2>&1 && echo "ufw:$p") ; ` +
      `(command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --add-port=$p/tcp --permanent >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && echo "firewalld:$p") ; ` +
      `(command -v iptables >/dev/null 2>&1 && (iptables -C INPUT -p tcp --dport $p -j ACCEPT >/dev/null 2>&1 || iptables -I INPUT -p tcp --dport $p -j ACCEPT >/dev/null 2>&1) && echo "iptables:$p") ; ` +
      `done; echo FW_DONE`;
    const srv = this.config.server();
    await this.ssh.exec(script, { sudo: true, sudoPassword: srv.sudoPassword || srv.password });
  }

  async updateRule(id, patch) {
    const rule = this.config.updateRule(id, patch);
    if (!rule) throw new Error('规则不存在');
    this.emit('change');
    return rule;
  }

  async removeRule(id) {
    const rule = this.rules.find((r) => r.id === id);
    const wasLive = !!(rule && this.stats.forwardedPorts.includes(rule.remotePort));
    const ok = this.config.removeRule(id);
    if (!ok) throw new Error('规则不存在');
    if (wasLive) {
      this.stats.forwardedPorts = this.stats.forwardedPorts.filter((p) => p !== rule.remotePort);
      this.pendingRelease = true;
      this.log.info(`已删除映射，端口 ${rule.remotePort} 将在重启隧道后释放`);
    }
    this.emit('change');
    return { needRestart: wasLive };
  }

  async toggleRule(id, enabled) {
    const rule = this.config.updateRule(id, { enabled });
    if (!rule) throw new Error('规则不存在');

    if (!enabled) {
      const wasLive = this.stats.forwardedPorts.includes(rule.remotePort);
      if (wasLive) {
        this.stats.forwardedPorts = this.stats.forwardedPorts.filter((p) => p !== rule.remotePort);
        this.pendingRelease = true;
        this.log.info(`已停用映射，端口 ${rule.remotePort} 将在重启隧道后释放`);
      }
      this.emit('change');
      return { rule, needRestart: wasLive };
    }

    if (this.ssh && this.ssh.connected) {
      try {
        await this.ssh.forwardIn('0.0.0.0', rule.remotePort);
        this.stats.forwardedPorts = Array.from(new Set(this.stats.forwardedPorts.concat([rule.remotePort])));
        this.log.ok(`公网端口 ${rule.remotePort} 已开放`);
        try { await this.openFirewallFor([rule.remotePort]); } catch (_) {}
      } catch (err) {
        this.log.error(`端口 ${rule.remotePort} 开放失败：${err.message}`);
        throw new Error(err.message);
      }
    }
    this.emit('change');
    return { rule, needRestart: false };
  }

  // ---------------- 数据转发 ----------------

  onTcpConnection(details, accept, reject) {
    const port = details.destPort;
    const rule = this.rules.find((r) => r.enabled && r.remotePort === port);
    if (!rule) {
      this.log.warn(`端口 ${port} 收到连接，但没有匹配的映射规则`);
      return reject();
    }
    // 并发上限，避免异常情况下连接无限堆积
    if (this.connections.size >= MAX_STREAMS) {
      this.log.warn(`并发连接数已达上限（${MAX_STREAMS}），拒绝新连接`);
      return reject();
    }

    let stream;
    try {
      stream = accept();
    } catch (err) {
      return;
    }

    this.stats.activeStreams++;
    this.stats.totalStreams++;
    const pr = this.perRuleStat(rule.id);
    pr.streams++;
    pr.active++;
    const conn = { ruleId: rule.id, rule: rule.name || `${rule.localHost}:${rule.localPort}`, startedAt: Date.now() };
    this.connections.add(conn);

    const local = net.connect({ host: rule.localHost, port: rule.localPort });
    local.setNoDelay(true);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
      pr.active = Math.max(0, pr.active - 1);
      this.connections.delete(conn);
      try { local.destroy(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
      this.emit('change');
    };

    local.on('connect', () => {
      this.log.debug(`转发：${details.srcIP}:${details.srcPort} → ${rule.localHost}:${rule.localPort}`);
    });
    local.on('error', (err) => {
      this.log.warn(`连接内网服务 ${rule.localHost}:${rule.localPort} 失败：${err.message}`);
      cleanup();
    });

    stream.on('data', (chunk) => {
      this.stats.bytesIn += chunk.length;
      pr.bytesIn += chunk.length;
      const ok = local.write(chunk);
      if (!ok) stream.pause();
    });
    local.on('data', (chunk) => {
      this.stats.bytesOut += chunk.length;
      pr.bytesOut += chunk.length;
      const ok = stream.write(chunk);
      if (!ok) local.pause();
    });
    stream.on('drain', () => { if (!local.destroyed) local.resume(); });
    local.on('drain', () => { if (!stream.destroyed) stream.resume(); });
    stream.on('error', cleanup);
    local.on('error', cleanup);
    stream.on('close', cleanup);
    local.on('close', cleanup);
    stream.on('end', cleanup);
  }

  // ---------------- 状态 ----------------

  state() {
    const srv = this.config.server();
    const opts = this.config.options();
    return {
      status: this.status,
      statusText: this.statusText,
      lastError: this.lastError,
      pendingRelease: this.pendingRelease,
      server: {
        host: srv.host,
        port: srv.port,
        username: srv.username,
        hasPassword: !!srv.password,
        hasKey: !!srv.privateKeyPath,
        privateKeyPath: srv.privateKeyPath,
        remember: srv.remember,
      },
      options: opts,
      os: this.serverOs,
      progress: this.progress,
      stats: this.stats,
      serverStats: this.serverStats,
      rules: this.rules.map((r) => {
        const protocol = inferProtocol(r.localPort, r.protocol);
        const isWeb = protocol === 'http' || protocol === 'https';
        const pr = this.stats.perRule[r.id] || { bytesIn: 0, bytesOut: 0, streams: 0, active: 0 };
        return {
          ...r,
          protocol,
          live: this.stats.forwardedPorts.includes(r.remotePort),
          address: srv.host ? `${srv.host}:${r.remotePort}` : '',
          url: (srv.host && isWeb) ? `${protocol}://${srv.host}:${r.remotePort}` : '',
          traffic: { bytesIn: pr.bytesIn, bytesOut: pr.bytesOut, streams: pr.streams, active: pr.active },
        };
      }),
    };
  }

  /** 测试内网目标是否可达（供界面"连通性检测"用） */
  static probe(host, port, timeout = 3000) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok, err) => {
        sock.destroy();
        resolve({ ok, error: err || '' });
      };
      const t = setTimeout(() => done(false, '连接超时'), timeout);
      sock.on('connect', () => { clearTimeout(t); done(true); });
      sock.on('error', (e) => { clearTimeout(t); done(false, e.message); });
    });
  }
}

module.exports = { TunnelManager };
