'use strict';
/* 配置：默认值 / 读写 / 深合并 / 取值校验。所有数据都在项目目录内，不触碰系统全局 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { rootPath, ensureDir, writeJsonAtomic, randomToken } = require('./util');

const CONFIG_FILE = rootPath('data', 'config.json');
const MODES = ['cache', 'proxy', 'offline'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const OBJECT_SECTIONS = ['server', 'upstream', 'security', 'storage', 'log', 'ui'];

function defaults() {
  return {
    server: { ip: '127.0.0.1', port: 4873, openBrowserOnStart: true },
    mode: 'cache',                 // cache=本地优先并回源缓存 | proxy=过期即回源 | offline=纯离线
    upstream: {
      registry: 'https://registry.npmmirror.com',
      timeoutMs: 30000,
      retries: 2,
      prefetchTarball: false,      // 拉取元数据时是否顺带预下载 tarball（默认惰性下载）
      metadataTtlSec: 300,         // 元数据回源缓存时长（秒）
      acceptAbbreviated: true,     // 使用精简元数据，速度快、体积小
      concurrency: 6,              // 补 tarball 时同时下载的个数（1~32）
      fetchPublishTime: true,      // 是否额外拉完整元数据补齐每个版本的真实发布时间
      maxTarballMB: 512,           // 单个 tarball 下载上限（MB）
    },
    security: {
      token: randomToken(24),
      requirePublish: true,        // 发布/删除包需要令牌
      requireRead: false,          // 读取（安装）是否需要令牌
      trustLocalhost: true,        // 本机回环地址免令牌，方便自己用
      username: 'admin',
    },
    storage: { dir: 'data/storage', maxUploadMB: 500, maxBundleUploadMB: 4096 },
    log: { level: 'info', maxDays: 7 },
    ui: { title: '私人 npm 镜像源' },
  };
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** 监听 IP：必须是 IP 字面量（空/0.0.0.0/:: 表示监听全部），否则回退 127.0.0.1 */
function safeListenIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '127.0.0.1';
  if (s === '0.0.0.0' || s === '::') return s;
  return net.isIP(s) ? s : '127.0.0.1';
}

/** 存储目录：允许项目内相对路径或绝对路径（迁移到大磁盘），但拒绝空字节与磁盘根目录 */
function safeStorageDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw || raw.includes('\0')) return 'data/storage';
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootPath(), raw);
  if (abs === path.parse(abs).root) return 'data/storage';   // 拒绝 C:\ / D:\ 这类根目录
  if (abs.length < 4) return 'data/storage';
  return raw;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 把任意来源（磁盘文件 / PUT 请求）的配置规整成合法结构：
 * 类型不对的字段回退默认值，未知字段直接丢弃，避免把非法配置写进 data/config.json
 * 导致「鉴权被意外放宽」或「重启后起不来」。
 */
function sanitize(input) {
  const d = defaults();
  const src = isPlainObject(input) ? input : {};
  const server = isPlainObject(src.server) ? src.server : {};
  const up = isPlainObject(src.upstream) ? src.upstream : {};
  const sec = isPlainObject(src.security) ? src.security : {};
  const st = isPlainObject(src.storage) ? src.storage : {};
  const lg = isPlainObject(src.log) ? src.log : {};
  const ui = isPlainObject(src.ui) ? src.ui : {};

  const ip = String(server.ip || '').trim();
  const registry = String(up.registry || '').trim();
  const level = String(lg.level || '').trim().toLowerCase();
  const title = String(ui.title || '').trim();
  const dir = String(st.dir || '').trim();
  const username = String(sec.username || '').trim();
  return {
    server: {
      ip: safeListenIp(ip),
      port: clampInt(server.port, 1, 65535, 4873),
      openBrowserOnStart: server.openBrowserOnStart !== false,
    },
    mode: MODES.includes(String(src.mode)) ? String(src.mode) : 'cache',
    upstream: {
      registry: /^https?:\/\//i.test(registry) ? registry : d.upstream.registry,
      timeoutMs: clampInt(up.timeoutMs, 1000, 600000, d.upstream.timeoutMs),
      retries: clampInt(up.retries, 0, 5, d.upstream.retries),
      prefetchTarball: up.prefetchTarball === true,
      metadataTtlSec: clampInt(up.metadataTtlSec, 0, 86400, d.upstream.metadataTtlSec),
      acceptAbbreviated: up.acceptAbbreviated !== false,
      concurrency: clampInt(up.concurrency, 1, 32, d.upstream.concurrency),
      fetchPublishTime: up.fetchPublishTime !== false,
      maxTarballMB: clampInt(up.maxTarballMB, 1, 4096, d.upstream.maxTarballMB),
    },
    security: {
      // 令牌一旦存在就保持稳定，只有完全缺失时才生成新的
      token: (typeof sec.token === 'string' && sec.token.trim()) ? sec.token.trim() : randomToken(24),
      requirePublish: sec.requirePublish !== false,
      requireRead: sec.requireRead === true,
      trustLocalhost: sec.trustLocalhost !== false,
      username: (username || 'admin').slice(0, 64),
    },
    storage: {
      dir: safeStorageDir(dir),
      maxUploadMB: clampInt(st.maxUploadMB, 1, 4096, 500),
      // 离线包（整机备份）单独一个上限：几个 GB 的 bundle 是常态，不能跟单包上传共用一个 500MB 门槛；
      // 上传时是流式落盘，不占内存，所以可以给到 64GB。
      maxBundleUploadMB: clampInt(st.maxBundleUploadMB, 1, 65536, 4096),
    },
    log: {
      level: LOG_LEVELS.includes(level) ? level : 'info',
      maxDays: clampInt(lg.maxDays, 1, 365, 7),
    },
    ui: {
      title: (title || '私人 npm 镜像源').slice(0, 100),
    },
  };
}

let cache = null;

function load({ reload = false } = {}) {
  if (cache && !reload) return cache;
  let stored = null;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    stored = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 配置文件损坏（JSON 截断/编码错误）时不要让服务起不来：备份坏文件后用默认配置重建
      const bad = `${CONFIG_FILE}.bad-${Date.now()}`;
      try { fs.renameSync(CONFIG_FILE, bad); console.warn(`[配置] 文件无法解析，已备份为 ${bad}`); }
      catch { /* 忽略 */ }
    }
    stored = null;
  }
  if (!stored) {
    cache = sanitize(defaults());
    ensureDir(path.dirname(CONFIG_FILE));
    writeJsonAtomic(CONFIG_FILE, cache);
  } else {
    cache = sanitize(stored);
  }
  return cache;
}

function get() { return load(); }

function save(partial) {
  const cur = load();
  const p = isPlainObject(partial) ? { ...partial } : {};
  // 非对象的分段字段一律忽略：防止 PUT {"security":null} 这类请求把整段配置抹掉（令牌被重置/鉴权被放宽）
  for (const k of OBJECT_SECTIONS) if (p[k] !== undefined && !isPlainObject(p[k])) delete p[k];
  if (p.mode !== undefined && typeof p.mode !== 'string') delete p.mode;
  // 令牌只能通过 /__admin/api/token/regenerate 轮换：任何配置保存请求（含空字符串）都不得改动令牌，
  // 否则一个误传的 security.token:'' 会让所有 npm 客户端瞬间 401，而调用方拿不到新令牌。
  if (isPlainObject(p.security)) delete p.security.token;
  const next = sanitize(deepMerge(cur, p));
  cache = next;
  ensureDir(path.dirname(CONFIG_FILE));
  writeJsonAtomic(CONFIG_FILE, next);
  return cache;
}

/** 重新生成管理令牌并立即落盘：唯一允许改动 security.token 的入口（save() 会丢弃 token 字段） */
function rotateToken() {
  const cfg = load();
  cfg.security.token = randomToken(24);
  cache = sanitize(cfg);
  ensureDir(path.dirname(CONFIG_FILE));
  writeJsonAtomic(CONFIG_FILE, cache);
  return cache.security.token;
}

function storageDir() {
  const cfg = load();
  return path.isAbsolute(cfg.storage.dir) ? cfg.storage.dir : rootPath(cfg.storage.dir);
}

function bundlesDir() { return rootPath('data', 'bundles'); }
function logsDir() { return rootPath('data', 'logs'); }

/** 需要在重启后才生效的字段 */
function requiresRestart(before, after) {
  const serverChanged = ['ip', 'port'].some(k => String(before.server[k]) !== String(after.server[k]));
  const storageChanged = String(before.storage.dir) !== String(after.storage.dir);
  return serverChanged || storageChanged;
}

/** 供界面显示：默认隐藏令牌 */
function publicConfig(reveal) {
  const cfg = load();
  const copy = JSON.parse(JSON.stringify(cfg));
  if (!reveal) copy.security.token = '••••••••••••';
  return copy;
}

module.exports = {
  CONFIG_FILE, defaults, load, get, save, sanitize, rotateToken, storageDir, bundlesDir, logsDir,
  publicConfig, requiresRestart, deepMerge,
};
