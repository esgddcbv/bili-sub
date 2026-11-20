#!/usr/bin/env node
/**
 * publish.mjs —— 一键发到 GitHub（需要个人令牌）
 *
 * 用法：
 *   node publish.mjs --token ghp_xxx --user 你的账号 --repo bili-sub [--public]
 *
 * 做三件事：
 *   1) POST /user/repos 建仓库（已存在就跳过）
 *   2) git remote add origin https://<token>@github.com/<user>/<repo>.git
 *   3) git push -u origin HEAD
 *
 * 令牌只需要 repo 权限（fine-grained：Contents: Read and write + Administration: Read and write）。
 * 令牌不要写进文件、不要提交进仓库。
 */

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}
const token = opt.token;
const user = opt.user;
const repo = opt.repo || 'bili-sub';
if (!token || !user) {
  console.error('用法：node publish.mjs --token <token> --user <github 用户名> [--repo bili-sub] [--public]');
  process.exit(1);
}

const api = async (path, method = 'GET', body = null) => {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bili-sub-publish',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: r.ok, status: r.status, json, text };
};

const who = await api('/user');
if (!who.ok) { console.error('令牌无效：', who.status, who.text.slice(0, 200)); process.exit(1); }
console.log('登录为：', who.json.login);

const exists = await api(`/repos/${user}/${repo}`);
if (exists.ok) {
  console.log('仓库已存在，跳过创建：', exists.json.html_url);
} else {
  const made = await api('/user/repos', 'POST', {
    name: repo,
    description: 'B站 AI 字幕取件与验真 + 帧网格抽帧：给 AI agent 用的「看视频」工具',
    private: !opt.public,
    has_issues: true,
    has_wiki: false,
    license_template: 'mit',
  });
  if (!made.ok) { console.error('建仓库失败：', made.status, made.text.slice(0, 300)); process.exit(1); }
  console.log('已建仓库：', made.json.html_url);
}

const remote = `https://${token}@github.com/${user}/${repo}.git`;
try { execFileSync('git', ['remote', 'remove', 'origin'], { stdio: 'ignore' }); } catch {}
execFileSync('git', ['remote', 'add', 'origin', remote], { stdio: 'inherit' });
execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { stdio: 'inherit' });
console.log(`\n完成：https://github.com/${user}/${repo}`);
console.log('提醒：remote 里带着令牌，别把 .git/config 发出去；用完可以 git remote set-url origin https://github.com/<user>/<repo>.git');
