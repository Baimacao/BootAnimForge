'use strict';
/**
 * zip.js — 极简 ZIP 写入器（DEFLATE 或 STORE），无外部依赖。
 *
 * 为什么自己写：bootanimation.zip 必须满足两个硬性要求
 *   1) 帧文件按顺序存放（Android 顺序读取）；
 *   2) 推荐「不压缩」(zip -0) —— PNG 本身已压缩，再压只会拖慢开机解包。
 * 通用 zip 库常常强制压缩或改变顺序，这里直接精确控制。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const crc32Init = () => 0;
const crc32Update = (seed, buf) => {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};
const crc32Final = (seed) => seed >>> 0;

/* ---------- DOS 时间 ---------- */
function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * @param {object} opts
 *   opts.file      输出路径
 *   opts.compress  false=STORE（推荐，等价 zip -0）；true=DEFLATE(level 6)
 */
function createZipWriter(opts) {
  const filePath = opts.file;
  const compress = !!opts.compress;
  const fd = fs.openSync(filePath, 'w');
  const entries = [];
  const { time: dosTime, date: dosDate } = dosDateTime();
  let offset = 0;
  let closed = false;

  function writeBuf(buf) {
    fs.writeSync(fd, buf);
    offset += buf.length;
  }

  /**
   * 添加一个条目。name 使用 '/' 分隔，不带前导斜杠。
   * @param {string} name
   * @param {Buffer|string} content
   */
  function add(name, content, opts = {}) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(raw);
    let stored = raw;
    let method = 0;
    // store=true 时强制不压缩：APK 里的 classes.dex 建议以 STORE 存放
    if (compress && !opts.store && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) { stored = deflated; method = 8; }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 name
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localOffset = offset;
    writeBuf(local);
    writeBuf(nameBuf);
    writeBuf(stored);

    entries.push({
      name: nameBuf, crc, method, dosTime, dosDate,
      compressedSize: stored.length, uncompressedSize: raw.length, localOffset,
    });
    return { name, bytes: stored.length, rawBytes: raw.length };
  }

  function finish() {
    if (closed) return { file: filePath, entries: entries.length, bytes: offset };
    const cdStart = offset;
    for (const e of entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);          // version made by
      h.writeUInt16LE(20, 6);          // version needed
      h.writeUInt16LE(0x0800, 8);      // UTF-8
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dosTime, 12);
      h.writeUInt16LE(e.dosDate, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressedSize, 20);
      h.writeUInt32LE(e.uncompressedSize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(0, 30);          // extra len
      h.writeUInt16LE(0, 32);          // comment len
      h.writeUInt16LE(0, 34);          // disk number
      h.writeUInt16LE(0, 36);          // internal attrs
      h.writeUInt32LE(0, 38);          // external attrs
      h.writeUInt32LE(e.localOffset, 42);
      writeBuf(h);
      writeBuf(e.name);
    }
    const cdSize = offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    writeBuf(end);
    fs.closeSync(fd);
    closed = true;
    return { file: filePath, entries: entries.length, bytes: offset };
  }

  function abort() {
    if (!closed) { try { fs.closeSync(fd); } catch { /* ignore */ } closed = true; }
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }

  return { add, finish, abort, get offset() { return offset; } };
}

/**
 * 校验 zip：读中央目录，确认结构完整、条目按序、必需文件存在。
 *
 * 注意「必需文件」随产物类型不同：
 *   · bootanimation.zip（传统格式）必须有 desc.txt
 *   · Magisk 模块 zip 里没有 desc.txt，它的关键是 system/… 下的载荷、module.prop
 * 所以这里不做硬编码假设，由调用方通过 opts.require 指定。
 *
 * @param {string} filePath
 * @param {{require?: string[]|null}} [opts] require 为 null 时只做结构校验
 * @returns {Promise<{ok:boolean, entries:number, hasDesc:boolean, order:boolean, names:string[], errors:string[], missing:string[]}>}
 */
async function verifyZip(filePath, opts = {}) {
  const errors = [];
  const buf = await fsp.readFile(filePath);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, entries: 0, hasDesc: false, order: false, names: [], errors: ['找不到 ZIP 结束记录（EOCD）'], missing: [] };
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) errors.push('中央目录越界');

  const names = [];
  let p = cdOff;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { errors.push(`第 ${i} 条目签名错误`); break; }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;
  }

  const hasDesc = names.includes('desc.txt');
  const require = opts.require === undefined ? ['desc.txt'] : opts.require;
  const missing = [];
  for (const need of require || []) {
    if (!names.includes(need)) { missing.push(need); errors.push(`zip 内缺少 ${need}`); }
  }

  // 顺序检查：同一 part 目录下的帧编号必须递增
  let order = true;
  const byDir = new Map();
  for (const n of names) {
    const i = n.lastIndexOf('/');
    if (i < 0) continue;
    const dir = n.slice(0, i);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(n.slice(i + 1));
  }
  for (const [dir, files] of byDir) {
    const nums = files
      .map((f) => (f.match(/(\d+)(?=\.[a-z0-9]+$)/i) || [])[1])
      .filter((x) => x !== undefined)
      .map(Number);
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1] + 1) { order = false; errors.push(`${dir} 帧编号不连续: ${nums[i - 1]} → ${nums[i]}`); break; }
    }
  }
  return { ok: errors.length === 0, entries: count, hasDesc, order, names, errors, missing };
}

/**
 * 读取 zip 内容（STORE / DEFLATE 都支持）。用于自检与「解包已有 bootanimation」。
 * @returns {Promise<Map<string, Buffer>>}
 */
async function readZip(filePath) {
  const buf = await fsp.readFile(filePath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);

  const out = new Map();
  let p = cdOff;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 本地头里的 extra 长度可能和中央目录不同，必须重新读
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);

    if (rawSize !== data.length) throw new Error(`${name} 解压大小不符：期望 ${rawSize}，实际 ${data.length}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** 只读一个条目 */
async function readZipEntry(filePath, name) {
  const all = await readZip(filePath);
  return all.get(name) || null;
}

module.exports = { createZipWriter, verifyZip, readZip, readZipEntry, crc32, crc32Init, crc32Update, crc32Final };
