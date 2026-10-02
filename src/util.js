'use strict';
/**
 * util.js — 通用小工具（无外部依赖）
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

/** 生成短 id */
function uid(prefix = '') {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 12);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 解析整数，失败返回 fallback */
function int(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 解析浮点，失败返回 fallback */
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
  return fallback;
}

/** 秒 → 00:12.34 */
function fmtTime(sec) {
  const s = Math.max(0, num(sec, 0));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
}

/** 字节 → 人类可读 */
function fmtBytes(bytes) {
  const b = Math.max(0, num(bytes, 0));
  if (b < 1024) return `${b.toFixed(0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** 递归删除（忽略错误） */
async function rmrf(p) {
  if (!p) return;
  try {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* ignore */ }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function existsSync(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 文件名安全化 */
function safeName(name, fallback = 'output') {
  const base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base || fallback;
}

/** 独占用端口检测用：把 URL 里的 host 换成 127.0.0.1 */
function localUrl(port, pathname = '/') {
  return `http://127.0.0.1:${port}${pathname}`;
}

/** 读取环境变量 / 本地 token 文件（本项目暂未用到，保留给将来的发布脚本） */
function readEnv(name) {
  return process.env[name] || '';
}

/** 把 ffmpeg 风格的 `key=value` 进度块解析为对象 */
function parseProgressBlock(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** 人类可读的错误：把 Error/字符串/对象统一成 {message} */
function errInfo(e) {
  if (!e) return { message: '未知错误' };
  if (typeof e === 'string') return { message: e };
  const message = e.message || String(e);
  return { message, code: e.code, stderr: e.stderr ? String(e.stderr).slice(-4000) : undefined };
}

module.exports = {
  uid, clamp, int, num, bool,
  fmtTime, fmtBytes,
  rmrf, ensureDir, exists, existsSync,
  safeName, localUrl, readEnv,
  parseProgressBlock, errInfo,
  os,
};
