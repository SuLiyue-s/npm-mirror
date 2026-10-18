'use strict';
/* 日志：按天写文件 + 内存环形缓冲（供界面查看）+ 控制台着色输出 */
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, rootPath, dateOnly, nowLocalIso } = require('./util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
/** 界面 tail 最多读取文件末尾 2MB，避免日志很大时整文件读入内存 */
const TAIL_MAX_BYTES = 2 * 1024 * 1024;

class Logger {
  constructor(opts = {}) {
    this.dir = opts.dir || rootPath('data', 'logs');
    this.level = opts.level || 'info';
    this.maxDays = opts.maxDays || 7;
    this.toConsole = opts.console !== false;
    this.ring = [];
    this.ringMax = opts.ringMax || 500;
    ensureDir(this.dir);
    this.cleanupOld();
    // 启动后每小时清理一次过期日志（unref，不阻止进程退出）
    this.cleanupTimer = setInterval(() => this.cleanupOld(), 3600000);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  file() { return path.join(this.dir, `mirror-${dateOnly()}.log`); }

  cleanupOld() {
    try {
      const keep = new Set();
      const cutoff = Date.now() - this.maxDays * 86400000;
      for (const f of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, f);
        let st = null;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs < cutoff && /^mirror-\d{4}-\d{2}-\d{2}\.log$/.test(f)) {
          try { fs.unlinkSync(full); } catch { /* 忽略 */ }
        } else keep.add(f);
      }
      return keep;
    } catch { return new Set(); }
  }

  write(level, msg, extra) {
    if (LEVELS[level] === undefined) level = 'info';
    if (LEVELS[level] < LEVELS[this.level]) return;
    const time = nowLocalIso();
    // 转义换行，防止 msg 伪造出额外的日志行
    const safeMsg = String(msg).replace(/\r\n|\r|\n/g, '⏎');
    let line = `[${time}] [${level.toUpperCase()}] ${safeMsg}`;
    if (extra !== undefined) {
      let s;
      try { s = typeof extra === 'string' ? extra.replace(/\r\n|\r|\n/g, '⏎') : JSON.stringify(extra); } catch { s = String(extra); }
      if (s && s !== '{}') line += ` ${s}`;
    }
    this.ring.push(line);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    try { fs.appendFileSync(this.file(), line + '\n'); } catch { /* 磁盘异常不阻塞服务 */ }
    if (this.toConsole) {
      process.stdout.write(`${COLORS[level] || ''}${line}${COLORS.reset}\n`);
    }
  }

  debug(m, e) { this.write('debug', m, e); }
  info(m, e) { this.write('info', m, e); }
  warn(m, e) { this.write('warn', m, e); }
  error(m, e) { this.write('error', m, e); }

  recent(n = 10) { return this.ring.slice(-n); }

  /** 读取日志文件尾部（最多读末尾 2MB，避免整文件读入内存） */
  tail(lines = 200, minLevel = 'debug') {
    const file = this.file();
    let text = '';
    let size = 0;
    try {
      const st = fs.statSync(file);
      size = st.size || 0;
      const start = Math.max(0, size - TAIL_MAX_BYTES);
      const len = size - start;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        try {
          let off = 0;
          while (off < len) {
            const n = fs.readSync(fd, buf, off, len - off, start + off);
            if (!n) break;
            off += n;
          }
          text = buf.subarray(0, off).toString('utf8');
        } finally {
          try { fs.closeSync(fd); } catch { /* 忽略 */ }
        }
        // 从文件中间开始读时第一行可能不完整（也可能截断在多字节字符中间），丢弃它
        if (start > 0) {
          if (text.startsWith('\n')) text = text.slice(1);
          else {
            const nl = text.indexOf('\n');
            text = nl >= 0 ? text.slice(nl + 1) : '';
          }
        }
      }
    } catch { text = ''; size = 0; }
    let arr = text.split(/\r?\n/).filter(Boolean);
    const min = LEVELS[minLevel] === undefined ? 0 : LEVELS[minLevel];
    if (min > 0) {
      arr = arr.filter(l => {
        const m = /\[(DEBUG|INFO|WARN|ERROR)\]/.exec(l);
        if (!m) return true;
        return (LEVELS[m[1].toLowerCase()] || 0) >= min;
      });
    }
    return { lines: arr.slice(-lines), file, sizeBytes: size };
  }

  clear() {
    try { fs.writeFileSync(this.file(), ''); } catch { /* 忽略 */ }
    this.ring.length = 0;
    return true;
  }
}

let instance = null;
function init(opts) { instance = new Logger(opts); return instance; }
function get() {
  if (!instance) instance = new Logger();
  return instance;
}

module.exports = { Logger, init, get, LEVELS };
