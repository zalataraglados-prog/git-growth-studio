# Git Growth Studio｜Git 生长影片

把真实 Git 提交历史转换为可编辑、可预览、可导出的视频：文件树会随着提交平滑生长，**每个提交单独保留**。即使文件数量不变，内容修改也会显示。

## 能力

- 导入公开 GitHub 仓库地址，或者本地完整的 Git `bundle` 历史包（不接收普通源码 ZIP 代替历史）。
- 逐 SHA 展示新增、修改、删除、移动；原有 Git 合并提交也占用独立帧，不将多个提交折叠成一个。
- 片名、旁白/说明、章节、颜色和导出参数可交互编辑；草稿保存、预览和 MP4 / WebM（取决于浏览器编码能力）渲染。
- 0.25×–128× 播放速度，自定义倍率及目标片长；具备减少运动选项。
- 自带一个 **2026-11-02 的 Stardew Valley AI Companion 固定历史示例**；它不是联网自动更新的数据。

## 本地启动

要求 Node.js >= 20。无需安装运行时依赖：

```sh
npm run dev
```

然后打开终端显示的 `http://localhost:4173`。本地服务同时提供静态页面和只读 `/api/git/...` GitHub Smart HTTP 代理；**不要直接以 `file://` 打开源码版 `index.html`**（本地离线导出的单文件 HTML 可单独打开）。

```sh
npm test
```

## 导入与编辑

公开 GitHub 仓库：填写 `https://github.com/owner/repo`，可指定分支后点击导入。私有仓库或其他 Git 托管平台，先在本地仓库运行：

```sh
git bundle create history.bundle HEAD
```

选择 `.bundle` 导入。完整历史由浏览器本地 Worker 处理；在线模式仅通过只读代理转发公开 GitHub Git 对象。请勿把私有 token 写入仓库 URL。

在「编辑影片」中调整文案、调色板与输出参数，点击「预览」检查画面，再点击「渲染视频」导出。视频编码依赖浏览器的 WebCodecs / Mediabunny 支持；不保证所有浏览器都能生成 MP4，界面会反馈具体结果。

## 安全边界

- 代理仅允许 `github.com` 公开仓库的 `info/refs?service=git-upload-pack`（GET）和 `git-upload-pack`（POST），禁止任意转发和携带凭据。
- 解析限制由前端 Worker 和代理双重约束；过大的仓库会被拒绝，而不是悄悄省略部分提交。
- **影片说明是根据提交消息和变更自动生成的文本，不等于完成了代码运行审计。**
- 文件总数不变、文件内容修改、Git 合并提交与分支内容切换是不同事件，展示应保持区分。

## 目录

- `index.html`：静态页面与编辑台入口。
- `app.js`, `studio.js`, `project-state.js`：播放器、编辑器与编辑状态。
- `motion.js`, `film.js`, `render.js`：目录生长动画、共享画面、视频编码。
- `import.js`, `git-worker.js`, `history-adapter.js`：导入入口、Git Worker、变更数据校验。
- `*.css`：视觉样式与适配。
- `vendor/`：固定版本的第三方浏览器依赖；见 `vendor/THIRD_PARTY.md`。
- `server/`：独立运行的本地 HTTP 服务与受限 Git 只读代理。
- `history-parts/manifest.json`、`history-parts/*.json`、`editorial.json`：用于打开页面时展示的固定示例（无损分片还原，方便分次上传）；可在页面中导入别的仓库覆盖。
- `tests/`：基础解析、路径验证和 HTTP 路由测试。

## 发布说明

部署到不带 Node.js 服务的纯静态平台时，播放器、编辑器以及 `.bundle` 导入可以用，但 **在线 GitHub 地址导入依赖 `/api/git/...` 代理**。自行部署时请配置具有同样安全限制的代理；不能将前端直接开放为任意 URL 转发器。

网站演示：[StardewAI · 生长日志](https://stardewai-growth-journal.perky-rat-3395.chatgpt.site)

第三方库的上游许可与来源见 `vendor/THIRD_PARTY.md`。项目原创代码按仓库根目录 `LICENSE`（MIT）授权，第三方依赖分别遵循自身许可。