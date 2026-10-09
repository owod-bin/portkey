'use strict';

/**
 * 本地配置：服务器 SSH 凭据 + 端口映射规则
 * 密码使用本机密钥（AES-256-CBC）加密后落盘，避免明文保存
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.PORTKEY_DATA
  ? path.resolve(process.env.PORTKEY_DATA)
  : path.join(APP_ROOT, 'data');

const DEFAULTS = {
  server: {
    host: '',
    port: 22,
    username: 'root',
    password: '',
    privateKeyPath: '',
    sudoPassword: '',
    remember: true,
  },
  rules: [],
  options: {
    autoConnect: false,   // 启动时自动连接
    autoReconnect: true,  // 断线自动重连
    webPort: 7788,
    launchWindow: true,   // 启动时自动打开客户端窗口
  },
  provisionedHosts: {},   // host -> { at, os }
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function keyPath() {
  return path.join(DATA_DIR, '.key');
}

function loadOrCreateKey() {
  ensureDir(DATA_DIR);
  const f = keyPath();
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), 'utf8');
  }
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}

function encrypt(plain) {
  if (!plain) return '';
  try {
    const key = loadOrCreateKey();
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return iv.toString('hex') + ':' + body.toString('hex');
  } catch (_) {
    return '';
  }
}

function decrypt(packed) {
  if (!packed) return '';
  try {
    const [ivHex, bodyHex] = String(packed).split(':');
    const key = loadOrCreateKey();
    const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(bodyHex, 'hex')), d.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

// ---------- 导出口令加密（scrypt + AES-256-GCM）----------

function encryptWithPassword(obj, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [salt, iv, tag, body].map((b) => b.toString('base64')).join('.');
}

function decryptWithPassword(packed, password) {
  const parts = String(packed).split('.');
  if (parts.length !== 4) throw new Error('凭据格式不正确');
  const [salt, iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64'));
  const key = crypto.scryptSync(String(password), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], v);
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

class Config {
  constructor(file) {
    ensureDir(DATA_DIR);
    this.file = file || path.join(DATA_DIR, 'config.json');
    let raw = {};
    let corrupted = false;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('内容不是对象');
      } catch (err) {
        // 文件损坏时备份原文件，避免用户配置被直接覆盖丢失
        corrupted = true;
        try { fs.copyFileSync(this.file, this.file + '.broken'); } catch (_) {}
        console.error('配置文件无法解析，已备份为 config.json.broken，本次使用默认配置');
        raw = {};
      }
    }
    this.data = merge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
    // 解密到内存
    this.data.server.password = decrypt(raw.server && raw.server.password) || '';
    this.data.server.sudoPassword = decrypt(raw.server && raw.server.sudoPassword) || '';
    // 首次运行或文件损坏时落盘一份可用配置，方便用户查看/备份
    if (!fs.existsSync(this.file) || corrupted) this.save();
  }

  get() {
    return this.data;
  }

  server() {
    return this.data.server;
  }

  rules() {
    return this.data.rules;
  }

  options() {
    return this.data.options;
  }

  /** 更新服务器配置（undefined 表示不修改） */
  updateServer(patch) {
    const s = this.data.server;
    for (const k of ['host', 'port', 'username', 'password', 'privateKeyPath', 'sudoPassword', 'remember']) {
      if (patch[k] !== undefined) s[k] = patch[k];
    }
    if (s.port) s.port = Number(s.port);
    this.save();
    return s;
  }

  updateOptions(patch) {
    Object.assign(this.data.options, patch || {});
    this.save();
    return this.data.options;
  }

  setRules(rules) {
    this.data.rules = rules;
    this.save();
  }

  addRule(rule) {
    const r = {
      id: 'r' + crypto.randomBytes(5).toString('hex'),
      name: rule.name || '',
      localHost: rule.localHost || '127.0.0.1',
      localPort: Number(rule.localPort),
      remotePort: Number(rule.remotePort),
      protocol: ['http', 'https', 'tcp', 'auto'].includes(rule.protocol) ? rule.protocol : 'auto',
      enabled: rule.enabled !== false,
      createdAt: Date.now(),
    };
    this.data.rules.push(r);
    this.save();
    return r;
  }

  updateRule(id, patch) {
    const r = this.data.rules.find((x) => x.id === id);
    if (!r) return null;
    for (const k of ['name', 'localHost', 'localPort', 'remotePort', 'enabled', 'protocol']) {
      if (patch[k] !== undefined) r[k] = patch[k];
    }
    if (r.localPort) r.localPort = Number(r.localPort);
    if (r.remotePort) r.remotePort = Number(r.remotePort);
    this.save();
    return r;
  }

  removeRule(id) {
    const i = this.data.rules.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.rules.splice(i, 1);
    this.save();
    return true;
  }

  /** 导出配置；提供口令时把登录凭据一起加密导出 */
  exportData(password) {
    const s = this.data.server;
    const out = {
      app: 'portkey',
      version: require('../package.json').version,
      exportedAt: new Date().toISOString(),
      server: {
        host: s.host,
        port: s.port,
        username: s.username,
        privateKeyPath: s.privateKeyPath,
        remember: s.remember,
      },
      rules: this.data.rules,
      options: {
        autoConnect: this.data.options.autoConnect,
        autoReconnect: this.data.options.autoReconnect,
      },
      credentials: null,
    };
    if (password && (s.password || s.sudoPassword)) {
      out.credentials = encryptWithPassword({ password: s.password, sudoPassword: s.sudoPassword }, password);
    }
    return out;
  }

  /** 导入配置；含加密凭据时必须提供正确口令 */
  importData(payload, password) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('文件内容不是有效的配置');
    if (!payload.server || typeof payload.server.host !== 'string') throw new Error('缺少服务器信息，不是本工具的配置文件');

    const s = this.data.server;
    s.host = payload.server.host || '';
    s.port = Number(payload.server.port) || 22;
    s.username = payload.server.username || 'root';
    s.privateKeyPath = payload.server.privateKeyPath || '';
    if (payload.server.remember !== undefined) s.remember = payload.server.remember !== false;

    if (payload.credentials) {
      if (!password) throw new Error('该配置包含加密凭据，请输入导出时设置的口令');
      let cred;
      try {
        cred = decryptWithPassword(payload.credentials, password);
      } catch (_) {
        throw new Error('口令不正确，无法解密凭据');
      }
      s.password = cred.password || '';
      s.sudoPassword = cred.sudoPassword || '';
    }

    if (Array.isArray(payload.rules)) {
      this.data.rules = payload.rules
        .map((r) => ({
          id: 'r' + crypto.randomBytes(5).toString('hex'),
          name: r.name || '',
          localHost: r.localHost || '127.0.0.1',
          localPort: Number(r.localPort) || 0,
          remotePort: Number(r.remotePort) || 0,
          protocol: ['http', 'https', 'tcp', 'auto'].includes(r.protocol) ? r.protocol : 'auto',
          enabled: r.enabled !== false,
          createdAt: Date.now(),
        }))
        .filter((r) => r.localPort > 0 && r.remotePort > 0);
    }

    if (payload.options && typeof payload.options === 'object') {
      const keepPort = this.data.options.webPort; // 本机端口保持不动
      if (payload.options.autoConnect !== undefined) this.data.options.autoConnect = !!payload.options.autoConnect;
      if (payload.options.autoReconnect !== undefined) this.data.options.autoReconnect = !!payload.options.autoReconnect;
      this.data.options.webPort = keepPort;
    }

    this.save();
    return { host: s.host, rules: this.data.rules.length };
  }

  markProvisioned(host, os) {
    this.data.provisionedHosts[host] = { at: Date.now(), os: os || '' };
    this.save();
  }

  save() {
    const out = JSON.parse(JSON.stringify(this.data));
    out.server.password = this.data.server.remember ? encrypt(this.data.server.password) : '';
    out.server.sudoPassword = this.data.server.remember ? encrypt(this.data.server.sudoPassword) : '';
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2), 'utf8');
  }
}

module.exports = { Config, encrypt, decrypt, DATA_DIR, APP_ROOT };
