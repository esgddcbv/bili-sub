/**
 * subs.js —— 在已登录的 B 站页面里，一条命令把字幕取回来并落地
 *
 * 它解决的是「auth_key 会过期」这件事：不再把 subtitle_url 抄出来，
 * 而是在页面里直接 fetch 字幕 JSON、拼成纯文本、POST 给本机 serve.mjs 落盘。
 * 页面有登录态，auth_key 还没凉就已经用掉了。
 *
 * 用法（浏览器自动化里 evaluate 这段，或粘进控制台）：
 *   const r = await grabSubs(['BV1z8hBzNEB7', 'BV1BoM76iEih']);
 *   console.table(r);
 *
 * 前置：node serve.mjs --port 7788 --out <字幕目录>
 * 之后：node bili-sub.mjs verify --dir <字幕目录>   # 判真伪
 */

async function grabSubs(bvids, {
  all = false,                 // true = 这个视频所有分P，否则只取第一P
  endpoint = 'http://127.0.0.1:7788/text',
  withDanmaku = false,         // 顺带把弹幕也回传（第二证据）
  minChars = 200,              // 少于这个字数不落盘
} = {}) {
  const post = async (payload) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });
    return await r.json().catch(() => ({ ok: false, error: '响应不是 JSON' }));
  };
  const pullUrl = endpoint.replace(/\/text$/, '/pull');
  const postTo = (u, payload) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));

  const getJson = async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const t = await r.text();
    if (!t.trim().startsWith('{')) throw new Error('接口返回了 HTML（反爬）');
    return JSON.parse(t);
  };

  const out = [];
  for (const bv of bvids) {
    let title = null;
    try { title = document.title.replace(/_哔哩哔哩_bilibili\\s*$/, ''); } catch {}
    const pl = await getJson(`https://api.bilibili.com/x/player/pagelist?bvid=${bv}`);
    if (pl.code !== 0) { out.push({ bvid: bv, ok: false, why: 'pagelist 失败：' + pl.message }); continue; }
    const pages = all ? pl.data : pl.data.slice(0, 1);
    for (const pg of pages) {
      let subs = [];
      try {
        const pv = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${pg.cid}`);
        subs = (pv.data && pv.data.subtitle && pv.data.subtitle.subtitles) || [];
      } catch (e) {
        out.push({ bvid: bv, page: pg.page, ok: false, why: 'player/v2 失败：' + e.message });
        continue;
      }
      if (!subs.length) { out.push({ bvid: bv, page: pg.page, ok: false, why: '这条没有字幕（或未登录）' }); continue; }
      for (const s of subs) {
        if (!s.subtitle_url) { out.push({ bvid: bv, page: pg.page, lan: s.lan, ok: false, why: 'subtitle_url 是空的' }); continue; }
        try {
          let saved = await postTo(pullUrl, { kind: 'sub', bvid: bv, title: title || bv, part: pg.part, secs: pg.duration, lan: s.lan, url: s.subtitle_url });
          if (!saved.ok && saved.retryable) {
            // auth_key 凉了：回页面重新要一次 URL（登录态还在），再拉
            const fresh = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${pg.cid}`);
            const again = ((fresh.data.subtitle && fresh.data.subtitle.subtitles) || []).find(x => x.lan === s.lan);
            if (again && again.subtitle_url) {
              saved = await postTo(pullUrl, { kind: 'sub', bvid: bv, title: title || bv, part: pg.part, secs: pg.duration, lan: s.lan, url: again.subtitle_url });
              saved.retried = true;
            }
          }
          out.push({ bvid: bv, page: pg.page, lan: s.lan, chars: saved.chars, ok: !!saved.ok, retried: saved.retried, why: saved.ok ? undefined : saved.error });
        } catch (e) {
          out.push({ bvid: bv, page: pg.page, lan: s.lan, ok: false, why: '递 URL 失败：' + e.message });
        }
      }
      if (withDanmaku) {
        // 弹幕同样跨域，页面只递 cid；解压与落盘都在服务端
        const dmUrl = `https://comment.bilibili.com/${pg.cid}.xml`;
        const saved = await postTo(pullUrl, { kind: 'danmaku', bvid: bv, title: (title || bv) + '_弹幕', part: pg.part, secs: pg.duration, url: dmUrl });
        out.push({ bvid: bv, page: pg.page, kind: 'danmaku', chars: saved.chars, ok: !!saved.ok, why: saved.ok ? undefined : saved.error });
      }
    }
  }
  return out;
}
