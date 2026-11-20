/**
 * collector.js —— 在「已登录的 B 站页面」里执行，负责把候选字幕 URL 抓出来。
 *
 * 为什么要在页面里抓：/x/player/v2 的 subtitle 字段要求登录态，
 * Node 里裸 fetch 拿到的 subtitle 是空的（login_mid=0，subtitles=[]）。
 *
 * 用法（在 B 站任意页面执行）：
 *   await collectSubs('BV1z8hBzNEB7')            // 只取第 1 个分P
 *   await collectSubs('BV1z8hBzNEB7', {all:true}) // 取全部分P
 *
 * 返回：{ bvid, title, pages:[{page,cid,part,secs,subs:[{lan,lan_doc,url}]}] }
 * 把结果存成 urls.json，再交给 bili-sub.mjs fetch 去验真。
 */
async function collectSubs(bv, opts = {}) {
  const j = async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const t = await r.text();
    if (!t.trim().startsWith('{')) throw new Error('非 JSON（被挡了）：' + u);
    return JSON.parse(t);
  };

  const pl = await j('https://api.bilibili.com/x/player/pagelist?bvid=' + bv);
  if (pl.code !== 0) throw new Error('pagelist 失败：' + pl.message);
  const pages = opts.all ? pl.data : pl.data.slice(0, 1);

  let title = '';
  try {
    const v = await j('https://api.bilibili.com/x/web-interface/view?bvid=' + bv);
    if (v.code === 0) title = v.data.title;
  } catch (e) { /* 标题拿不到不影响取字幕 */ }

  const out = { bvid: bv, title, pages: [] };
  for (const p of pages) {
    const v2 = await j(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${p.cid}`);
    const subs = ((v2.data && v2.data.subtitle && v2.data.subtitle.subtitles) || [])
      .map(s => ({ lan: s.lan, lan_doc: s.lan_doc, url: s.subtitle_url }));
    out.pages.push({ page: p.page, cid: p.cid, part: p.part, secs: p.duration, subs });
  }
  return out;
}

/* 挂到 window：间接 eval / strict 上下文里定义不会外泄 */
if (typeof window !== "undefined") window.collectSubs = collectSubs;
