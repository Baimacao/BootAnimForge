'use strict';
/**
 * publish.js — 把项目发布到 GitHub（只用 REST API，不需要 git 命令行）
 *
 *   node tools/publish.js --dry-run          只列出将要上传的文件
 *   node tools/publish.js                    创建/更新仓库并推送 main
 *   node tools/publish.js --repo Name        指定仓库名（默认 BootAnimForge）
 *   node tools/publish.js --tag v1.0.0       额外打 tag 并发 Release
 *
 * 凭据来源见 tools/gh.js（环境变量 → $DSH_HOME/.env → $DSH_HOME/.github-token）。
 * 绝不会把 token 写进任何文件。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { loadToken, gh, whoami, getRepo, createRepo } = require('./gh.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const argOf = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const REPO = argOf('--repo', 'BootAnimForge');
const TAG = argOf('--tag', '');
const BRANCH = argOf('--branch', 'main');
const DESCRIPTION = '把 MP4 等视频转成安卓开机动画（bootanimation.zip）的 Windows 工具：Material Design 3 界面、零依赖 Node 引擎、支持 Android 12+ 视频版格式与 Magisk 模块一键生成';

/* 要发布的文件：显式白名单，比"排除法"安全（不会误传 runtime/、output/、.work/） */
const INCLUDE_DIRS = ['src', 'public', 'tools', 'docs'];
const INCLUDE_ROOT = ['README.md', 'LICENSE', '.gitignore', 'package.json', '启动.cmd'];
/** 二进制/大文件：走 blob API（base64），其余走文本 blob */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.exe']);

async function collect() {
  const files = [];
  for (const name of INCLUDE_ROOT) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(p);
  }
  async function walk(dir) {
    let items = [];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (['node_modules', '.work', 'output', 'runtime', '.git'].includes(it.name)) continue;
        await walk(p);
      } else if (it.isFile()) {
        files.push(p);
      }
    }
  }
  for (const d of INCLUDE_DIRS) await walk(path.join(ROOT, d));
  return files;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

async function main() {
  const { token, from } = loadToken();
  if (!token) throw new Error('未找到 GitHub 凭据');
  console.log(`凭据来源：${from}`);

  const files = await collect();
  files.sort();
  let total = 0;
  for (const f of files) total += fs.statSync(f).size;
  console.log(`待上传 ${files.length} 个文件，合计 ${(total / 1024).toFixed(0)} KB`);
  if (DRY) {
    for (const f of files) console.log(`  ${rel(f)}  (${fs.statSync(f).size} B)`);
    console.log('\n--dry-run：未做任何写操作');
    return;
  }

  const me = await whoami(token);
  const owner = me.login;
  console.log(`账号：${owner}`);

  let repo = await getRepo(token, owner, REPO);
  if (!repo) {
    console.log(`创建仓库 ${owner}/${REPO} …`);
    repo = await createRepo(token, { name: REPO, description: DESCRIPTION });
    console.log(`已创建：${repo.html_url}`);
  } else {
    console.log(`仓库已存在：${repo.html_url}`);
  }
  const branch = repo.default_branch || BRANCH;

  /* --- 0. 空仓库需要先有一个提交：git/blobs 在空仓库上会返回 409 --- */
  try {
    const ref = await gh(token, 'GET', `/repos/${owner}/${REPO}/git/ref/heads/${branch}`);
    if (!ref?.object?.sha) throw Object.assign(new Error('empty'), { status: 404 });
  } catch (e) {
    // 空仓库：GitHub 对 ref 查询返回 409 "Git Repository is empty."
    if (e.status === 404 || e.status === 409 || e.message === 'empty') {
      console.log('仓库为空，先建立一个初始提交…');
      await gh(token, 'PUT', `/repos/${owner}/${REPO}/contents/README.md`, {
        message: 'chore: 初始化仓库',
        content: Buffer.from('# BootAnimForge\n\n正在写入项目文件…\n', 'utf8').toString('base64'),
        branch,
      });
    } else throw e;
  }

  /* --- 1. 逐文件建 blob --- */
  const tree = [];
  let done = 0;
  for (const f of files) {
    const name = rel(f);
    const buf = await fsp.readFile(f);
    const isBinary = BINARY_EXT.has(path.extname(f).toLowerCase());
    const blob = await gh(token, 'POST', `/repos/${owner}/${REPO}/git/blobs`, isBinary
      ? { content: buf.toString('base64'), encoding: 'base64' }
      : { content: buf.toString('utf8'), encoding: 'utf-8' });
    tree.push({ path: name, mode: '100644', type: 'blob', sha: blob.sha });
    done++;
    if (done % 10 === 0 || done === files.length) process.stdout.write(`\r  已上传 ${done}/${files.length} 个 blob`);
  }
  process.stdout.write('\n');

  /* --- 2. 建 tree --- */
  const newTree = await gh(token, 'POST', `/repos/${owner}/${REPO}/git/trees`, { tree });
  console.log(`已建 tree：${newTree.sha.slice(0, 10)}（${tree.length} 项）`);

  /* --- 3. 建 commit --- */
  let parents = [];
  try {
    const ref = await gh(token, 'GET', `/repos/${owner}/${REPO}/git/ref/heads/${branch}`);
    parents = [ref.object.sha];
  } catch (e) { if (e.status !== 404) throw e; }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const message = parents.length
    ? `chore: 同步本地版本（${stamp}）\n\n包含 Android 12+ 视频版格式、Magisk 模块生成、MD3 动效优化`
    : `feat: BootAnimForge —— MP4 转安卓开机动画（${stamp}）\n\nMaterial Design 3 界面 · 零依赖 Node 引擎 · 永不拉伸 · 分段循环 · 视频版格式 · Magisk 模块`;
  const commit = await gh(token, 'POST', `/repos/${owner}/${REPO}/git/commits`, {
    message, tree: newTree.sha, parents,
  });
  console.log(`已建 commit：${commit.sha.slice(0, 10)}`);

  /* --- 4. 更新分支引用（先尝试更新，不存在则创建） --- */
  if (parents.length) {
    await gh(token, 'PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  } else {
    await gh(token, 'POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  console.log(`已更新 ${branch} → ${commit.sha.slice(0, 10)}`);

  /* --- 5. 可选：打 tag + Release --- */
  if (TAG) {
    try {
      await gh(token, 'POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/tags/${TAG}`, sha: commit.sha });
      console.log(`已打 tag：${TAG}`);
    } catch (e) {
      if (e.status === 422) console.log(`tag ${TAG} 已存在，跳过`);
      else throw e;
    }
    try {
      const rel = await gh(token, 'POST', `/repos/${owner}/${REPO}/releases`, {
        tag_name: TAG, name: `BootAnimForge ${TAG}`,
        body: `见 [README](https://github.com/${owner}/${REPO}#readme)。\n\n` +
          `首次运行会由启动器自动下载 ffmpeg 运行时，仓库本身不含二进制。`,
        draft: false, prerelease: false,
      });
      console.log(`已发布 Release：${rel.html_url}`);
    } catch (e) {
      if (e.status === 422) console.log('Release 已存在，跳过');
      else throw e;
    }
  }

  /* --- 6. 校验：远端 tree 与本地文件列表逐项比对 --- */
  const remote = await gh(token, 'GET', `/repos/${owner}/${REPO}/git/trees/${branch}?recursive=1`);
  const remotePaths = new Set((remote.tree || []).filter((t) => t.type === 'blob').map((t) => t.path));
  const localPaths = new Set(files.map(rel));
  const missing = [...localPaths].filter((p) => !remotePaths.has(p));
  const extra = [...remotePaths].filter((p) => !localPaths.has(p));
  console.log('\n=== 一致性核对 ===');
  console.log(`远端 blob 数：${remotePaths.size}，本地文件数：${localPaths.size}`);
  console.log(missing.length ? `✗ 远端缺少：${missing.join('、')}` : '✓ 本地文件全部在远端');
  console.log(extra.length ? `· 远端多出：${extra.join('、')}` : '✓ 远端没有多余文件');

  console.log(`\n仓库地址：${repo.html_url}`);
  if (missing.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n发布失败：', e.message);
  if (e.data) console.error(JSON.stringify(e.data).slice(0, 500));
  process.exit(1);
});
