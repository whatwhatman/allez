# Allez ! — 法语备考引擎

零依赖、零后端的单页应用。全部逻辑在浏览器里跑：法语词形还原、CEFR 分级、易错点检测、SM-2 间隔复习、PDF 文本层抽取、扫描件 OCR。**不接任何模型也能用**，接了会更聪明。

**在线地址：https://whatwhatman.github.io/allez/**

- 成品单文件：`docs/index.html`（约 205 KB，拖进浏览器就能用）
- 源码：`index.html` + `style.css` + `data.js` `pdftext.js` `ocr.js` `engine.js` `app.js` `guide.js`
- 可选的共享代理：`worker/`（Cloudflare Workers，让你出 Key、访客免 Key）

---

## 一、发布到你自己的 GitHub Pages（永久免费，不用花一分钱）

本地 git 仓库已经初始化好、代码也提交过了，**你只要做三步**。

### 第 1 步：在 GitHub 上建一个空仓库

打开 https://github.com/new ，仓库名填 `allez`，**Public**，其余都不要勾（不要 README、不要 .gitignore、不要 License，否则第一次 push 会冲突）。

### 第 2 步：把本地仓库推上去（两条命令）

在终端里跑，把 `<你的用户名>` 换成你的 GitHub 用户名：

```bash
cd /Users/langchengxing/WorkBuddy/2026-09-14-19-27-20/allez
git remote add origin https://github.com/<你的用户名>/allez.git
git push -u origin main
```

> 如果你的 GitHub 设了双重验证，密码那一栏要填 **Personal Access Token**（GitHub → Settings → Developer settings → Personal access tokens → Tokens(classic)，勾选 `repo`）而不是登录密码。

### 第 3 步：开启 Pages

打开 `https://github.com/<你的用户名>/allez/settings/pages`：

- **Source** 选 `Deploy from a branch`
- **Branch** 选 `main`，右边目录选 **`/docs`**
- 点 **Save**

等 1–2 分钟，访问 **`https://<你的用户名>.github.io/allez/`**。

如果 Source 里只有 GitHub Actions 可选，说明刚推上去的文件还没被识别，等两分钟刷新一下页面就好。

---

### 几个说明

**二级路径不影响。** GitHub Pages 上站点的地址带 `/allez/` 这样的二级目录。这个项目的 CSS 和 JS 全部内联进了一个 HTML，manifest 和 Service Worker 都用相对路径引用，所以放在哪一层都能跑，不需要配置 base 路径。

**仓库名决定网址。** 如果想让网址变成 `https://<你的用户名>.github.io/`（不带 `/allez`），把仓库名起成 `<你的用户名>.github.io` 即可，其他步骤完全一样。

**`.nojekyll` 已经放进 `docs/`** —— 缺了它，Jekyll 会跳过以下划线开头的文件。

**额度。** GitHub Pages 免费套餐是每月 100 GB 流量、1 GB 仓库体积，构建每小时不超过 10 次。这个项目 180 KB，你一个人用永远不可能超。

### 顺手改一下提交作者（可选）

本地那几次提交是用占位身份 `Allez <allez@local>` 做的，推上去会显示成这个作者。想改成你自己的:

```bash
cd /Users/langchengxing/WorkBuddy/2026-09-14-19-27-20/allez
git config user.name "你的 GitHub 用户名"
git config user.email "你 GitHub 绑定的邮箱"
git rebase --root --exec 'git commit --amend --no-edit --reset-author'
```

（这条会重写全部 3 次提交；不影响文件内容。做完再执行上面的 push。）

## 二、国内访问更快的话，换个 Publisher

GitHub Pages 在国内部分地区会慢或不稳。同一个仓库可以直接换成这几家，全都免费：

| 平台 | 免费额度 | 特点 |
|---|---|---|
| **EdgeOne Pages**（腾讯） | 个人免费 | 国内直连、速度快，可以连 GitHub 仓库自动构建 |
| **Netlify** | 100 GB/月流量 | 全球 CDN，拖拽文件夹就能发布 |
| **Cloudflare Pages** | 无限流量 | 最稳，和下面的 Worker 代理同一家 |

三个都不需要改代码 —— 把 `docs/` 目录整个传上去就行。EdgeOne Pages 直接授权 GitHub 仓库、构建目录填 `docs` 即可。

### 不想碰 Git 的话

把 `docs/index.html` 直接拖到 Netlify Drop（app.netlify.com/drop）或 EdgeOne Pages 的上传框，30 秒能拿到一个链接。缺点是每次更新都要手动重传。

> 早期曾用过一个临时预览站（域名不属于你）做对照，现已下线，不再需要。
> 本项目今后**只在 GitHub Pages 上维护一个正式地址**。

---

## 三、要不要接模型？三种用法

### 1. 完全不接（默认）

能用：原文粘贴 / 上传 txt/md/csv/PDF → 抽词汇、标 CEFR、查易错点、六种练习模式、错词本、间隔复习、学习计划、进步报告、Tesseract 本地 OCR。

做不到：中文释义只有约 400 条核心词有；受限阅读材料是模板生成的，不是真文章；主动输出的批改只有规则检查，做不了语体层面的润色。

### 2. 自己填 Key（推荐）

到「设置」页，选服务商，粘一个 Key。Key 只存在你浏览器的 localStorage，**请求直接从你的浏览器打到你选的接口**，不经过本站或任何中间服务器。

### 3. 站主配共享代理

见第五节。好处是访客不用申请 Key，代价是请求经过你的代理（所以别提交敏感材料）。

---

## 四、免费额度怎么拿（按推荐顺序）

> 免费额度是会变的，下面写的是 2026 年初的情况。**以各家官网为准**，我尽量挑了长期稳定、不是短期促销的档位。

### 首选：智谱 GLM（国内直连）

适合大多数人 —— 不用科学上网，注册就有额度。

1. 打开 `open.bigmodel.cn`，注册登录。
2. 右上角头像 → **API Keys** → 新建（会给你一串 `xxx.xxx` 格式的字符串）。
3. 回到本站「设置」页，服务商选 **智谱 GLM**，把 Key 粘进去，保存，**测试连接**。

- 用于释义/批改：`glm-4-flash`（长期免费档）
- 用于扫描件 OCR：控制台里当前标注免费的视觉模型，模型名会随平台调整，以控制台为准

### 次选：OpenRouter（免费模型最多）

一个 Key 通吃几百个模型，名字带 `:free` 后缀的不要钱。

1. 打开 `openrouter.ai`，用 Google 或 GitHub 账号登录。
2. **Keys** 页面 → Create Key。
3. 本站设置页服务商选 **OpenRouter**，粘 Key。
4. OCR 推荐用专门的免费 OCR 模型（`baidu/qianfan-ocr-fast:free` 或 `nvidia/nemotron-nano-12b-v2-vl:free`），这两个针对文字识别优化过，比通用视觉模型准。

缺点：需要能访问 OpenRouter 的服务。

### 备选：硅基流动

`siliconflow.cn` 注册后有免费额度，小模型长期免费、国内延迟低。**但免费的通常只覆盖文本模型**，视觉模型（VL）多半要付费 —— 所以 OCR 那栏建议另选 OpenRouter。

### 备选：Google Gemini

走官方的 OpenAI 兼容端点，模型填 `gemini-2.0-flash`，Key 在 `aistudio.google.com/apikey` 拿。免费额度够个人用，但需要能访问 Google 服务。

### 不推荐用于本站的

DeepSeek 便宜但没有视觉模型，OCR 用不了；OpenAI / Claude 需要账号和付费额度。

**法语质量排序**（我的判断）：Claude > Gemini ≈ GLM > 小参数开源模型。但考虑到能直连 + 免费，智谱是最实际的起点。

### 关于 CORS

浏览器直接调第三方 API 会碰到跨域限制。已验证 OpenAI 兼容端点多数放行；Anthropic 走直连需要额外请求头，代码里已经加了。万一某个服务商报 CORS 错误，两条路：换一家，或者用下面的共享代理转发。

---

## 五、部署共享代理（可选）

让你出一个 Key，访客不用申请就能用。也能顺手解决 CORS。

**为什么不能直接把 Key 写在前端**：前端的一切都是公开的，打开 DevTools 就能抄走，然后刷爆你的额度。

```bash
cd worker
npm i -D wrangler

# 填 Key：这一步是加密存储的，不会进代码仓库
npx wrangler secret put UPSTREAM_KEY

# 改 wrangler.toml：至少改 ALLOWED_ORIGIN 和 UPSTREAM_BASE
# 然后部署
npx wrangler deploy
```

部署完会给你一个 `https://allez-proxy.<子域>.workers.dev` 的地址。

想要跨实例精确限流，建个 KV 再解开 `wrangler.toml` 里那两行注释：

```bash
npx wrangler kv namespace create COUNTERS
```

最后**带着代理地址重新构建**，让前端知道它的存在：

```bash
cd ..
ALLEZ_PROXY_BASE=https://allez-proxy.<子域>.workers.dev \
ALLEZ_PROXY_MODEL=glm-4-flash \
node build.js
```

然后把新的 `docs/index.html` 推上去。此刻「设置」页会多出第一项 **站内额度**，访客默认选中，什么都不用填。

代理做了三件事：藏 Key、按 IP 限流（默认 30 次/天）、压掉过大的 `max_tokens`。

---

## 六、本地开发与测试

改了源码要重新打包：

```bash
node build.js          # 生成 docs/index.html 和 allez-standalone.html
```

三套测试，改完顺手跑一遍：

```bash
node smoke.js          # 引擎层：抽词、CEFR、变位、SM-2
node ocr-smoke.js      # OCR 层：CCITT G4 解码、PDF 抽图、质量评估（45 项）
node dom-smoke.js      # 端到端：jsdom 里点完整流程（需 jsdom, pdf-lib, jszip）
```

直接开 `index.html` 也能跑（开发模式，js 未内联，方便调试）。

---

## 七、已知限制

- **中英混排 PDF 会丢空格**：中文全角字体渲染拉丁字母时，PDF 里根本不画空格字形，所以这类排版的文本抽出来词会粘在一起。这是 PDF 本身的缺陷，换任何解析器都一样。遇到这种文件，建议复制粘贴而不是解析 PDF。
- **CCITT G4 我手写的解码器**：浏览器没有原生支持，自己实现了 T.6（MMR）。测试覆盖了有代表性的用例（全白页、纯水平模式编码、随机条纹图的编解码往返一致），但没法和 libtiff 做大规模交叉验证 —— 遇到解码异常的扫描件请把文件发我。
- **双栏版面的 OCR 顺序**：视觉模型按视觉顺序读，遇到报纸式双栏可能串行。单栏教材没问题。
- **SM-2 应该换 FSRS**：现在的间隔算法是 1987 年的老公式，够用但不是最优。
- **OCR 准确率未实测**：视觉模型那条路需要联网调 API，Tesseract 那条路要下 15 MB 模型，两条在当前环境都跑不了。第一次用请拿一份真扫描件试。

---

## 八、数据在哪儿

全部在你自己的浏览器 localStorage：

- 词汇、错词本、复习进度、学习计划、API 配置
- 键名：`allez_v1`（引导是否看过的标记是 `allez.onboarded.v1`）
- **换浏览器 / 清缓存会丢**。设置页有导出入口，重要进度记得存一份。

除了你主动填的那个 API Key 请求，本站不向任何服务器发送数据 —— 没有统计、没有埋点、没有 CDN 回传。唯一的例外是 Tesseract.js 的模型文件，首次使用从 CDN 下载约 15 MB。装了 Service Worker 之后可以离线跑。
