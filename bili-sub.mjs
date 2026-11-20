#!/usr/bin/env node
/**
 * bili-sub v2 —— B 站 AI 字幕取件与验真工具
 *
 * 它解决一件事：B 站 /x/player/v2 返回的 AI 字幕经常是别人的视频。
 * 做法不是换接口，而是「拿来之后验一遍」，v2 加了三条证据：
 *   1) 标题 / 分P名 的中文 2-gram 命中率
 *   2) 标题里最长的那个中文段（防长标题稀释）单独算一次命中率
 *   3) 弹幕（comment.bilibili.com/{cid}.xml，匿名可取）——弹幕里喊的往往就是这门课
 * 再加「字数 ÷ 时长」看像不像口播。
 *
 * 用法：
 *   node bili-sub.mjs probe BV1xxxx                    # 标题、分P、cid、时长（不需要登录）
 *   node bili-sub.mjs probe BV1xxxx --danmaku          # 附带弹幕样本
 *   node bili-sub.mjs fetch BV1xxxx --urls urls.json --out D:\知识库\99_原始字幕
 *   node bili-sub.mjs fetch BV1xxxx --cookie "SESSDATA=...; bili_jct=..." --out ...
 *   node bili-sub.mjs verify --dir D:\知识库\99_原始字幕   # 批量复核已存的字幕，出 CSV
 *   node bili-sub.mjs verify BV1xxxx --file 99_原始字幕\x.txt --secs 720
 *   node bili-sub.mjs batch --lines urls.tsv --out 99_原始字幕
 *
 * urls.json 的结构（collector.js 生成）：[{lan,lan_doc,url}]
 * urls.tsv 五列：bvid \t title \t part \t secs \t url
 * 退出码：0 成功；1 参数错；2 全部候选验真失败；3 拿不到候选。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

const RATE_MIN = 60, RATE_MAX = 600;   // 字/分：正常口播落在这之间
const HIT_MIN = 0.22;                  // 标题词命中率下限
const DM_HIT_MIN = 0.30;               // 弹幕命中率下限（够高才敢当救命证据）

function die(msg, code = 1) { console.error(msg); process.exit(code); }

const HDR = { 'User-Agent': UA, Referer: REF };

async function jget(url) {
  const r = await fetch(url, { headers: HDR });
  const t = await r.text();
  if (!t.trim().startsWith('{')) throw new Error('返回的不是 JSON（可能被反爬挡成 HTML）: ' + url.slice(0, 80));
  return JSON.parse(t);
}

async function tget(url) {
  const r = await fetch(url, { headers: HDR });
  return await r.text();
}

/** 从视频页 HTML 取标题（匿名可取；比 --title 手塞可靠） */
async function fetchTitle(bv) {
  try {
    const html = await tget(`https://www.bilibili.com/video/${bv}/`);
    const m = html.match(/<title>([^<]*)<\/title>/);
    if (!m) return null;
    return m[1].replace(/_哔哩哔哩_bilibili\s*$/, '').replace(/&amp;/g, '&').trim();
  } catch { return null; }
}

/** 弹幕（raw deflate，匿名可取）。失败返回 null。 */
async function fetchDanmaku(cid, cap = 200000) {
  try {
    const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: HDR });
    const buf = Buffer.from(await r.arrayBuffer());
    let xml;
    try { xml = zlib.inflateRawSync(buf).toString('utf8'); }
    catch { xml = buf.toString('utf8'); }               // 偶尔是明文
    const out = [];
    const re = /<d p="[^"]*">([\s\S]*?)<\/d>/g;
    let m, n = 0;
    while ((m = re.exec(xml)) && n < cap) {
      out.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
      n += m[1].length;
    }
    return out.join(' ');
  } catch { return null; }
}

function grams(s) {
  const clean = String(s || '')
    .replace(/[【】\[\]（）()《》<>·—\-—_\/\\|,，。.、!！?？:："'“”‘’…~]/g, ' ')
    .replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/** 标题（含分P名）的 2-gram 有多少出现在正文里 */
function titleHit(titleText, transcript) {
  const T = grams(titleText);
  if (!T.size) return 0;
  const body = String(transcript || '');
  let hit = 0;
  for (const g of T) if (body.includes(g)) hit++;
  return hit / T.size;
}

/** 最长的那个中文段（长标题被括注稀释时救回来） */
function longestSeg(text) {
  const segs = String(text || '').split(/[【】\[\]（）()《》<>·—\-—_\/\\|,，。.、!！?？:："'“”‘’…~\s]+/)
    .map(s => s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')).filter(s => s.length >= 4);
  segs.sort((a, b) => b.length - a.length);
  return segs[0] || '';
}

function segHit(titleText, transcript) {
  const seg = longestSeg(titleText);
  if (!seg) return 0;
  return titleHit(seg, transcript);
}

/** 抽查正文里是否出现标题中的拉丁词（≥3 字母），比如 seedance */
function latinHit(titleText, transcript) {
  const tokens = (String(titleText).match(/[A-Za-z]{3,}/g) || []).map(s => s.toLowerCase());
  if (!tokens.length) return null;
  const body = String(transcript || '').toLowerCase();
  return tokens.filter(t => body.includes(t)).length / tokens.length;
}

function rate(chars, secs) {
  if (!secs) return null;
  return chars / (secs / 60);
}

/** 判真伪。返回 score/hit/seg/eff/dm/chars/rpm/ok/reasons/explain */
function judge({ title, part, duration, transcript, danmaku = null }) {
  const text = (title + ' ' + (part || '')).trim();
  const body = String(transcript || '');
  const hit = titleHit(text, body);
  const seg = segHit(text, body);
  const eff = Math.max(hit, seg);                 // 两条标题证据取高的那条
  const lh = latinHit(text, body);
  const dm = danmaku ? Math.max(titleHit(text, danmaku), segHit(text, danmaku)) : null;
  const chars = body.length;
  const rpm = rate(chars, duration);
  const reasons = [];
  const toks = [...new Set((text.match(/[\u4e00-\u9fa5]{2}/g) || []))];
  const strong = toks.filter(t => body.split(t).length - 1 >= 3).length;
  let ok = true;

  if (chars < 200) { ok = false; reasons.push(`只有 ${chars} 字，不足 200`); }
  if (rpm !== null && (rpm < RATE_MIN || rpm > RATE_MAX)) {
    ok = false;
    reasons.push(`语速 ${rpm.toFixed(0)} 字/分 不在 ${RATE_MIN}–${RATE_MAX}（像音乐、静音或别的视频）`);
  }
  if (eff < HIT_MIN) {
    const rescuedBy = strong >= 2 ? '主题词反复出现' : (dm !== null && dm >= DM_HIT_MIN ? `弹幕命中 ${dm.toFixed(2)}` : null);
    if (!rescuedBy) {
      ok = false;
      reasons.push(`标题命中率 ${eff.toFixed(2)} < ${HIT_MIN}（整句 ${hit.toFixed(2)} / 最长段 ${seg.toFixed(2)}），主题词只反复出现 ${strong} 个` +
        (dm === null ? '，且没拿到弹幕' : `，弹幕命中 ${dm.toFixed(2)}`));
    } else {
      reasons.push(`命中率偏低但由「${rescuedBy}」救回`);
    }
  }

  const score = eff * 100 + (lh === null ? 0 : lh * 10) + (dm === null ? 0 : dm * 30) + strong * 2;
  return { ok, score, hit, seg, eff, latin: lh, danmaku: dm, chars, rpm, strong, reasons };
}

/* ---------- 子命令 ---------- */

async function cmdPlan(bv, opt) {
  const secs = Number(opt.secs || 600);
  const cells = Number(opt.cells || 9);
  const skip = Number(opt.skipHead || 5);
  const usable = Math.max(1, secs - skip - 3);
  const times = Array.from({ length: cells }, (_, i) => Math.round(skip + usable * (i + 0.5) / cells));
  console.log(JSON.stringify({
    bvid: bv, secs, cells, times,
    step1: 'node serve.mjs --port 7788 --out <字幕目录>',
    step2: [
      `await grabSubs(['${bv}'], { all: false, withDanmaku: true });`,
      `await grabGrid({ times: [${times.join(', ')}], cols: 3, rows: 3, endpoint: 'http://127.0.0.1:7788/frames', name: '${bv}' });`,
    ],
    step3: 'node bili-sub.mjs verify --dir <字幕目录> --online',
  }, null, 2));
  return 0;
}

async function cmdProbe(bv, opt) {
  const list = await jget(`https://api.bilibili.com/x/player/pagelist?bvid=${bv}`);
  if (list.code !== 0) die('pagelist 失败: ' + list.message, 3);
  const title = await fetchTitle(bv);
  const ps = list.data.map(p => ({ page: p.page, cid: p.cid, part: p.part, secs: p.duration }));
  const out = { bvid: bv, title, pages: ps, total_secs: ps.reduce((a, b) => a + b.secs, 0) };
  if (opt.danmaku) {
    const dm = await fetchDanmaku(ps[0].cid);
    out.danmaku = dm ? dm.slice(0, 600) : null;
    out.danmaku_chars = dm ? dm.length : 0;
    if (dm && title) out.danmaku_hit = +Math.max(titleHit(title + ' ' + ps[0].part, dm), segHit(title + ' ' + ps[0].part, dm)).toFixed(2);
  }
  console.log(JSON.stringify(out, null, 2));
}

async function subtitleList(bv, cid, cookie) {
  const j = await jget(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${cid}`);
  const subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
  return subs.map(s => ({ lan: s.lan, lan_doc: s.lan_doc, url: s.subtitle_url || '' }));
}

async function download(url) {
  const u = url.startsWith('//') ? 'https:' + url : url;
  const r = await fetch(u, { headers: HDR });
  const j = await r.json();
  const body = j.body || [];
  return { text: body.map(x => x.content).join(''), segs: body.length };
}

async function cmdFetch(bv, opt) {
  const list = await jget(`https://api.bilibili.com/x/player/pagelist?bvid=${bv}`);
  if (list.code !== 0) die('pagelist 失败', 3);
  const page = Number(opt.page || 1);
  const p = list.data.find(x => x.page === page) || list.data[0];
  const secs = p.duration;                 // pagelist 给的字段叫 duration

  const title = opt.title || (await fetchTitle(bv)) || '';
  if (!title) console.error('[warn] 没取到标题，判据只能用分P名，建议加 --title');

  let cands = [];
  if (opt.urls) {
    cands = JSON.parse(fs.readFileSync(opt.urls, 'utf8')).map(x => ({ ...x, source: 'collected' }));
  } else if (opt.cookie) {
    cands = await subtitleList(bv, p.cid, opt.cookie);
  } else {
    die('需要 --urls（页内收集）或 --cookie（登录态直接取）', 1);
  }
  if (!cands.length) die('没有候选字幕：可能没登录、或这条视频没有 AI 字幕', 3);

  const dm = opt.danmaku ? await fetchDanmaku(p.cid) : null;
  const seen = new Set();
  const rows = [];
  for (const c of cands) {
    const key = c.url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    if (!c.url) { rows.push({ ...c, error: '服务端给的 subtitle_url 是空的' }); continue; }
    try {
      const d = await download(c.url);
      const v = judge({ title, part: p.part, duration: secs, transcript: d.text, danmaku: dm });
      rows.push({ ...c, segs: d.segs, chars: d.text.length, judge: v, text: d.text });
    } catch (e) {
      rows.push({ ...c, error: e.message });
    }
  }

  rows.sort((a, b) => (b.judge?.score ?? -1) - (a.judge?.score ?? -1));
  const ok = rows.find(r => r.judge && r.judge.ok);
  const report = rows.map(r => ({
    lan: r.lan, source: r.source, chars: r.chars, segs: r.segs,
    hit: r.judge ? +r.judge.hit.toFixed(2) : null,
    seg: r.judge ? +r.judge.seg.toFixed(2) : null,
    danmaku: r.judge && r.judge.danmaku !== null ? +r.judge.danmaku.toFixed(2) : null,
    rpm: r.judge && r.judge.rpm ? Math.round(r.judge.rpm) : null,
    ok: r.judge ? r.judge.ok : false,
    why: r.judge ? r.judge.reasons.join('；') : r.error,
  }));

  console.log(JSON.stringify({ bvid: bv, title, page: p.page, part: p.part, secs, picked: ok ? report[0] : null, candidates: report }, null, 2));

  if (ok && opt.out) {
    fs.mkdirSync(opt.out, { recursive: true });
    const base = (title || bv).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
    const txt = path.join(opt.out, `${base}.txt`);
    fs.writeFileSync(txt, ok.text, 'utf8');
    fs.writeFileSync(path.join(opt.out, `${base}.meta.json`), JSON.stringify({
      bvid: bv, title, page: p.page, part: p.part, secs, lan: ok.lan, source: ok.source,
      chars: ok.chars, segs: ok.segs, judge: ok.judge, savedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    console.log(`已落盘：${txt}（${ok.chars} 字，命中 ${(ok.judge.eff * 100).toFixed(0)}%）`);
  }
  process.exit(ok ? 0 : 2);
}

/* ---------- 复核：单个文件 / 整个目录 ---------- */

/** 没有 .meta.json 的老文件：BV 号与主题从文件名里取（形如 B站BV1xxx_主题.txt） */
function metaFromName(txt) {
  const base = path.basename(txt, '.txt');
  const m = base.match(/BV[0-9A-Za-z]{10}/);
  const rest = base.replace(/^B站/, '').replace(/BV[0-9A-Za-z]{10}[_-]?/, '').replace(/[_-]+/g, ' ').trim();
  return { bvid: m ? m[0] : '', title: rest, part: '', secs: 0, fromName: true };
}

function judgeFile(file) {
  const txt = file.endsWith('.txt') ? file : file.replace(/\.meta\.json$/, '.txt');
  let meta;
  if (file.endsWith('.meta.json')) meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  else { const mj = txt.replace(/\.txt$/, '.meta.json'); meta = fs.existsSync(mj) ? JSON.parse(fs.readFileSync(mj, 'utf8')) : metaFromName(txt); }
  const body = fs.readFileSync(txt, 'utf8');
  const v = judge({ title: meta.title || '', part: meta.part || '', duration: meta.secs, transcript: body });
  return { txt, meta, v };
}

async function cmdVerify(bv, opt) {
  if (opt.dir) {
    const dir = path.resolve(opt.dir);
    const txts = fs.readdirSync(dir).filter(f => f.endsWith('.txt') && !f.startsWith('_') && f !== '说明.txt').slice(0, Number(opt.limit) || 9999);
    const rows = [];
    const online = {};                      // bvid -> {title, cid, dm}
    for (const f of txts) {
      try {
        const { txt, meta, v } = judgeFile(path.join(dir, f));
        let use = v;
        // --online：从视频页取真标题、从弹幕取第二证据（老文件没有 meta.title 时尤其必要）
        if (opt.online && meta.bvid) {
          if (!online[meta.bvid]) {
            const title = await fetchTitle(meta.bvid);
            let cid = 0, dm = null;
            try { const pl = await jget(`https://api.bilibili.com/x/player/pagelist?bvid=${meta.bvid}`); cid = pl.data?.[0]?.cid || 0; } catch {}
            if (cid) dm = await fetchDanmaku(cid);
            online[meta.bvid] = { title, cid, dm };
          }
          const o = online[meta.bvid];
          use = judge({ title: o.title || meta.title || '', part: meta.part || '', duration: meta.secs, transcript: fs.readFileSync(txt, 'utf8'), danmaku: o.dm });
        }
        rows.push({ file: path.basename(txt), bvid: meta.bvid || bv || '', title: online[meta.bvid]?.title || meta.title || '', chars: use.chars, hit: +use.hit.toFixed(2), seg: +use.seg.toFixed(2), eff: +use.eff.toFixed(2), dm: use.danmaku === null ? '' : +use.danmaku.toFixed(2), rpm: use.rpm ? Math.round(use.rpm) : '', ok: use.ok ? 'pass' : 'FAIL', why: use.reasons.join('；') });
      } catch (e) { rows.push({ file: f, bvid: '', title: '', chars: '', hit: '', seg: '', eff: '', dm: '', rpm: '', ok: 'ERR', why: e.message }); }
    }
    const out = path.join(dir, '_recheck.csv');
    const head = 'file,bvid,title,chars,hit,seg,eff,danmaku,rpm,ok,why';
    fs.writeFileSync(out, head + '\n' + rows.map(r => [r.file, r.bvid, `"${String(r.title).replace(/"/g, '""')}"`, r.chars, r.hit, r.seg, r.eff, r.dm, r.rpm, r.ok, `"${String(r.why).replace(/"/g, '""')}"`].join(',')).join('\n') + '\n', 'utf8');
    const fail = rows.filter(r => r.ok !== 'pass');
    console.log(JSON.stringify({ dir, total: rows.length, pass: rows.length - fail.length, fail: fail.length, csv: out, fails: fail.slice(0, 12) }, null, 2));
    return;
  }
  const file = opt.file || die('需要 --file 或 --dir', 1);
  const body = fs.readFileSync(file, 'utf8');
  const title = opt.title || (bv ? await fetchTitle(bv) : '') || '';
  const v = judge({ title, part: opt.part || '', duration: Number(opt.secs) || 0, transcript: body, danmaku: opt.danmaku ? await fetchDanmaku(opt.cid) : null });
  console.log(JSON.stringify({ file, title, ...v, hit: +v.hit.toFixed(3), seg: +v.seg.toFixed(3), eff: +v.eff.toFixed(3) }, null, 2));
  process.exit(v.ok ? 0 : 2);
}

/* ---------- 批量：直接吃 collector.js 的输出 ---------- */

function parseLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [bvid, title, part, secs, url] = l.split('\t');
    return { bvid, title, pages: [{ page: 1, part, secs: Number(secs), subs: [{ lan: 'ai-zh', url }] }] };
  });
}

async function cmdBatch(opt) {
  const doc = opt.lines ? parseLines(opt.lines) : JSON.parse(fs.readFileSync(opt.collector, 'utf8'));
  const items = Array.isArray(doc) ? doc : [doc];
  const dir = opt.out || '.';
  fs.mkdirSync(dir, { recursive: true });
  const table = [];

  for (const v of items) {
    const title = v.title || (v.bvid ? await fetchTitle(v.bvid) : '') || '';
    for (const pg of v.pages || []) {
      if (!pg.subs || !pg.subs.length) { table.push({ bvid: v.bvid, page: pg.page, ok: false, why: '无字幕' }); continue; }
      const dm = opt.danmaku ? await fetchDanmaku(pg.cid || 0) : null;
      let best = null;
      for (const c of pg.subs) {
        if (!c.url) { table.push({ bvid: v.bvid, page: pg.page, ok: false, why: '服务端给的 subtitle_url 是空的' }); continue; }
        try {
          const d = await download(c.url);
          const j = judge({ title, part: pg.part, duration: pg.secs, transcript: d.text, danmaku: dm });
          const row = { lan: c.lan, chars: d.text.length, segs: d.segs, judge: j, text: d.text };
          if (!best || j.score > best.judge.score) best = row;
        } catch (e) {
          table.push({ bvid: v.bvid, page: pg.page, ok: false, why: e.message });
        }
      }
      if (!best) continue;
      const j = best.judge;
      table.push({
        bvid: v.bvid, page: pg.page, part: pg.part, secs: pg.secs,
        chars: best.chars, hit: +j.hit.toFixed(2), eff: +j.eff.toFixed(2), rpm: j.rpm ? Math.round(j.rpm) : null,
        ok: j.ok, why: j.reasons.join('；'),
      });
      if (!j.ok) {
        if (opt.dump) { const rd = path.join(dir, '_rejected'); fs.mkdirSync(rd, { recursive: true }); fs.writeFileSync(path.join(rd, `${v.bvid}_P${pg.page}_${Math.round(j.eff * 100)}.txt`), best.text, 'utf8'); }
        continue;
      }
      const safe = (title || v.bvid).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
      fs.writeFileSync(path.join(dir, `${safe}.txt`), best.text, 'utf8');
      fs.writeFileSync(path.join(dir, `${safe}.meta.json`), JSON.stringify({
        bvid: v.bvid, title, page: pg.page, part: pg.part, secs: pg.secs,
        lan: best.lan, chars: best.chars, segs: best.segs, judge: j, savedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
    }
  }

  console.log(JSON.stringify({ total: table.length, pass: table.filter(t => t.ok).length, table }, null, 2));
  process.exit(table.some(t => t.ok) ? 0 : 2);
}

/* ---------- 入口 ---------- */

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}

try {
  if (cmd === 'batch') {
    await cmdBatch(opt);
  } else if (cmd === 'verify' && opt.dir) {
    await cmdVerify(null, opt);
  } else {
    const bv = argv[1];
    if (!bv) die('用法：bili-sub.mjs probe|fetch|verify BV号 [参数]', 1);
    if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) die('BV 号格式不对：' + bv);
    if (cmd === 'probe') await cmdProbe(bv, opt);
    else if (cmd === 'plan') await cmdPlan(bv, opt);
    else if (cmd === 'fetch') await cmdFetch(bv, opt);
    else if (cmd === 'verify') await cmdVerify(bv, opt);
    else die('未知子命令：' + cmd);
  }
} catch (e) {
  die('出错：' + e.message, 1);
}
