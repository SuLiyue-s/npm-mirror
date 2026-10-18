'use strict';
/* 配置：默认值 / 读写 / 深合并 / 取值校验。所有数据都在项目目录内，不触碰系统全局 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { rootPath, ensureDir, writeJsonAtomic, randomToken } = require('./util');

const CONFIG_FILE = rootPath('data', 'config.json');
const MODES = ['cache', 'proxy', 'offline'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const OBJECT_SECTIONS = ['server', 'admin', 'upstream', 'security', 'storage', 'log', 'ui'];

function defaults() {
  return {
    server: { ip: '127.0.0.1', port: 4873, openBrowserOnStart: true },
    // 管理界面独立监听：ip 只允许 127.0.0.0/8 的本地回环 IPv4（只有本机能访问管理界面），
    // port 不能与 server.port 相同（两个监听不能共用同一个端口）。默认 4874，冲突时回退到 4873/server.port±1。
    admin: { ip: '127.0.0.1', port: 4874 },
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
      // 加速镜像源列表（可填多个）：包版本元数据仍来自上面的上游源，但下载 tarball 时
      // 会先并行探测这些镜像，优先从「有这个版本且响应最快」的镜像下载，都没有才回上游源。
      accelerators: [],
      maxTarballMB: 512,           // 单个 tarball 下载上限（MB）
    },
    security: {
      token: randomToken(24),
      requirePublish: true,        // 发布/删除包需要令牌
      requireRead: false,          // 读取（安装）是否需要令牌
      trustLocalhost: true,        // 本机回环地址（整个 127.0.0.0/8 网段与 ::1）免令牌，方便自己用
      username: 'admin',
    },
    storage: {
      dir: 'data/storage', maxUploadMB: 500, maxBundleUploadMB: 4096,
      // 离线包导出 / 导入的包级并发（1 = 串行）：导出并行压缩、导入并行处理不同包，默认 4。
      bundleExportConcurrency: 4, bundleImportConcurrency: 4,
      // 网页上传大离线包时走「分片并发上传」：每片大小（MB）与同时上传的分片数。
      bundleUploadChunkMB: 8, bundleUploadConcurrency: 4,
      // 解包（解压 + 写盘）的并发路数：与「导入包」的并发分开，默认 8。
      bundleImportExtractConcurrency: 8,
      // 全项目「本地扫描 / 统计」类批处理的读盘并发：补 tarball 的前期规划、导出备份的统计、
      // 依赖闭包扫描、npm 缓存扫描/导入、离线包导入后的包扫描等。默认 8（1-64）：
      // 机械硬盘上太高反而抖动，SSD + 多核可调到接近逻辑处理器数。
      localScanConcurrency: 8,
    },
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

/**
 * 管理界面监听 IP 的严格校验：只允许 IPv4 的 127.0.0.0/8 网段（本地回环）。
 * 这是安全需求：管理界面只能被本机访问，不能配置成 0.0.0.0、局域网 IP、主机名或 ::1。
 */
function isAdminListenIp(ip) {
  const s = String(ip || '').trim();
  if (!net.isIPv4(s)) return false;
  return s.split('.')[0] === '127';
}

/** 管理界面监听 IP 规整：非法值回退到 127.0.0.1（API 保存时会直接报错，不会静默改值） */
function safeAdminIp(ip) {
  const s = String(ip || '').trim();
  return isAdminListenIp(s) ? s : '127.0.0.1';
}

/** 管理界面端口：1-65535；与镜像源监听端口相同时回退到相邻端口（需求：两个端口不能一样） */
function safeAdminPort(value, serverPort) {
  const sp = clampInt(serverPort, 1, 65535, 4873);
  let p = clampInt(value, 1, 65535, 4874);
  if (p === sp) p = sp > 1 ? sp - 1 : sp + 1;
  return p;
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

/**
 * 加速镜像源列表规整：只接受 http(s) 地址；统一去掉结尾斜杠、去重（大小写不敏感）、
 * 排除与主上游相同的地址，最多保留 8 个。非法项直接丢弃，不因为界面填错导致配置写入失败。
 */
function safeAccelerators(value, mainRegistry) {
  const list = Array.isArray(value) ? value : [];
  const main = String(mainRegistry || '').trim().replace(/\/+$/, '').toLowerCase();
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(s)) continue;
    if (s.length > 300) continue;
    const k = s.toLowerCase();
    if (k === main || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
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
  const admin = isPlainObject(src.admin) ? src.admin : {};
  const up = isPlainObject(src.upstream) ? src.upstream : {};
  const sec = isPlainObject(src.security) ? src.security : {};
  const st = isPlainObject(src.storage) ? src.storage : {};
  const lg = isPlainObject(src.log) ? src.log : {};
  const ui = isPlainObject(src.ui) ? src.ui : {};

  const ip = String(server.ip || '').trim();
  const serverPort = clampInt(server.port, 1, 65535, 4873);
  const registry = String(up.registry || '').trim();
  const level = String(lg.level || '').trim().toLowerCase();
  const title = String(ui.title || '').trim();
  const dir = String(st.dir || '').trim();
  const username = String(sec.username || '').trim();
  return {
    server: {
      ip: safeListenIp(ip),
      port: serverPort,
      openBrowserOnStart: server.openBrowserOnStart !== false,
    },
    admin: {
      // 管理界面监听：只允许 127.0.0.0/8 回环 IPv4；端口不能与镜像源端口相同
      ip: safeAdminIp(admin.ip),
      port: safeAdminPort(admin.port, serverPort),
    },
    mode: MODES.includes(String(src.mode)) ? String(src.mode) : 'cache',
    upstream: {
      registry: /^https?:\/\//i.test(registry) ? registry : d.upstream.registry,
      // 加速镜像源列表：类型非法/地址非法会被过滤，排除与主上游重复的地址，最多 8 个
      accelerators: safeAccelerators(up.accelerators, /^https?:\/\//i.test(registry) ? registry : d.upstream.registry),
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
      // 离线包导出/导入的包级并发：1-64，默认 4。导出时把 gzip 摊到多个线程，
      // 导入时多个包/版本同时写（每个包只锁自己）。上限按「32 核 64 线程」档留足余量，
      // 机器核多、SSD 时可调大到接近逻辑处理器数；机械硬盘/CPU 忙时调小更稳。
      bundleExportConcurrency: clampInt(st.bundleExportConcurrency, 1, 64, 4),
      bundleImportConcurrency: clampInt(st.bundleImportConcurrency, 1, 64, 4),
      // 分片并发上传：每片大小 1-64MB、同时上传的分片数 1-64。片太大进度反馈粗、片太小请求开销大；
      // 浏览器对同域名通常只有 6 条连接，实际调过 6 收益有限（换 HTTP/2 反代后才有用）。
      bundleUploadChunkMB: clampInt(st.bundleUploadChunkMB, 1, 64, 8),
      bundleUploadConcurrency: clampInt(st.bundleUploadConcurrency, 1, 64, 4),
      // 解包（解压 + 写盘）的并发路数：1-64，默认 8；机械硬盘上写并发过高反而慢，可调低。
      bundleImportExtractConcurrency: clampInt(st.bundleImportExtractConcurrency, 1, 64, 8),
      // 「本地扫描/统计」类批处理（补 tarball 规划、导出统计、依赖闭包、缓存扫描/导入）的读盘并发：1-64，默认 8。
      localScanConcurrency: clampInt(st.localScanConcurrency, 1, 64, 8),
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

/**
 * 需要在重启后才生效的字段，按「需要重启谁」分类：
 *   registry —— 镜像源监听（server.ip / server.port）：可只重启镜像源服务，管理界面不中断；
 *   admin    —— 管理界面监听（admin.ip / admin.port）：可只重启管理界面，镜像源服务不中断；
 *   program  —— 进程级配置（storage.dir）：只能重启整个程序。
 */
function restartChanges(before, after) {
  const beforeAdmin = (before && before.admin) || {};
  const afterAdmin = (after && after.admin) || {};
  const registry = ['ip', 'port'].some(k => String(before.server[k]) !== String(after.server[k]));
  const admin = ['ip', 'port'].some(k => String(beforeAdmin[k]) !== String(afterAdmin[k]));
  const program = String(before.storage.dir) !== String(after.storage.dir);
  return { registry, admin, program };
}

/** 是否有需要在重启后才生效的字段（兼容旧调用：任一需要重启即为 true） */
function requiresRestart(before, after) {
  const r = restartChanges(before, after);
  return r.registry || r.admin || r.program;
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
  publicConfig, requiresRestart, restartChanges, deepMerge,
  isAdminListenIp, safeAdminIp, safeAdminPort,
};
