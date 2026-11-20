/**
 * grid.js —— 在 B 站视频页里抽帧、拼成 3×3 网格、POST 给本机 serve.mjs
 *
 * 用法（浏览器自动化里 evaluate 这段，改顶部参数）：
 *   const r = await grabGrid({ times: [30, 120, 240, 360, 480, 600, 720, 840, 960] });
 *
 * 为什么在页面里做：<video> 的源是 blob/MSE，页面外拿不到像素。
 * 为什么拼网格：一张 3×3 图能一次看九个画面，比九张截图省十倍以上的读取成本。
 */
async function grabGrid({
  times = null,          // 给了就按给的秒数抽；不给就按 samples 在时长里均分
  samples = 9,           // 自动取样点个数（默认 3×3）
  skipHead = 5,          // 片头留白，别把台标截进来
  cols = 3, rows = 3,
  cellW = 480, cellH = 270,
  quality = 0.85,
  endpoint = 'http://127.0.0.1:7788/frames',
  name = null,
} = {}) {
  const v = document.querySelector('video');
  if (!v) return { error: '这张页面上没有 <video>' };
  if (!v.duration || !isFinite(v.duration)) return { error: '视频还没加载出时长，先点播放一下再试' };

  const seek = (t) => new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); setTimeout(res, 120); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.2));
  });

  if (!times) {
    const usable = Math.max(1, v.duration - skipHead - 3);
    times = Array.from({ length: samples }, (_, i) => Math.round(skipHead + usable * (i + 0.5) / samples));
  }

  const c = document.createElement('canvas');
  c.width = cellW * cols; c.height = cellH * rows;
  const ctx = c.getContext('2d');
  const wasPaused = v.paused;
  v.pause();

  try {
    for (let i = 0; i < times.length && i < cols * rows; i++) {
      await seek(times[i]);
      const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
      ctx.drawImage(v, x, y, cellW, cellH);
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(x, y, 62, 22);
      ctx.fillStyle = '#fff';
      ctx.font = '14px sans-serif';
      ctx.fillText(Math.round(v.currentTime) + 's', x + 6, y + 16);
    }
  } catch (e) {
    return { error: '抽帧失败（画布可能被跨域污染）：' + e.message };
  } finally {
    if (!wasPaused) v.play().catch(() => {});
  }

  const dataUrl = c.toDataURL('image/jpeg', quality);
  const bv = (location.href.match(/BV[0-9A-Za-z]{10}/) || [null])[0];
  const tag = name || (bv || document.title).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: tag, dataUrl }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, ...j };
  } catch (e) {
    return { error: 'POST 失败（serve.mjs 没开？）：' + e.message, bytes: dataUrl.length };
  }
}
