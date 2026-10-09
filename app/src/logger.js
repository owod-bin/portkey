'use strict';

/**
 * 内存环形日志，供界面实时查看
 */
class Logger {
  constructor(capacity = 800) {
    this.buffer = [];
    this.capacity = capacity;
    this.seq = 0;
    // 警告与错误始终打到控制台，便于启动失败时排查；其余需 PORTKEY_VERBOSE=1
    this.verbose = process.env.PORTKEY_VERBOSE === '1';
  }

  push(level, msg, detail) {
    const entry = {
      id: ++this.seq,
      ts: Date.now(),
      time: new Date().toTimeString().slice(0, 8),
      level,
      msg: String(msg),
      detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift();

    if (this.verbose || level === 'warn' || level === 'error') {
      const tag = level.toUpperCase().padEnd(5);
      console.log(`[${entry.time}] ${tag} ${entry.msg}${entry.detail ? ' — ' + entry.detail : ''}`);
    }
    return entry;
  }

  info(msg, detail) { return this.push('info', msg, detail); }
  ok(msg, detail) { return this.push('ok', msg, detail); }
  warn(msg, detail) { return this.push('warn', msg, detail); }
  error(msg, detail) { return this.push('error', msg, detail); }
  debug(msg, detail) { return this.push('debug', msg, detail); }
  step(msg, detail) { return this.push('step', msg, detail); }

  tail(n = 300) {
    return this.buffer.slice(-n);
  }

  since(id = 0) {
    return this.buffer.filter((e) => e.id > id);
  }
}

module.exports = { Logger };
