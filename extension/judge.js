// 三条证据：标题整句 2-gram / 标题最长中文段 / 弹幕。浏览器扩展与 Node 共用同一套。
(function (root) {
  const STOP = /[，。！？、；：“”‘’（）《》…—\s,.!?;:"'()\-]/;
  const latin = s => (s.match(/[A-Za-z0-9]+/g) || []);
  function grams(s) {
    const out = new Set();
    for (const seg of s.split(STOP)) {
      const t = seg.replace(/[^\u4e00-\u9fa5]/g, '');
      for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
    }
    return out;
  }
  function hitRate(title, text) {
    const g = grams(title || '');
    if (!g.size) return 0;
    const body = (text || '').replace(/[\s\p{P}]/gu, '');
    let hit = 0;
    for (const k of g) if (body.includes(k)) hit++;
    return hit / g.size;
  }
  function longestSeg(title) {
    const segs = (title || '').split(/[，。！？、；：|｜【】\[\]（）()\s]+/).filter(x => x.replace(/[^\u4e00-\u9fa5]/g, '').length >= 4);
    segs.sort((a, b) => b.length - a.length);
    return segs[0] || '';
  }
  function judge({ title = '', part = '', text = '', secs = 0, danmaku = '' }) {
    const chars = (text || '').length;
    const rpm = secs > 0 ? Math.round(chars / (secs / 60)) : 0;
    const hit = hitRate(title, text);
    const seg = longestSeg(part || title);
    const segHit = seg ? hitRate(seg, text) : 0;
    const eff = Math.max(hit, segHit);
    const dm = danmaku ? hitRate(title, danmaku) : 0;
    const reasons = [];
    if (chars < 200) reasons.push(`正文只 ${chars} 字（<200），太短不认`);
    if (rpm && (rpm < 60 || rpm > 600)) reasons.push(`语速 ${rpm} 字/分 不在 60–600（像音乐、静音或别的视频）`);
    if (eff < 0.22) reasons.push(`标题命中 ${eff.toFixed(2)} < 0.22（整句 ${hit.toFixed(2)} / 最长段 ${segHit.toFixed(2)}）`);
    if (dm && dm < 0.30) reasons.push(`弹幕命中 ${dm.toFixed(2)} < 0.30`);
    const ok = reasons.length === 0;
    return { ok, chars, rpm, hit: +hit.toFixed(3), seg: +segHit.toFixed(3), dm: +dm.toFixed(3), eff: +eff.toFixed(3), why: reasons.join('；'), title, part };
  }
  root.BiliJudge = { judge, hitRate, longestSeg, grams };
})(typeof window !== 'undefined' ? window : self);
