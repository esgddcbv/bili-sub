// service worker：拿 cid → player/v2 → 拉字幕 JSON → 判真伪 → 回给 content script
// 扩展有 host_permissions，所以这些请求不受页面 CORS 限制，也不需要本机 serve。
importScripts('judge.js');

const H = { 'Referer': 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent };

async function jget(url) {
  const r = await fetch(url, { headers: H, credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function findCid(bvid) {
  const j = await jget(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
  const list = j.data || [];
  if (!list.length) throw new Error('pagelist 为空');
  return list[0];
}

async function pullSubs(bvid, cid) {
  const j = await jget(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`);
  const subs = ((j.data || {}).subtitle || {}).subtitles || [];
  if (!subs.length) return { ok: false, why: '这集没有字幕', cues: [] };
  const s = subs.find(x => x.lan === 'ai-zh') || subs[0];
  const url = s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error('字幕下载 HTTP ' + r.status);
  const data = await r.json();
  const cues = (data.body || []).map(x => ({ from: x.from, to: x.to, text: x.content }));
  return { ok: true, lan: s.lan, cues, text: cues.map(c => c.text).join('') };
}

async function pullDanmaku(cid) {
  try {
    const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: H });
    if (!r.ok) return '';
    const xml = await r.text();
    return [...xml.matchAll(/<d p="[^"]*">([\s\S]*?)<\/d>/g)].map(m => m[1]).join(' ').slice(0, 200000);
  } catch { return ''; }
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  (async () => {
    try {
      if (msg.type === 'grab') {
        const pg = await findCid(msg.bvid);
        const sub = await pullSubs(msg.bvid, pg.cid);
        if (!sub.ok) return send({ ok: false, why: sub.why });
        const danmaku = await pullDanmaku(pg.cid);
        const verdict = self.BiliJudge.judge({ title: msg.title || '', part: pg.part || '', text: sub.text, secs: pg.duration || 0, danmaku });
        send({ ok: true, cues: sub.cues, verdict, chars: sub.text.length });
      }
    } catch (e) {
      send({ ok: false, why: e.message });
    }
  })();
  return true; // 异步回应
});
