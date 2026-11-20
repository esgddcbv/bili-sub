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
    <div class="meta"></div>
    <div class="bar"><button data-a="grab">抓本集</button><button data-a="copy">复制全部</button><button data-a="close">收起</button></div>`;
  document.documentElement.appendChild(root);

  const dot = root.querySelector('.dot');
  const cueEl = root.querySelector('.cue');
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

  root.addEventListener('click', async (e) => {
    const a = e.target.dataset.a;
    if (a === 'close') { root.classList.toggle('on'); return; }
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
