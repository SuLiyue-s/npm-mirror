'use strict';
/* 桌面版运行控制台：内存环形缓冲，汇集服务日志 / 一键脚本输出 / 托盘操作（Rust 通过桥转发），供 GUI 轮询查看。
 * 只在桌面模式初始化（server.js），非桌面模式保持零副作用；日志文件仍然照常写在数据目录 logs/ 下。 */
const MAX_LINES = 3000;
const SOURCES = ['server', 'script', 'desktop'];
const LEVELS = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

function normalizeLevel(level) {
  const s = String(level == null ? '' : level).toLowerCase();
  return LEVELS.includes(s) ? s : 'info';
}

function normalizeSource(source) {
  const s = String(source == null ? '' : source).toLowerCase();
  return SOURCES.includes(s) ? s : 'server';
}

class ConsoleBuffer {
  constructor(opts = {}) {
    this.max = Math.max(1, Number(opts.max) || MAX_LINES);
    this.lines = [];
    this.seq = 0;        // 单调递增（clear 也不回退，避免客户端 after 游标错乱）
    this.dropped = 0;    // 环形缓冲溢出丢弃的行数（统计用）
  }

  /** 追加一行：{source:'server'|'script'|'desktop', level, text, ts?} → 返回写入的完整行 */
  push(entry = {}) {
    if (entry == null) return null;
    const text = String(entry.text == null ? '' : entry.text).replace(/\r\n|\r|\n/g, '⏎');
    const item = {
      seq: ++this.seq,
      ts: entry.ts || new Date().toISOString(),
      source: normalizeSource(entry.source),
      level: normalizeLevel(entry.level),
      text,
    };
    this.lines.push(item);
    if (this.lines.length > this.max) {
      const over = this.lines.length - this.max;
      this.lines.splice(0, over);
      this.dropped += over;
    }
    return item;
  }

  log(level, text, source) { return this.push({ level, text, source }); }

  /** 按 seq 游标取增量：after 省略=最近 limit 行；标记过期的行靠 lastSeq 让客户端重新对齐 */
  since(after, limit) {
    const lim = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_LIMIT));
    if (after === undefined || after === null || after === '') {
      return { lines: this.lines.slice(-lim), lastSeq: this.seq, dropped: this.dropped };
    }
    const afterSeq = Number(after);
    if (!Number.isFinite(afterSeq)) {
      return { lines: this.lines.slice(-lim), lastSeq: this.seq, dropped: this.dropped };
    }
    // 二分找到第一条 seq > afterSeq 的行（lines 按 seq 升序）
    let lo = 0; let hi = this.lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid].seq <= afterSeq) lo = mid + 1; else hi = mid;
    }
    return { lines: this.lines.slice(lo, lo + lim), lastSeq: this.seq, dropped: this.dropped };
  }

  clear() {
    this.lines.length = 0;
    this.dropped = 0;
    return true;
  }

  size() { return this.lines.length; }
}

let instance = null;
function init(opts) { instance = new ConsoleBuffer(opts); return instance; }
function get() { if (!instance) instance = new ConsoleBuffer(); return instance; }
/** 已初始化时返回缓冲，否则返回 null（用于避免非桌面模式产生副作用） */
function peek() { return instance; }

module.exports = { ConsoleBuffer, init, get, peek, MAX_LINES, MAX_LIMIT, DEFAULT_LIMIT, SOURCES, LEVELS };
