'use strict';
/**
 * gh.js — 用已配置的凭据调用 GitHub API（无第三方依赖）
 *
 * 凭据来源顺序（见 $DSH_HOME/AGENTS.md）：
 *   1. 环境变量 GITHUB_TOKEN / GH_TOKEN
 *   2. $DSH_HOME/.env
 *   3. $DSH_HOME/.github-token
 * 绝不把 token 写进任何入库文件。
 */

const fs = require('fs');
const path = require('path');

function loadToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env && env.trim()) return { token: env.trim(), from: 'env' };

  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const envFile = path.join(home, '.env');
  try {
    const txt = fs.readFileSync(envFile, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(GITHUB_TOKEN|GH_TOKEN)\s*=\s*(.+?)\s*$/);
      if (m) {
        const v = m[2].replace(/^["']|["']$/g, '').trim();
        if (v) return { token: v, from: envFile };
      }
    }
  } catch { /* 没有 .env */ }

  const tokenFile = path.join(home, '.github-token');
  try {
    const v = fs.readFileSync(tokenFile, 'utf8').trim();
    if (v) return { token: v, from: tokenFile };
  } catch { /* 没有 token 文件 */ }

  return { token: '', from: null };
}

const API = 'https://api.github.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 5xx / 429 / 网络抖动都值得重试（GitHub 偶发 504） */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function ghOnce(token, method, apiPath, body) {
  const res = await fetch(API + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BootAnimForge',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || res.statusText;
    const err = new Error(`GitHub ${method} ${apiPath} → ${res.status} ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 带退避重试的 API 调用 */
async function gh(token, method, apiPath, body, { retries = 4, raw = false } = {}) {
  void raw;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ghOnce(token, method, apiPath, body);
    } catch (e) {
      lastErr = e;
      const retryable = RETRYABLE.has(e.status) || /fetch failed|ECONNRESET|ETIMEDOUT|terminated/i.test(e.message);
      if (!retryable || attempt === retries) throw e;
      const wait = Math.min(8000, 600 * Math.pow(2, attempt));
      console.log(`  · ${method} ${apiPath} 失败（${e.status || e.message}），${wait}ms 后重试 ${attempt + 1}/${retries}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** 查询 token 身份与权限范围 */
async function whoami(token) {
  const user = await gh(token, 'GET', '/user');
  let scopes = [];
  try {
    const res = await fetch(`${API}/user`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'BootAnimForge' },
    });
    const h = res.headers.get('x-oauth-scopes');
    if (h) scopes = h.split(',').map((s) => s.trim()).filter(Boolean);
  } catch { /* fine-grained token 没有这个头 */ }
  return { login: user.login, name: user.name, scopes, publicRepos: user.public_repos };
}

async function getRepo(token, owner, repo) {
  try { return await gh(token, 'GET', `/repos/${owner}/${repo}`); } catch (e) { if (e.status === 404) return null; throw e; }
}

async function createRepo(token, { name, description, homepage = '', isPrivate = false }) {
  return gh(token, 'POST', '/user/repos', {
    name, description, homepage, private: isPrivate,
    has_issues: true, has_wiki: false, has_projects: false,
    auto_init: false,
  });
}

module.exports = { loadToken, gh, whoami, getRepo, createRepo, API };
