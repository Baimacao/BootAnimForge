'use strict';
/**
 * gh-probe.js — 只读探测：token 身份与权限，不做任何写操作
 */
const { loadToken, whoami, getRepo } = require('./gh.js');

(async () => {
  const { token, from } = loadToken();
  if (!token) { console.log('未找到凭据'); process.exit(1); }
  console.log(`凭据来源：${from}`);
  console.log(`token 长度：${token.length}，前缀：${token.slice(0, 4)}…`);

  const me = await whoami(token);
  console.log(`账号：${me.login}（${me.name || '未设置昵称'}）`);
  console.log(`经典 PAT 权限范围：${me.scopes.length ? me.scopes.join(', ') : '（无此头，可能是 fine-grained token）'}`);
  console.log('仓库列表（前 12 个）：');
  const repos = await require('./gh.js').gh(token, 'GET', '/user/repos?per_page=12&sort=updated');
  for (const r of repos) console.log(`  - ${r.full_name}  ${r.private ? '[私有]' : '[公开]'}  ${r.default_branch}`);

  for (const name of ['BootAnimForge', 'bootanimforge']) {
    const r = await getRepo(token, me.login, name);
    console.log(`检查 ${me.login}/${name}：${r ? '已存在' : '不存在'}`);
  }
})().catch((e) => { console.error('探测失败：', e.message); process.exit(2); });
