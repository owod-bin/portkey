'use strict';

/**
 * SSH 会话封装：登录、执行命令（支持 sudo）、请求远程端口转发
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const { Client } = require('ssh2');

class SshSession extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.conn = null;
    this.connected = false;
    this.isRoot = false;
    this.serverInfo = {};
  }

  /**
   * @param {object} srv { host, port, username, password, privateKeyPath, sudoPassword }
   */
  connect(srv) {
    return new Promise((resolve, reject) => {
      if (!srv.host) return reject(new Error('请先填写服务器地址'));
      if (!srv.username) return reject(new Error('请填写登录用户名'));
      if (!srv.password && !srv.privateKeyPath) return reject(new Error('请填写密码或选择私钥文件'));

      const opts = {
        host: String(srv.host).trim(),
        port: Number(srv.port) || 22,
        username: String(srv.username).trim(),
        readyTimeout: 20000,
        keepaliveInterval: 20000,
        keepaliveCountMax: 3,
        algorithms: {
          // 兼容老服务器
          kex: ['curve25519-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'],
        },
      };

      if (srv.privateKeyPath) {
        try {
          opts.privateKey = fs.readFileSync(srv.privateKeyPath);
          if (srv.password) opts.passphrase = srv.password;
        } catch (err) {
          return reject(new Error('读取私钥失败：' + err.message));
        }
      } else {
        opts.password = srv.password;
      }

      const conn = new Client();
      this.conn = conn;
      let settled = false;
      let closedEmitted = false;

      // 断开只在这里判定：必须在 close 时读取 connected，
      // 否则 error（如 ECONNRESET）先行触发会把状态清掉，导致重连失效
      const emitClosed = () => {
        if (closedEmitted) return;
        closedEmitted = true;
        const was = this.connected;
        this.connected = false;
        if (settled && was) {
          this.log.warn('SSH 连接已断开');
          this.emit('closed');
        }
      };

      conn.on('ready', () => {
        settled = true;
        this.connected = true;
        this.log.ok('SSH 登录成功', `${srv.username}@${srv.host}:${opts.port}`);
        resolve();
      });

      conn.on('error', (err) => {
        if (!settled) {
          settled = true;
          this.connected = false;
          reject(new Error(this._friendlyError(err)));
        } else {
          // 交给 close/end 统一判定断开，这里不改 connected
          this.emit('connError', err);
        }
      });

      conn.on('close', emitClosed);
      conn.on('end', emitClosed);

      // 远程端口转发收到连接
      conn.on('tcp connection', (details, accept, reject) => {
        this.emit('tcp connection', details, accept, reject);
      });

      try {
        conn.connect(opts);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(new Error(this._friendlyError(err)));
        }
      }
    });
  }

  _friendlyError(err) {
    const msg = String(err && err.message ? err.message : err);
    if (/ECONNREFUSED/.test(msg)) return '连接被拒绝：服务器 SSH 端口不通（检查 IP、端口、安全组）';
    if (/ETIMEDOUT|timed out/i.test(msg)) return '连接超时：服务器不可达（检查 IP 与安全组是否放行 22 端口）';
    if (/ENOTFOUND|getaddrinfo/.test(msg)) return '域名无法解析：请检查服务器地址';
    if (/authentication|All configured/i.test(msg)) return '登录失败：用户名或密码错误';
    return msg;
  }

  /**
   * 执行命令，返回 { code, stdout, stderr }
   * sudo=true 时，非 root 会自动加 sudo -S
   */
  exec(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.conn || !this.connected) return reject(new Error('SSH 未连接'));

      const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 30000;
      let finalCmd = cmd;
      let sudoPwd = '';
      if (opts.sudo && !this.isRoot) {
        sudoPwd = opts.sudoPassword || '';
        finalCmd = `sudo -S -p '' sh -c '${String(cmd).replace(/'/g, "'\\''")}'`;
      }

      let settled = false;
      let timer = null;
      let stream = null;

      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      timer = setTimeout(() => {
        try { if (stream) stream.close(); } catch (_) {}
        done(reject, new Error(`命令执行超时（${Math.round(timeout / 1000)} 秒）：${String(cmd).slice(0, 50)}`));
      }, timeout);

      this.conn.exec(finalCmd, (err, s) => {
        if (err) return done(reject, new Error(err.message));
        stream = s;
        let stdout = '';
        let stderr = '';
        s.on('close', (code) => done(resolve, { code: code === undefined ? 0 : code, stdout, stderr }));
        s.on('data', (d) => { stdout += d.toString(); });
        s.stderr.on('data', (d) => { stderr += d.toString(); });
        s.on('error', (e) => done(reject, new Error(e.message)));
        if (sudoPwd) {
          s.write(sudoPwd + '\n');
        } else if (opts.stdin !== undefined) {
          s.write(String(opts.stdin));
        }
        if (opts.stdin !== undefined) s.end();
      });
    });
  }

  /**
   * 请求服务器监听公网端口（等价于 ssh -R）
   * @returns Promise<实际绑定的端口>
   */
  forwardIn(bindAddr, port) {
    return new Promise((resolve, reject) => {
      if (!this.conn || !this.connected) return reject(new Error('SSH 未连接'));
      this.conn.forwardIn(bindAddr, port, (err, boundPort) => {
        if (err) return reject(new Error(this._forwardError(err, port)));
        resolve(boundPort === undefined ? port : boundPort);
      });
    });
  }

  _forwardError(err, port) {
    const msg = String(err && err.message ? err.message : err);
    if (/administratively prohibited/i.test(msg)) {
      return `端口 ${port} 被服务器拒绝：sshd 未开启 AllowTcpForwarding 或 GatewayPorts，请重新执行「配置服务器」`;
    }
    if (/already|in use/i.test(msg)) return `端口 ${port} 在服务器上已被占用`;
    return `端口 ${port} 转发失败：${msg}`;
  }

  /**
   * 说明：ssh2 未提供取消单个 forwardIn 的接口，
   * 已开放的端口会随 SSH 连接关闭而释放（界面上用「重启隧道」来释放端口）。
   */
  close() {
    if (this.conn) {
      try { this.conn.end(); } catch (_) {}
      try { this.conn.destroy(); } catch (_) {}
    }
    this.conn = null;
    this.connected = false;
  }
}

module.exports = { SshSession };
