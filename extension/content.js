// 页面侧：右下角小面板，实时跟着播放时间显示当前这一句；点「抓本集」才向后台要字幕。
(() => {
  if (window.__bslLoaded) return;
  window.__bslLoaded = true;

  const bvid = (location.pathname.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
  const video = () => document.querySelector('video');
  let cues = [], verdict = null, alive = false;

  const root = document.createElement('div');
  root.id = 'bsl-panel';
  root.innerHTML = `
    <div class="h"><span class="dot"></span><span class="t">bili-sub · 实时字幕</span></div>
    <div class="cue">点「抓本集」——字幕只在内存里，不落盘。</div>
    <div class="grid"></div>
    <div class="meta"></div>
    <div class="bar"><button data-a="grab">抓本集</button><button data-a="grid">抽帧 9 张</button><button data-a="one">抽这一帧</button><button data-a="copy">复制全部</button><button data-a="close">收起</button></div>`;
  document.documentElement.appendChild(root);

  const dot = root.querySelector('.dot');
  const cueEl = root.querySelector('.cue');
  const gridEl = root.querySelector('.grid');
  const metaEl = root.querySelector('.meta');

  const setState = (s, txt) => { dot.className = 'dot ' + s; if (txt) metaEl.textContent = txt; };

  function renderCue() {
    const v = video();
    if (!v || !cues.length) return;
    const t = v.currentTime;
    const c = cues.find(x => t >= x.from - 0.15 && t <= x.to + 0.6) || null;
    cueEl.textContent = c ? c.text : '—';
  }
  document.addEventListener('timeupdate', renderCue, true);

  async function shootGrid() {
    const v = video();
    if (!v || !v.duration) return setState('bad', '还没加载出时长');
    gridEl.innerHTML = ''; cueEl.style.display = 'none';
    setState('', '抽帧中…（会静音跳着 seek 九次）');
    const W = 320, H = 180, dur = v.duration;
    const start = Math.min(v.currentTime + 5, Math.max(0, dur - 60));
    const times = [...Array(9)].map((_, i) => Math.round(start + i * ((dur - start) / 9)));
    const cv = document.createElement('canvas'); cv.width = W * 3; cv.height = H * 3;
    const cx = cv.getContext('2d');
    const back = v.currentTime;
    let miss = 0;
    for (let i = 0; i < 9; i++) {
      // 关键：seeked 不可靠（没缓冲时根本不来）。改成轮询「到了目标位置且解码出画面」。
      const target = times[i];
      v.currentTime = target;
      const t0 = Date.now();
      while (Date.now() - t0 < 1200) {
        const near = Math.abs(v.currentTime - target) < 1.5;
        if (near && v.readyState >= 2) break;
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 240));
      const x = (i % 3) * W, y = Math.floor(i / 3) * H;
      const ready = v.readyState >= 2;
      if (ready) cx.drawImage(v, x, y, W, H);
      else if (++miss >= 3 && i <= 2) {
        cueEl.style.display = ''; gridEl.innerHTML = '';
        setState('bad', '视频还没缓冲，先点播放让它跑两秒，再抽');
        return;
      }
      else {
        cx.fillStyle = '#1b1f24'; cx.fillRect(x, y, W, H);
        cx.fillStyle = '#6b7480'; cx.font = '13px sans-serif';
        cx.fillText('未缓冲', x + W / 2 - 20, y + H / 2 + 4);
      }
      cx.fillStyle = 'rgba(0,0,0,.55)'; cx.fillRect(x + 4, y + 4, 58, 18);
      cx.fillStyle = '#fff'; cx.font = '12px sans-serif';
      cx.fillText(times[i] + 's' + (ready ? '' : ' ✕'), x + 9, y + 17);
    }
    v.currentTime = back;
    const img = document.createElement('img');
    img.src = cv.toDataURL('image/jpeg', 0.82);
    img.title = '点一下看大图'; img.style.cursor = 'zoom-in';
    img.onclick = () => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
      const big = document.createElement('img'); big.src = img.src;
      big.style.cssText = 'max-width:96vw;max-height:96vh;border-radius:8px';
      ov.appendChild(big); ov.onclick = () => ov.remove();
      document.body.appendChild(ov);
    };
    gridEl.appendChild(img);
    setState('', `抽帧 ${times[0]}–${times[8]} 秒 · 只在内存里 · 存不存你定`);
  }

  async function shootOne() {
    const v = video();
    if (!v) return setState('bad', '没找到播放器');
    gridEl.innerHTML = ''; cueEl.style.display = 'none';
    const w = Math.min(v.videoWidth || 1280, 1920), h = Math.round(w * (v.videoHeight || 720) / (v.videoWidth || 1280));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    const t = v.currentTime;
    for (let i = 0; i < 15 && v.readyState < 2; i++) await new Promise(r => setTimeout(r, 100));
    if (v.readyState < 2) return setState('bad', '这一帧还没解码出来，先点一下播放再暂停');
    cx.drawImage(v, 0, 0, w, h);
    const img = document.createElement('img');
    img.src = cv.toDataURL('image/png');
    img.title = '点一下看大图'; img.style.cursor = 'zoom-in';
    img.onclick = () => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
      const big = document.createElement('img'); big.src = img.src;
      big.style.cssText = 'max-width:96vw;max-height:96vh;border-radius:8px';
      ov.appendChild(big); ov.onclick = () => ov.remove();
      document.body.appendChild(ov);
    };
    gridEl.appendChild(img);
    setState('', `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} · ${w}×${h} PNG · 只在内存里`);
  }

  root.addEventListener('click', async (e) => {
    const a = e.target.dataset.a;
    if (a === 'close') { root.classList.toggle('on'); return; }
    if (a === 'grid') { root.classList.add('on'); await shootGrid(); return; }
    if (a === 'one') { root.classList.add('on'); await shootOne(); return; }
    if (a === 'copy') {
      if (!cues.length) return setState('', '还没抓');
      try { await navigator.clipboard.writeText(cues.map(c => c.text).join('\n')); setState('ok', `已复制 ${cues.length} 句`); }
      catch { setState('bad', '复制被拦，换 Ctrl+C'); }
      return;
    }
    if (a === 'grab') {
      root.classList.add('on');
      setState('', '抓取中…');
      const title = (document.querySelector('h1') || {}).textContent || document.title.replace(/_哔哩哔哩.*$/, '');
      chrome.runtime.sendMessage({ type: 'grab', bvid, title }, (res) => {
        if (!res || !res.ok) { cues = []; return setState('bad', '没抓到：' + ((res && res.why) || '未知')); }
        cues = res.cues; verdict = res.verdict; alive = true;
        gridEl.innerHTML = ''; cueEl.style.display = '';
        const v = verdict;
        const line = `${v.ok ? '验真通过' : '验真不通过'} · ${v.chars} 字 · ${v.rpm} 字/分 · 标题 ${v.eff.toFixed(2)}` + (v.why ? '\n' + v.why : '');
        setState(v.ok ? 'ok' : 'bad', line);
        renderCue();
      });
    }
  });

  // 拖动
  const head = root.querySelector('.h');
  let drag = null;
  head.addEventListener('mousedown', (e) => { const r = root.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top }; root.style.right = 'auto'; root.style.bottom = 'auto'; root.style.left = r.left + 'px'; root.style.top = r.top + 'px'; });
  window.addEventListener('mousemove', (e) => { if (!drag) return; root.style.left = (e.clientX - drag.x) + 'px'; root.style.top = (e.clientY - drag.y) + 'px'; });
  window.addEventListener('mouseup', () => { drag = null; });
})();
