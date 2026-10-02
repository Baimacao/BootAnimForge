'use strict';
/**
 * release.js — 打 tag、建 Release、上传资产
 *
 *   node tools/release.js --tag v1.0.0 --notes docs/release-notes-v1.0.0.md --asset dist/xxx.zip
 *
 * 说明：本机 github.com 与 raw.githubusercontent.com 不通，但 api.github.com 与
 * 资产存储域名可用，所以上传走 API（上传地址由 API 返回的 upload_url 决定）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { loadToken, gh } = require('./gh.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const OWNER = argOf('--owner', 'Baimacao');
const REPO = argOf('--repo', 'BootAnimForge');
const TAG = argOf('--tag');
const NOTES_FILE = argOf('--notes');
const ASSETS = argv.reduce((acc, a, i) => (a === '--asset' && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);
const TITLE = argOf('--title');

async function main() {
  if (!TAG) throw new Error('需要 --tag，例如 --tag v1.0.0');
  const { token, from } = loadToken();
  if (!token) throw new Error('未找到 GitHub 凭据');
  console.log(`凭据来源：${from}`);

  const repo = await gh(token, 'GET', `/repos/${OWNER}/${REPO}`);
  const branch = repo.default_branch || 'main';
  const ref = await gh(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
  const sha = ref.object.sha;
  console.log(`目标：${OWNER}/${REPO}@${branch} (${sha.slice(0, 10)})`);

  // 1. tag
  try {
    await gh(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${TAG}`);
    console.log(`tag ${TAG} 已存在，跳过创建`);
  } catch (e) {
    if (e.status !== 404) throw e;
    await gh(token, 'POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${TAG}`, sha });
    console.log(`已创建 tag ${TAG} → ${sha.slice(0, 10)}`);
  }

  // 2. Release
  let body = '';
  if (NOTES_FILE) {
    try { body = await fsp.readFile(path.resolve(ROOT, NOTES_FILE), 'utf8'); }
    catch { console.log(`（读不到 ${NOTES_FILE}，使用默认说明）`); }
  }
  if (!body) {
    body = `见仓库 [README](https://github.com/${OWNER}/${REPO}#readme)。\n\n` +
      `**首次运行会自动下载 ffmpeg 运行时**（约 115 MB）。\n` +
      `下面的 portable 包已经内置引擎，解压即用。`;
  }

  let release = null;
  try {
    release = await gh(token, 'GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log('Release 已存在，将复用');
  } catch (e) {
    if (e.status !== 404) throw e;
    release = await gh(token, 'POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      name: TITLE || `BootAnimForge ${TAG}`,
      body,
      draft: false,
      prerelease: false,
    });
    console.log(`已创建 Release：${release.html_url}`);
  }

  // 3. 上传资产
  for (const a of ASSETS) {
    const p = path.resolve(ROOT, a);
    if (!fs.existsSync(p)) { console.log(`跳过（不存在）：${a}`); continue; }
    const name = path.basename(p);
    const exists = (release.assets || []).find((x) => x.name === name);
    if (exists) {
      console.log(`资产 ${name} 已存在，先删除旧的上传…`);
      await gh(token, 'DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${exists.id}`);
    }
    const buf = await fsp.readFile(p);
    const uploadBase = String(release.upload_url).replace(/\{.*$/, '');
    const url = `${uploadBase}?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/zip',
        'Content-Length': String(buf.length),
        'User-Agent': 'BootAnimForge',
      },
      body: buf,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`上传 ${name} 失败：${res.status} ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    console.log(`已上传资产 ${j.name}（${(j.size / 1048576).toFixed(1)} MB）`);
  }

  // 4. 核对
  const final = await gh(token, 'GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  console.log('\n=== Release 核对 ===');
  console.log(`tag：${final.tag_name}`);
  console.log(`标题：${final.name}`);
  console.log(`状态：${final.draft ? '草稿' : '已发布'}${final.prerelease ? '（预发布）' : ''}`);
  for (const a of final.assets || []) {
    console.log(`  资产：${a.name}  ${(a.size / 1048576).toFixed(1)} MB  state=${a.state}`);
  }
  console.log(`地址：${final.html_url}`);
  console.log('\n注意：本机 github.com 不通，资产直链无法在本地验证；' +
    '这里只是通过 API 确认了 size 与 state（uploaded 表示已入库）。');
}

main().catch((e) => {
  console.error('发布失败：', e.message);
  if (e.data) console.error(JSON.stringify(e.data).slice(0, 400));
  process.exit(1);
});
