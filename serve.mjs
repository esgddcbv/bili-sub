#!/usr/bin/env node
/**
 * bili-frame / serve.mjs —— 接收页面里导出的「帧网格」并落盘
 *
 * 为什么要有它：<video> 的像素只在页面里能读（blob/MSE 源，外面拿不到），
 * 所以抽帧必须在页面里做；做完之后要落地，不能靠页面触发下载（路径不可控）。
 * 做法：页面把 dataURL 用 text/plain POST 到本机 127.0.0.1，这边解 base64 写文件。
 *
 * 用法：
 *   node serve.mjs --port 7788 --out D:\知识库\99_原始字幕\_frames
 *   然后浏览器里 evaluate 运行 grid.js 那段（见 README）。
 *
 * 另有 POST /text：页面里取到的字幕文本直接回传（含 bvid/title/part/secs），
 * 由这边写成 .txt + .meta.json —— 这样不必把 auth_key 抄出来，也就没有过期问题。
 *
 * 只监听 127.0.0.1，只接受 /frames、/text 的 POST 与 /health 的 GET。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
}

const PORT = Number(opt.port || 7788);
const OUT = path.resolve(opt.out || './frames');
fs.mkdirSync(OUT, { recursive: true });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(s);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.url === '/health') return json(res, 200, { ok: true, out: OUT });

  if (req.method === 'POST' && req.url === '/frames') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => { body += d; if (body.length > 40e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, dataUrl } = JSON.parse(body);
        const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl || '');
        if (!m) return json(res, 400, { error: 'dataUrl 不是 image/png 或 image/jpeg' });
        const buf = Buffer.from(m[2], 'base64');
        const safe = String(name || 'grid').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
        const file = path.join(OUT, `${safe}_${Date.now()}.${m[1] === 'png' ? 'png' : 'jpg'}`);
        fs.writeFileSync(file, buf);
        console.log(`[saved] ${file} (${buf.length} bytes)`);
        json(res, 200, { ok: true, file, bytes: buf.length });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // 页面只把 URL 递过来，真正下载在这边做：aisubtitle 那个域没有 CORS，
  // 页面里 fetch 会 "Failed to fetch"，但 auth_key 在 URL 里就够用，不需要 cookie。
  if (req.method === 'POST' && req.url === '/pull') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { kind = 'sub', bvid = '', title = '', part = '', secs = 0, lan = 'ai-zh', url = '' } = JSON.parse(body);
        if (!url) return json(res, 400, { error: 'url 为空' });
        const target = url.startsWith('//') ? 'https:' + url : url;
        const r = await fetch(target, { headers: { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return json(res, 502, { error: '下载失败 HTTP ' + r.status });
        const j = await r.json();
        const text = (j.body || []).map(x => x.content).join('');
        if (text.length < 20) return json(res, 400, { error: '字幕是空的', chars: text.length });
        const safe = String(title || bvid).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
        const base = kind === 'danmaku' ? `${safe}_弹幕` : safe;
        fs.writeFileSync(path.join(OUT, `${base}.txt`), text, 'utf8');
        fs.writeFileSync(path.join(OUT, `${base}.meta.json`), JSON.stringify({
          bvid, title, page: 1, part, secs: Number(secs) || 0, lan, chars: text.length,
          source: 'pulled', savedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
        console.log(`[pulled] ${base}.txt (${text.length} 字)`);
        json(res, 200, { ok: true, chars: text.length, head: text.slice(0, 30) });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/text') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => { body += d; if (body.length > 40e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { kind = 'sub', bvid = '', title = '', part = '', secs = 0, lan = 'ai-zh', text = '' } = JSON.parse(body);
        if (!text || text.length < 20) return json(res, 400, { error: 'text 太短，可能是空字幕' });
        const safe = String(title || bvid).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
        const base = kind === 'danmaku' ? `${safe}_弹幕` : safe;
        const txt = path.join(OUT, `${base}.txt`);
        fs.writeFileSync(txt, text, 'utf8');
        fs.writeFileSync(path.join(OUT, `${base}.meta.json`), JSON.stringify({
          bvid, title, page: 1, part, secs: Number(secs) || 0, lan, chars: text.length,
          source: kind === 'danmaku' ? 'danmaku' : 'in-page', savedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
        console.log(`[saved] ${txt} (${text.length} 字)`);
        json(res, 200, { ok: true, file: txt, chars: text.length });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bili-frame serve 已启动：http://127.0.0.1:${PORT}  输出目录：${OUT}`);
  console.log('页面里运行 grid.js（或用 evaluate 贴同一段），POST /frames 即落盘。');
});
