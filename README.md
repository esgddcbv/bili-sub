# bili-sub

**B 站视频取字工具：先验真，再落盘；没字幕就抽帧。**

> **状态（2026-11-20）**：CLI 的字幕拉取、验真、抽帧三条路都已在真页面上跑过；弹幕由本机 `/pull` 拉取（页面 fetch 被 CORS 挡）。**浏览器扩展（实时字幕 + 九宫格抽帧，不落盘）在 `extension/` 里，已装进 Chrome 实测过**：真字幕通过（千屹 48,219 字 / 243 字/分 / 标题命中 0.57）、漂移字幕被拦、拖动视频时字幕跟着换句。一个已知教训：v1 把弹幕命中当否决条件，误杀了 676 字的真字幕，现在弹幕只加分不否决。凡是没验过的，README 仍会写「未验」。


给 AI agent（或任何要批量"看"B 站课程的人）用。它只解决两件具体的事：

1. **AI 字幕经常不是这条视频的。** B 站 `/x/player/v2` 给的 `subtitle_url` 会漂——同一个 BV，早上回来是这门课，下午回来是别人的评测、别人的 vlog，甚至只有一句 `♪ 音乐 ♪`。这个工具不换接口，它**取到之后先验**，验不过就不落盘。
2. **没字幕的时候，靠帧。** 在页面里把 `<video>` seek 到若干秒，拼成 3×3 网格，一次看九个画面——比九张截图省一个数量级。

> English: a tiny tool for Bilibili that fetches AI subtitles **and verifies they belong to the video**, plus a 3×3 frame-grid extractor for videos without usable subtitles.

![demo](demo.gif)

---

## 二、扩展：实时字幕，不落盘（开发中）

字都下到硬盘、再读回来，一是慢，二是几千集课程会把盘塞满。扩展版把这件事做成「一边播一边看」：

- 面板常驻视频页右下角，跟着 `timeupdate` 显示当前这一句；
- 只有点「抓本集」时才向后台要字幕，字幕留在内存里，关掉页面就没了；
- 后台用扩展的 `host_permissions` 直连 `api.bilibili.com` / `aisubtitle.hdslb.com`，**不经过页面、不受 CORS 限制、不需要本机 serve**；
- 抓到当场跑同一套判据，面板上直接写「验真通过 / 不通过 + 为什么」；
- 「复制全部」把整集字幕塞进剪贴板，要存盘由你决定。
- 「抽帧 9 张」：字幕只覆盖前十几分钟时，从当前位置往后按 9 个点 seek、拼成 3×3，**同样只进内存**。踩过的坑记在这：`seeked` 事件在没缓冲时根本不触发，所以不能等事件，要轮询 `readyState >= 2` 且已到目标位置，3 秒还不来就把那一格画成「未缓冲 ✕」继续下一张，否则整个面板会卡死在「抽帧中…」。九宫格出来后面板太窄，点图可以全屏看。
- 「抽这一帧」：只要当前这一秒，按视频原尺寸取 PNG（1920×1080 约 1.5 MB），同样只在内存里；适合暂停到关键帧看构图、看字幕小字。

```
extension/
  manifest.json   MV3，权限只有 storage + 三个 bilibili 域
  background.js   cid → player/v2 → 拉字幕 → 判真伪
  content.js      面板、实时跟读、拖动、复制
  judge.js        判据（与 CLI 同源，Node 里也能 require）
  panel.css
```

安装：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`。

**未验**：扩展尚未在真实浏览器里加载过（写这段时浏览器桥只支持页面内脚本，进不了 `chrome://extensions`）；`judge.js` 已用真字幕与漂移字幕在 Node 里对过——真字幕 `ok:true, 289 字/分, 命中 0.50`，漂移的那份 `FAIL：语速 4 字/分…`。

---

## 它不解决什么

- 不下载视频、不转写音频。B 站音频流有签名与防盗链，本工具不碰。
- 不解码"没有任何字幕"的长课。取不到就是取不到。
- 不绕过登录：字幕字段需要登录态，登录态只能从你已登录的浏览器页面里拿（见下）。

---

## 一、字幕：取 + 验

### 三条证据

| 证据 | 怎么算 | 用途 |
|---|---|---|
| 标题 2-gram 命中率 | 标题 + 分P名的中文二元组，有多少出现在正文里 | 主判据，≥0.22 通过 |
| 最长中文段命中率 | 标题里最长的那个中文段单独算一次，与整句取高者 | 防长标题被括注（`【千屹】：8.30分享（自习课）`）稀释 |
| 弹幕命中率 | `comment.bilibili.com/{cid}.xml`（**raw deflate**）里同样算一遍，≥0.30 可单独救回 | 弹幕里喊的往往就是这门课 |

外加两条硬门槛：正文 ≥200 字；语速（字数 ÷ 时长）落在 **60–600 字/分**——这是正常口播的范围，落在外面说明是音乐、静音或别的视频。

```
chars < 200                                              -> FAIL
rpm 不在 60–600（且时长已知）                              -> FAIL
eff = max(整句命中, 最长段命中) < 0.22
  且 主题词反复出现 < 2
  且 (没弹幕 或 弹幕 < 0.30)                              -> FAIL
否则 PASS
score = eff*100 + 拉丁词命中*10 + 弹幕命中*30 + 主题词*2
```

### 命令

```bash
# 1) 看这条视频有什么：标题、分P、cid、时长（不需要登录）
node bili-sub.mjs probe BV1z8hBzNEB7

# 顺带看弹幕说了什么（判真伪的第二证据）
node bili-sub.mjs probe BV1z8hBzNEB7 --danmaku

# 2) 取字幕。urls.json 由 collector.js 在页面里生成；或者直接给 cookie
node bili-sub.mjs fetch BV1z8hBzNEB7 --urls urls.json --out ./subs --danmaku
node bili-sub.mjs fetch BV1z8hBzNEB7 --cookie "SESSDATA=...; bili_jct=..." --out ./subs

# 3) 批量：TSV 五列（bvid / title / part / secs / subtitle_url）
node bili-sub.mjs batch --lines list.tsv --out ./subs

# 4) 复核已经存下来的字幕（整目录）。老文件没有 meta 时从文件名取 BV 号
node bili-sub.mjs verify --dir ./subs
# 联网取真标题 + 弹幕重判，输出 _recheck.csv
node bili-sub.mjs verify --dir ./subs --online
```

退出码：`0` 成功 · `1` 参数错 · `2` 全部候选验真失败 · `3` 拿不到候选。

### 登录态怎么拿

`/x/player/v2` 匿名也能返回 `code:0`，但 `subtitles` 是空数组——**字幕字段必须要登录态**。而 cookie 在浏览器进程里，`Network.getAllCookies` 这类接口经常不给（`target_scope_unsupported`）。

所以做法是：**在已登录的 B 站页面里用 `fetch(..., {credentials:'include'})` 收集**，把结果喂给 CLI：

```js
// 页面控制台 / 自动化里运行 collector.js 的 collectSubs
const r = await collectSubs('BV1z8hBzNEB7');
console.log(JSON.stringify(r));   // {bvid,title,pages:[{page,cid,part,secs,subs:[{lan,url}]}]}
```

`auth_key` 大约 **20–30 分钟**过期，收集完就立刻 fetch。

---

## 二、帧：没字幕时看画面

`<video>` 的像素只在页面里能读（blob / MSE 源），所以抽帧必须发生在页面里；但页面触发下载的落点不可控，于是走本机回传：

```bash
# 起一个只监听 127.0.0.1 的接收端
node serve.mjs --port 7788 --out ./frames
```

然后在视频页里运行 `grid.js` 的 `grabGrid`：

```js
const r = await grabGrid({ times: [30, 300, 600, 900, 1200, 1500, 1800, 2100, 2400] });
// -> {ok:true, file:"...frames\\BV1BoM76iEih_1779...jpg", bytes: 180000}
```

默认 3×3、每格 480×270、JPEG 0.85——九帧一张图，一格带秒数角标。要看细节就 `cols:1, rows:1, cellW:1280` 抽单帧。

```js
// 单帧大图
await grabGrid({ times: [95], cols: 1, rows: 1, cellW: 1280, cellH: 720 });
```

---

## 实测数据（2026-11-20，真实使用）

- `verify --dir --online` 跑 **116 份**已存字幕：**88 通过 / 28 未通过**，耗时 2 分 56 秒（每份要抓视频页 + 弹幕）。
- 28 份未通过里，真错配约占三分之二（同一 BV 第二次请求返回了校招宣讲、车评、LOF 比赛解说等）；其余是擦线（命中 0.12–0.20）待人工过目。
- 单条取字幕（`fetch`）通常 1–3 秒；`auth_key` 过期会直接失败，重收集即可。

---

## 已知局限

- **判据偏严**。表演/演技类课程标题词少（正文讲"反应""眼神"），容易被误判；标题只有人名+课名的长直播也会。
  解法：`probe <BV> --danmaku` 看弹幕是否在喊这件事，对上就人工放行。
- **长课字幕常只覆盖前十几分钟**（B 站侧的 AI 字幕限制），与本工具无关。
- `verify --online` 逐条联网，116 份约 3 分钟；想快就分批 `--limit N`。
- 帧网格依赖你能在页面里跑 JS（浏览器自动化、控制台、插件都行）。本仓库只给页面侧函数，不绑定具体框架。

---

## 目录

```
bili-sub.mjs      字幕取件与验真（probe / fetch / verify / batch）
serve.mjs         帧回传接收端（本机 127.0.0.1）
grid.js           页面侧抽帧 + 3×3 拼图 + POST
collector.js      页面侧收集 subtitle_url（登录态）
examples.urls.tsv TSV 示例
```

## License

MIT

## 一条命令三件事（v3）

```bash
node serve.mjs --port 7788 --out "D:\知识库\99_原始字幕"   # ① 本机接收端
node bili-sub.mjs plan BV1z8hBzNEB7 --secs 11888              # ② 生成要在页面里跑的调用
```
把 plan 打出来的两行贴进**已登录的 B 站页面**（或浏览器自动化里 evaluate）：

```js
await grabSubs(['BV1z8hBzNEB7'], { all: false, withDanmaku: true });  // 字幕直传，auth_key 不过夜
await grabGrid({ times: [665, 1985, ...], cols: 3, rows: 3 });        // 没字幕就抽 3×3 帧
```
```bash
node bili-sub.mjs verify --dir "D:\知识库\99_原始字幕" --online       # ③ 判真伪，出复核表
```

要点：页面只把 `subtitle_url` 递回本机（`POST /pull`），**下载由本机 Node 做**。
这不是偏好，是试出来的：页面里 `fetch(aisubtitle.hdslb.com)` 会被 CORS 挡（`Failed to fetch`），
而本机下载不需要 cookie——`auth_key` 本身即授权。分开做之后，那条 URL 二十分钟的寿命也不再被人工搬运耽误。

实测（2026-11-20）：同一门千屹编剧课，页面这次给出的 AI 字幕正文是「珍妮·古道尔」纪录片——
判据给 `hit 0.08 / seg 0.11 / rpm 4`，直接 FAIL。工具的价值不在抓到字幕，而在**敢把它扔掉**。

## 判据（v2 起）

| 证据 | 含义 | 通过线 |
|---|---|---|
| `hit` | 标题整句的中文 2-gram 命中率 | — |
| `seg` | 标题里**最长中文段**的命中率（防长标题稀释） | — |
| `eff` | `max(hit, seg)` | ≥ 0.22 |
| `dm` | 弹幕命中率（第二证据，可选） | ≥ 0.30 时加分 |
| `rpm` | 正文语速（字/分） | 60–600 |
| 字数 | 正文长度 | ≥ 200 |

`score = eff*100 + 拉丁*10 + 弹幕*30 + 主题词*2`。宁可漏，不要错配——细则见「已知漏判」。

## 三、DSH 插件：`bili_sub` 工具

`dsh-bili-sub/` 是一个 DeepSeek Harness bundle，把上面的 CLI 包成一个工具：

```
bili_sub({ cmd: "probe BV1z8hBzNEB7" })
bili_sub({ cmd: "fetch BV1z8hBzNEB7 --out D:\\\\知识库\\\\99_原始字幕" })
bili_sub({ cmd: "verify --dir D:\\\\知识库\\\\99_原始字幕 --online" })
```

本地安装：`plugin_manager install_bundle` 指到这个目录即可（`package.json` 里要声明
`dsh.bundle.patch`）。参数只留一个字符串 `cmd`，是踩出来的：工具 schema 里
`parameters` 要是 author 形态（属性名 → 值 schema），而 `output.schema` 必须是标准
JSON Schema，两者混用会让整个会话 INVALID_REQUEST。
