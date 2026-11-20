# 发到 GitHub

仓库已经在本地初始化并提交（分支 `main`，8 个文件）。剩下只差一个身份。

## 方式一：令牌（一条命令）

需要一个 GitHub **fine-grained token**，权限给到：

- `Administration: Read and write`（建仓库）
- `Contents: Read and write`（推代码）

只对某个仓库、或对新仓库勾选 "All repositories" 也行。

```bash
node publish.mjs --token <你的令牌> --user <你的 GitHub 用户名>
```

成功后会打印 `https://github.com/<user>/bili-sub`。
令牌写进了 `.git/config` 的 remote URL，推完记得改回去：

```bash
git remote set-url origin https://github.com/<user>/bili-sub.git
```

## 方式二：已有 gh CLI

```bash
gh auth login
gh repo create bili-sub --public --source=. --push
```

## 方式三：网页上传

1. github.com → New repository → 名字 `bili-sub`，不要勾 README。
2. 在空仓库页点 "uploading an existing file"，把 `bili-sub.mjs`、`serve.mjs`、`grid.js`、`collector.js`、`package.json`、`README.md`、`LICENSE`、`.gitignore`、`examples.urls.tsv`、`docs/demo.gif` 拖进去。
3. 提交。

## 推之前自查

- `git status` 干净；`docs/demo.gif`、`README.md`、`LICENSE` 都在。
- 没有把 `.meta.json`、`_frames/`、`_rejected/` 带上去（`.gitignore` 已挡）。
- 令牌不要出现在提交内容里（`publish.mjs` 只从命令行参数读）。
