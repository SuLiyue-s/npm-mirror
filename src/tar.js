'use strict';
/* 纯 Node 实现的 tar.gz 打包/解包（零依赖，用于离线迁移包的导出与导入）。
 * 解包侧的硬性约束（防止损坏/恶意归档造成静默数据损坏或越界写入）：
 *  1. 每个 header 都必须通过校验和验证（前 148 字节无符号求和，checksum 字段按空格计）；
 *  2. 每个条目的大小必须是合法八进制整数且不超过上限，实际写入字节数必须等于声明大小；
 *  3. 目录/符号链接/被过滤/不安全条目只要 size>0 都必须消费 size+对齐 pad，避免后续条目错位
 *     （目录条目只建目录，不写数据）；
 *  4. 单次解包有总字节、条目数、单条目字节三重上限，超限直接失败；
 *  5. 保留拒绝 ../ 路径与符号链接条目的行为；任何失败都会删除本次已解出的文件并整体报错。 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { ensureDir, toPosix } = require('./util');

const BLOCK = 512;

const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 ** 3;  // 单次解包总字节上限 2GB
const DEFAULT_MAX_ENTRIES = 200000;             // 单次解包条目数上限
const DEFAULT_MAX_ENTRY_BYTES = 1024 ** 3;      // 单条目上限 1GB
const DEFAULT_MAX_PAX_BYTES = 1024 * 1024;      // PAX / GNU longname 元数据上限 1MB
const READ_TAR_ENTRY_MAX_BYTES = 256 * 1024 * 1024; // readTarEntry 单条目上限 256MB
const EOF_TRAILER_MAX = 10 * 1024;                  // 结束标记（两个全零块）之后允许的填充上限

function badTar(message, code = 'EBADTAR') {
  const err = new Error(`tar: ${message}`);
  err.code = code;
  return err;
}
function truncated(what) { return badTar(`归档数据意外结束（${what}）`, 'ETRUNCATED'); }
function badSize(what, size) { return badTar(`${what} 大小非法或超出上限：${String(size)}`, 'EBADSIZE'); }

function writeStr(buf, offset, length, str) {
  if (str === undefined || str === null) return;
  const b = Buffer.from(String(str), 'utf8');
  b.copy(buf, offset, 0, Math.min(b.length, length));
}

function writeOct(buf, offset, length, value) {
  const s = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  const padded = s.padStart(length - 1, '0').slice(-(length - 1));
  buf.write(padded, offset, length - 1, 'ascii');
  buf.writeUInt8(0, offset + length - 1);
}

function makeHeader({ name, size = 0, mtime = Date.now() / 1000, type = '0', mode = 0o644, linkname = '' }) {
  const buf = Buffer.alloc(BLOCK);
  let nm = toPosix(name).replace(/^\/+/, '');
  let prefix = '';
  if (Buffer.byteLength(nm) > 100) {
    const idx = nm.lastIndexOf('/', 155);
    if (idx > 0) { prefix = nm.slice(0, idx); nm = nm.slice(idx + 1); }
    if (Buffer.byteLength(nm) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`tar: 路径过长无法打包: ${name}`);
    }
  }
  writeStr(buf, 0, 100, nm);
  writeOct(buf, 100, 8, mode);
  writeOct(buf, 108, 8, 0);
  writeOct(buf, 116, 8, 0);
  writeOct(buf, 124, 12, size);
  writeOct(buf, 136, 12, Math.floor(mtime));
  buf.write('        ', 148, 8, 'ascii');
  buf.write(type.slice(0, 1), 156, 1, 'ascii');
  writeStr(buf, 157, 100, linkname);
  buf.write('ustar\x0000', 257, 8, 'binary');
  writeStr(buf, 265, 32, 'npm-mirror');
  writeStr(buf, 297, 32, 'npm-mirror');
  writeStr(buf, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'binary');
  return buf;
}

function zeroPad(n) { const rem = n % BLOCK; return rem === 0 ? 0 : BLOCK - rem; }

function createWriter(outFile, gzip) {
  ensureDir(path.dirname(outFile));
  const raw = fs.createWriteStream(outFile);
  let sink = raw;
  if (gzip) {
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(raw);
    sink = gz;
  }
  let failed = null;
  raw.on('error', e => { failed = e; });
  sink.on('error', e => { failed = e; });
  return {
    async write(buf) {
      if (failed) throw failed;
      if (sink.write(buf)) return;
      await new Promise((res, rej) => {
        const onDrain = () => { cleanup(); res(); };
        const onErr = (e) => { cleanup(); rej(e); };
        const cleanup = () => { sink.removeListener('drain', onDrain); sink.removeListener('error', onErr); };
        sink.once('drain', onDrain);
        sink.once('error', onErr);
      });
    },
    async end() {
      await new Promise((res, rej) => {
        const onFinish = () => { cleanup(); res(); };
        const onErr = (e) => { cleanup(); rej(e); };
        const cleanup = () => {
          raw.removeListener('finish', onFinish);
          raw.removeListener('error', onErr);
          sink.removeListener('error', onErr);
        };
        sink.once('error', onErr);
        raw.once('finish', onFinish);
        raw.once('error', onErr);
        sink.end();
      });
      if (failed) throw failed;
    },
    /** 打包中途失败时调用：销毁流，避免残留的写入句柄与 .part 文件 */
    abort() {
      if (!failed) failed = new Error('tar: 写入已中止');
      try { sink.destroy(); } catch { /* 忽略 */ }
      try { raw.destroy(); } catch { /* 忽略 */ }
    },
  };
}

/**
 * 打包为 tar.gz
 * entries: [{ name, source? , data?, mtime?, size? }]
 */
async function packTarGz(outFile, entries, { gzip = true, onProgress } = {}) {
  const w = createWriter(outFile, gzip);
  let total = 0;
  let count = 0;
  try {
    for (let e of entries) {
      let size = e.size;
      const data = e.data;
      if (data !== undefined && data !== null) {
        // data 分支：声明大小必须与实际数据长度一致，否则归档会错位（不是静默截断）
        if (!Buffer.isBuffer(data)) throw badTar(`条目 ${e.name} 的 data 必须是 Buffer`, 'EBADTYPE');
        if (size === undefined) size = data.length;
        if (Number(size) !== data.length) {
          throw badTar(`条目 ${e.name} 声明大小 ${size} 与实际数据长度 ${data.length} 不一致`, 'EBADSIZE');
        }
      } else if (e.source) {
        const st = fs.statSync(e.source);
        if (st.isDirectory()) {
          await w.write(makeHeader({ ...e, size: 0, type: '5' }));
          count++;
          if (onProgress && count % 25 === 0) onProgress({ count, total });
          continue;
        }
        size = st.size;
        e = { ...e, mtime: e.mtime || st.mtimeMs / 1000 };
      }
      size = size || 0;
      await w.write(makeHeader({ ...e, size }));
      if (data) {
        if (data.length) {
          await w.write(data);
          const pad = zeroPad(data.length);
          if (pad) await w.write(Buffer.alloc(pad));
          total += data.length;
        }
      } else if (e.source && size > 0) {
        let readBytes = 0;
        await new Promise((res, rej) => {
          const rs = fs.createReadStream(e.source, { highWaterMark: 1 << 20 });
          let settled = false;
          const fail = (err) => {
            if (settled) return;
            settled = true;
            try { rs.destroy(); } catch { /* 忽略 */ }
            rej(err);
          };
          const done = () => {
            if (settled) return;
            settled = true;
            res();
          };
          rs.on('data', chunk => {
            total += chunk.length;
            readBytes += chunk.length;
            rs.pause();
            w.write(chunk).then(() => { if (!settled) rs.resume(); }, fail);
          });
          rs.on('end', done);
          rs.on('error', fail);
          // 源文件被外部截断/删除时可能不触发 end 直接 close：按失败处理，避免外层 Promise 永久挂起
          rs.on('close', () => { if (!settled) fail(new Error('tar: 读取源文件意外中断')); });
        });
        // 关键校验：流式读取的实际字节数必须与 stat 声明的一致，否则 tarball 内部会错位
        if (readBytes !== size) {
          throw badTar(`源文件 ${e.source} 实际读取 ${readBytes} 字节，与文件大小 ${size} 字节不一致`, 'EBADTAR');
        }
        const pad = zeroPad(size);
        if (pad) await w.write(Buffer.alloc(pad));
      }
      count++;
      if (onProgress && count % 25 === 0) onProgress({ count, total });
    }
    await w.write(Buffer.alloc(BLOCK * 2));
    await w.end();
    return { sizeBytes: fs.statSync(outFile).size, entries: count, totalBytes: total };
  } catch (e) {
    // 失败时销毁写入流并删除半成品，避免留下损坏的归档/悬挂的文件句柄
    try { w.abort(); } catch { /* 忽略 */ }
    try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
    throw e;
  }
}

function parseOct(buf) {
  const s = buf.toString('ascii').replace(/\0.*$/, '').trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** 严格解析八进制字段：非八进制字符直接报错，避免「size 被当成 0」导致后续条目错位 */
function parseOctStrict(buf, what) {
  const s = buf.toString('ascii').replace(/\0.*$/, '').trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw badTar(`${what} 不是合法的八进制数：${JSON.stringify(s)}`, 'EBADTAR');
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw badSize(what, s);
  return n;
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/** tar header 校验和：前 148 字节 + checksum 字段（按 8 个空格）+ 156 字节之后，全部按无符号字节求和。
 *  同时兼容部分老式实现使用的有符号求和。 */
function checksumOf(header, signed) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    let b = (i >= 148 && i < 156) ? 0x20 : header[i];
    if (signed && b > 127) b -= 256;
    sum += b;
  }
  return sum;
}

function assertHeaderChecksum(header) {
  const expected = parseOct(header.subarray(148, 156));
  const unsigned = checksumOf(header, false);
  if (expected === unsigned) return;
  const signed = checksumOf(header, true);
  if (expected === signed) return;
  throw badTar(`header 校验和不匹配（期望 ${expected}，实际 ${unsigned}）`, 'EBADTAR');
}

function decodePax(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let sp = buf.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(buf.toString('ascii', pos, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.toString('utf8', pos, pos + len);
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const key = rec.slice(rec.indexOf(' ') + 1, eq);
      out[key] = rec.slice(eq + 1).replace(/\n$/, '');
    }
    pos += len;
  }
  return out;
}

function openTarStream(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  return gz ? rs.pipe(zlib.createGunzip()) : rs;
}

/** Windows 保留设备名（CON、PRN、AUX、NUL、COM1-9、LPT1-9…）：带扩展名同样被系统保留 */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Windows 文件名非法字符：':' 会被当成 NTFS 备用数据流，其余是保留符号 */
const WIN_BAD_CHARS_RE = /[:*?"<>|]/;
const WIN_CTRL_RE = /[\u0000-\u001f\u007f]/;

/** 判断单个路径段是否会在 Windows 上越界/失败（保留名、非法字符、结尾点或空格） */
function isUnsafeSegment(part) {
  if (WIN_BAD_CHARS_RE.test(part) || WIN_CTRL_RE.test(part)) return true;
  // Windows 会静默去掉结尾的 '.' 与空格，可能让两个不同的条目落成同一个文件
  if (/[. ]$/.test(part)) return true;
  if (WIN_RESERVED_RE.test(part)) return true;
  return false;
}

function sanitizeRel(name) {
  const rel = toPosix(name).replace(/^\.\//, '').replace(/^\/+/, '');
  const parts = rel.split('/').filter(p => p && p !== '.');
  // 拒绝 '..'（保持原有行为）以及 Windows 上不安全/非法的路径段，返回 null 由调用方跳过
  if (parts.some(p => p === '..')) return null;
  if (parts.some(isUnsafeSegment)) return null;
  return parts.join('/');
}

/**
 * 把流包装成「按需取字节」的读取器：内部维护 chunk 队列 + 队首偏移，
 * need(n) 只确保可读 n 字节、take(n) 只拼接跨 chunk 的那部分，drop(n) 直接越过数据，
 * 避免对大条目反复 Buffer.concat 造成 O(n²) 拷贝。
 */
function makeReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  const chunks = [];
  let off = 0;          // 队首 chunk 已消费偏移
  let ended = false;
  const avail = () => {
    let n = -off;
    for (let i = 0; i < chunks.length; i++) n += chunks[i].length;
    return n;
  };
  async function need(n) {
    while (avail() < n) {
      const r = await it.next();
      if (r.done) { ended = true; return false; }
      const chunk = r.value;
      if (chunk && chunk.length) chunks.push(chunk);
    }
    return true;
  }
  function drop(n) {
    let remain = n;
    while (remain > 0) {
      const chunk = chunks[0];
      const cnt = Math.min(remain, chunk.length - off);
      off += cnt;
      remain -= cnt;
      if (off >= chunk.length) { chunks.shift(); off = 0; }
    }
  }
  function take(n) {
    if (n <= 0) return Buffer.alloc(0);
    const first = chunks[0];
    if (first && off + n <= first.length) {
      const out = first.subarray(off, off + n);
      off += n;
      if (off >= first.length) { chunks.shift(); off = 0; }
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let remain = n;
    let written = 0;
    while (remain > 0) {
      const chunk = chunks[0];
      const cnt = Math.min(remain, chunk.length - off);
      chunk.copy(out, written, off, off + cnt);
      written += cnt;
      remain -= cnt;
      off += cnt;
      if (off >= chunk.length) { chunks.shift(); off = 0; }
    }
    return out;
  }
  async function close() {
    chunks.length = 0;
    off = 0;
    try { if (typeof it.return === 'function') await it.return(); } catch { /* 忽略 */ }
    try { if (typeof stream.destroy === 'function') stream.destroy(); } catch { /* 忽略 */ }
  }
  return { need, take, drop, avail, close, isEnded: () => ended };
}

/**
 * 解包 tar.gz 到目录
 * opts:
 *   filter(relPath, {size, mtime}) -> boolean   是否解出
 *   onEntry(relPath, writtenBytes)              每个文件解出后的回调
 *   maxTotalBytes / maxEntries / maxEntryBytes / maxPaxBytes  覆盖默认上限
 */
async function extractTarGz(file, destDir, opts = {}) {
  const {
    filter, onEntry,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxPaxBytes = DEFAULT_MAX_PAX_BYTES,
  } = opts;
  if (!(maxTotalBytes > 0) || !(maxEntries > 0) || !(maxEntryBytes > 0) || !(maxPaxBytes > 0)) {
    throw badTar('解包上限配置非法', 'EBADSIZE');
  }
  ensureDir(destDir);
  const reader = makeReader(openTarStream(file));
  const { take, drop, avail, close, need: rawNeed } = reader;
  const result = { files: [], dirs: [], bytes: 0, entries: 0 };
  let pendingPath = null;   // GNU longname
  let pendingPax = null;    // PAX 扩展
  let consumed = 0;
  let headers = 0;
  let zeroRun = 0;          // 连续全零块计数：两个即归档结束
  let currentOut = null;    // 正在写入的文件流
  let currentTarget = null; // 正在写入的文件路径

  function addConsumed(n) {
    consumed += n;
    if (consumed > maxTotalBytes) throw badTar(`解压总字节超出上限 ${maxTotalBytes}`, 'ETOOLARGE');
  }
  /** 读取前先按剩余额度检查：额度不够时在真正解压前就失败，零块/元数据块同样受限 */
  async function need(n) {
    if (consumed + n > maxTotalBytes) throw badTar(`解压总字节超出上限 ${maxTotalBytes}`, 'ETOOLARGE');
    return rawNeed(n);
  }
  function checkEntrySize(size, what, cap = maxEntryBytes) {
    if (!Number.isSafeInteger(size) || size < 0) throw badSize(what, size);
    if (size > cap) throw badSize(`${what}（上限 ${cap}）`, size);
  }
  /** 流式丢弃 n 字节（用于被跳过/不安全/目录条目），顺带累计总量上限 */
  async function drain(n, what) {
    let remain = n;
    while (remain > 0) {
      if (avail() === 0) {
        if (!(await need(Math.min(remain, 1 << 20)))) throw truncated(what);
      }
      const cnt = Math.min(remain, avail());
      drop(cnt);
      remain -= cnt;
      addConsumed(cnt);
    }
  }
  async function readPaxData(size, what) {
    checkEntrySize(size, what, maxPaxBytes);
    if (!(await need(size))) throw truncated(what);
    const data = Buffer.from(take(size));
    const pad = zeroPad(size);
    if (pad) {
      if (!(await need(pad))) throw truncated(what);
      drop(pad);
    }
    addConsumed(size + pad);
    return data;
  }
  /** 两个连续全零块 = 归档结束；其后只允许有限的填充（tar 常补齐到 10KB 记录）。
   *  填充字节同样计入总量上限：海量零块会先耗尽额度抛 ETOOLARGE，而不是无限解压。 */
  async function consumeTrailer() {
    let n = 0;
    while (true) {
      if (avail() === 0 && !(await rawNeed(1))) return;   // 流真正结束
      if (n >= EOF_TRAILER_MAX) throw badTar('归档结束标记后仍有多余数据（疑似解压炸弹）', 'EBADTAR');
      const cnt = Math.min(BLOCK, EOF_TRAILER_MAX - n, avail());
      drop(cnt);
      n += cnt;
      addConsumed(cnt);
    }
  }
  function cleanupExtracted() {
    for (const rel of result.files) {
      try { fs.unlinkSync(path.join(destDir, rel)); } catch { /* 忽略 */ }
    }
    const dirs = result.dirs.slice().sort((a, b) => b.split('/').length - a.split('/').length);
    for (const rel of dirs) {
      try { fs.rmdirSync(path.join(destDir, rel)); } catch { /* 忽略 */ }
    }
  }
  async function abortStream(out) {
    if (!out || out.destroyed || out.closed) return;
    await new Promise((res) => {
      out.once('close', res);
      out.once('error', () => { /* 由 close 收尾 */ });
      out.destroy();
    });
  }

  try {
    while (true) {
      if (!(await need(BLOCK))) break;
      const header = take(BLOCK);
      addConsumed(BLOCK);
      if (isZeroBlock(header)) {
        // 连续两个全零块即 tar 的结束标记；零块本身也要计入总量，防止全零 gzip 炸弹无限解压
        if (++zeroRun >= 2) { await consumeTrailer(); break; }
        continue;
      }
      zeroRun = 0;
      headers++;
      if (headers > maxEntries) throw badTar(`条目数超出上限 ${maxEntries}`, 'ETOOLARGE');
      assertHeaderChecksum(header);

      let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
      if (prefix) name = `${prefix}/${name}`;
      const type = String.fromCharCode(header[156]) || '0';
      let size = parseOctStrict(header.subarray(124, 136), '条目大小');
      let mtime = parseOct(header.subarray(136, 148));

      if (type === 'x' || type === 'g') {
        const data = await readPaxData(size, type === 'x' ? 'PAX 扩展头' : 'PAX 全局头');
        if (type === 'x') pendingPax = Object.assign(pendingPax || {}, decodePax(data));
        continue;
      }
      if (type === 'L') {
        const data = await readPaxData(size, 'GNU 长文件名');
        pendingPath = data.toString('utf8').replace(/\0.*$/, '');
        continue;
      }
      if (pendingPath) { name = pendingPath; pendingPath = null; }
      if (pendingPax) {
        if (pendingPax.path) name = pendingPax.path;
        if (pendingPax.size !== undefined) {
          if (!/^\d+$/.test(String(pendingPax.size))) throw badSize('PAX 条目大小', pendingPax.size);
          size = Number(pendingPax.size);
        }
        if (pendingPax.mtime !== undefined) {
          const n = parseInt(pendingPax.mtime, 10);
          if (Number.isFinite(n)) mtime = n;
        }
        pendingPax = null;
      }
      checkEntrySize(size, '条目数据');
      const dataTotal = size + zeroPad(size);

      const rel = sanitizeRel(name);
      if (rel === null) {
        // 拒绝 ../ 路径：只消费数据，不落盘
        await drain(dataTotal, '不安全的条目路径');
        continue;
      }
      if (!rel) {
        // 空条目名会让 target 变成 destDir 本身，直接跳过
        await drain(dataTotal, '空条目路径');
        continue;
      }
      const target = path.join(destDir, rel);

      if (type === '5') {
        ensureDir(target);
        result.dirs.push(rel);
        result.entries++;
        // 目录条目只建目录，不写数据；但 size>0 时同样必须消费掉，保持流对齐
        if (size > 0) await drain(dataTotal, '目录条目');
        continue;
      }
      if (type !== '0' && type !== '7' && type !== '\0' && type !== '') {
        // 符号链接/硬链接/设备文件等一律不落盘，仅消费数据
        await drain(dataTotal, '非普通文件条目');
        continue;
      }
      const allowed = filter ? filter(rel, { size, mtime }) !== false : true;
      if (!allowed) {
        await drain(dataTotal, '被过滤条目');
        continue;
      }

      ensureDir(path.dirname(target));
      currentTarget = target;
      const out = fs.createWriteStream(target);
      currentOut = out;
      let writeErr = null;
      out.on('error', (e) => { if (!writeErr) writeErr = e; });
      let written = 0;
      let remaining = size;
      while (remaining > 0) {
        if (writeErr) throw writeErr;
        if (avail() === 0) {
          if (!(await need(Math.min(remaining, 1 << 20)))) throw truncated('文件内容');
        }
        const cnt = Math.min(remaining, avail());
        const chunk = take(cnt);
        remaining -= cnt;
        written += cnt;
        addConsumed(cnt);
        await new Promise((res, rej) => {
          if (writeErr) return rej(writeErr);
          let done = false;
          const onDrain = () => { if (done) return; done = true; cleanup(); res(); };
          const onErr = (e) => { if (done) return; done = true; cleanup(); rej(e); };
          const cleanup = () => { out.removeListener('drain', onDrain); out.removeListener('error', onErr); };
          if (out.write(chunk)) { done = true; res(); }
          else { out.once('drain', onDrain); out.once('error', onErr); }
        });
      }
      // 关键校验：声明大小必须与实际写入字节数一致，避免「静默成功但内容被截断」
      if (written !== size) throw badTar(`条目 ${rel} 实际写入 ${written} 字节，声明为 ${size} 字节`, 'ETRUNCATED');
      if (writeErr) throw writeErr;
      await new Promise((res, rej) => {
        const onClose = () => { cleanup(); res(); };
        const onErr = (e) => { cleanup(); rej(e); };
        const cleanup = () => { out.removeListener('close', onClose); out.removeListener('error', onErr); };
        out.once('close', onClose);
        out.once('error', onErr);
        out.end();
      });
      currentOut = null;
      currentTarget = null;
      result.files.push(rel);
      result.entries++;
      result.bytes += written;
      if (onEntry) onEntry(rel, written);

      const pad = zeroPad(size);
      if (pad) {
        if (!(await need(pad))) throw truncated('条目对齐填充');
        drop(pad);
        addConsumed(pad);
      }
    }
    if (avail() > 0) throw truncated('归档尾部不完整');
    return result;
  } catch (e) {
    if (currentOut) { await abortStream(currentOut); currentOut = null; }
    if (currentTarget) {
      try { fs.unlinkSync(currentTarget); } catch { /* 忽略 */ }
      currentTarget = null;
    }
    cleanupExtracted();
    throw e;
  } finally {
    await close();
  }
}

/** 只读取某个条目的内容（用于快速读取 bundle 里的 manifest.json / tarball 里的 package.json） */
async function readTarEntry(file, wanted, opts = {}) {
  const {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxEntryBytes = READ_TAR_ENTRY_MAX_BYTES,
    maxPaxBytes = DEFAULT_MAX_PAX_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = opts;
  const want = sanitizeRel(wanted);
  if (want === null) throw badTar(`非法的条目名：${String(wanted)}`, 'EBADNAME');
  const reader = makeReader(openTarStream(file));
  const { take, drop, avail, close, need: rawNeed } = reader;
  let pendingPath = null;
  let pendingPax = null;
  let consumed = 0;
  let headers = 0;
  let zeroRun = 0;

  function addConsumed(n) {
    consumed += n;
    if (consumed > maxTotalBytes) throw badTar(`读取总字节超出上限 ${maxTotalBytes}`, 'ETOOLARGE');
  }
  /** 读取前先按剩余额度检查：额度不够时在真正解压前就失败，零块/元数据块同样受限 */
  async function need(n) {
    if (consumed + n > maxTotalBytes) throw badTar(`读取总字节超出上限 ${maxTotalBytes}`, 'ETOOLARGE');
    return rawNeed(n);
  }
  function checkEntrySize(size, what, cap = maxEntryBytes) {
    if (!Number.isSafeInteger(size) || size < 0) throw badSize(what, size);
    if (size > cap) throw badSize(`${what}（上限 ${cap}）`, size);
  }
  async function drain(n, what) {
    let remain = n;
    while (remain > 0) {
      if (avail() === 0) {
        if (!(await need(Math.min(remain, 1 << 20)))) throw truncated(what);
      }
      const cnt = Math.min(remain, avail());
      drop(cnt);
      remain -= cnt;
      addConsumed(cnt);
    }
  }
  async function readPaxData(size, what) {
    checkEntrySize(size, what, maxPaxBytes);
    if (!(await need(size))) throw truncated(what);
    const data = Buffer.from(take(size));
    const pad = zeroPad(size);
    if (pad) {
      if (!(await need(pad))) throw truncated(what);
      drop(pad);
    }
    addConsumed(size + pad);
    return data;
  }
  /** 两个连续全零块 = 归档结束；其后只允许有限的填充，且填充计入总量上限（同 extractTarGz） */
  async function consumeTrailer() {
    let n = 0;
    while (true) {
      if (avail() === 0 && !(await rawNeed(1))) return;   // 流真正结束
      if (n >= EOF_TRAILER_MAX) throw badTar('归档结束标记后仍有多余数据（疑似解压炸弹）', 'EBADTAR');
      const cnt = Math.min(BLOCK, EOF_TRAILER_MAX - n, avail());
      drop(cnt);
      n += cnt;
      addConsumed(cnt);
    }
  }

  try {
    while (true) {
      if (!(await need(BLOCK))) break;
      const header = take(BLOCK);
      addConsumed(BLOCK);
      if (isZeroBlock(header)) {
        // 连续两个全零块即归档结束；零块计入总量，避免全零归档无限解压
        if (++zeroRun >= 2) { await consumeTrailer(); break; }
        continue;
      }
      zeroRun = 0;
      headers++;
      if (headers > maxEntries) throw badTar(`条目数超出上限 ${maxEntries}`, 'ETOOLARGE');
      assertHeaderChecksum(header);

      let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
      if (prefix) name = `${prefix}/${name}`;
      const type = String.fromCharCode(header[156]) || '0';
      let size = parseOctStrict(header.subarray(124, 136), '条目大小');

      if (type === 'x' || type === 'g') {
        const data = await readPaxData(size, type === 'x' ? 'PAX 扩展头' : 'PAX 全局头');
        if (type === 'x') pendingPax = Object.assign(pendingPax || {}, decodePax(data));
        continue;
      }
      if (type === 'L') {
        const data = await readPaxData(size, 'GNU 长文件名');
        pendingPath = data.toString('utf8').replace(/\0.*$/, '');
        continue;
      }
      if (pendingPath) { name = pendingPath; pendingPath = null; }
      if (pendingPax) {
        if (pendingPax.path) name = pendingPax.path;
        if (pendingPax.size !== undefined) {
          if (!/^\d+$/.test(String(pendingPax.size))) throw badSize('PAX 条目大小', pendingPax.size);
          size = Number(pendingPax.size);
        }
        pendingPax = null;
      }
      checkEntrySize(size, '条目大小');
      const dataTotal = size + zeroPad(size);
      const rel = sanitizeRel(name);
      if (rel === want) {
        if (!(await need(size))) throw truncated('目标条目内容');
        const data = Buffer.from(take(size));
        addConsumed(size);
        return data;
      }
      await drain(dataTotal, '跳过的条目');
    }
    if (avail() > 0) throw truncated('归档尾部不完整');
    return null;
  } finally {
    await close();
  }
}

module.exports = {
  packTarGz, extractTarGz, readTarEntry, makeHeader, isZeroBlock,
  // 供测试/诊断使用
  checksumOf, sanitizeRel, parseOctStrict,
};
