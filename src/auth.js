'use strict';
/* 令牌鉴权：支持 Bearer / X-Mirror-Token / query token，可对本机回环地址放行 */
const crypto = require('node:crypto');
const { isLoopback } = require('./util');

/** 定长哈希后再用 timingSafeEqual 比较，避免按字节短路泄露令牌前缀 */
function tokenMatches(input, expected) {
  if (!input || !expected || typeof input !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req, url) {
  const h = req.headers || {};
  const auth = h['authorization'] || h['Authorization'];
  if (auth) {
    const s = String(auth);
    if (/^Bearer\s+/i.test(s)) return s.replace(/^Bearer\s+/i, '').trim();
    if (/^Basic\s+/i.test(s)) {
      try {
        const decoded = Buffer.from(s.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        const pass = decoded.slice(decoded.indexOf(':') + 1);
        return pass.trim();
      } catch { return ''; }
    }
  }
  const hdr = h['x-mirror-token'];
  if (hdr) return String(hdr).trim();
  const hdr2 = h['npm-token'];
  if (hdr2) return String(hdr2).trim();
  // 查询参数里的令牌只对「本机回环请求」生效：避免令牌出现在浏览器历史/代理日志/Referer 后被远端复用
  if (url && url.searchParams) {
    const remote = (req.socket && (req.socket.remoteAddress || '')) || '';
    if (isLoopback(remote)) {
      const q = url.searchParams.get('token');
      if (q) return q.trim();
    }
  }
  return '';
}

function makeAuth(cfgProvider) {
  return {
    /** 是否已通过鉴权 */
    check(req, url) {
      const cfg = cfgProvider().security || {};
      const token = extractToken(req, url);
      if (token && tokenMatches(token, cfg.token)) return { ok: true, token };
      const remote = (req.socket && (req.socket.remoteAddress || '')) || '';
      if (cfg.trustLocalhost !== false && isLoopback(remote)) return { ok: true, viaLocalhost: true };
      if (!cfg.requireRead && !cfg.requirePublish) return { ok: true, anonymous: true };
      return { ok: false, token };
    },
    /** 读取权限 */
    canRead(req, url) {
      const cfg = cfgProvider().security || {};
      const r = this.check(req, url);
      if (r.ok) return true;
      return cfg.requireRead !== true;
    },
    /** 写权限（发布/删除/管理） */
    canWrite(req, url) {
      const cfg = cfgProvider().security || {};
      const r = this.check(req, url);
      if (r.ok) return true;
      return cfg.requirePublish !== true;
    },
    extractToken,
  };
}

module.exports = { makeAuth, extractToken, tokenMatches };
