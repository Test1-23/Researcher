# Researcher

**一个模块化的信息搜索与整理引擎。** 输入一个问题，它自动完成
`搜索 → 抓取正文 → 整理合成 → 输出报告`，并给出带引用与来源记录的成品；
界面是一个 Electron 桌面应用。

> **状态：M0–M5 已完成。** 引擎、插件、测试、桌面应用都可运行（98 个测试通过，
> 界面冒烟测试通过）。见文末「已知限制」。

---

## 这个项目在解决什么

把「用大模型做资料调研」这件事从**一次性对话**变成**可替换、可复现、可追溯的流水线**：

| 常见做法的问题 | 这里的做法 |
|---|---|
| 换个搜索源就要改代码 | 搜索是插件，换后端 = 改配置 |
| 报告说不清用了什么模型、哪些来源抓失败了 | 每次运行都写 `provenance.json`，报告里逐条标注来源状态 |
| 一次失败整轮白跑 | 阶段降级（LLM 失败→抽取式整理）、抓取失败不致命、产物 append-only |
| 界面和引擎焊死 | 内核不认识 Electron；同一套引擎也能用 `node scripts/run-example.ts` 直接跑 |
| 没配 API key 就什么都看不到 | 零 key 也能跑完整链路（DuckDuckGo + 抽取式整理） |

## 核心设计：一切皆插件

内核**不含任何领域知识**——它不知道「搜索」背后是 DeepSeek 还是 DuckDuckGo，
只知道配置里写着哪个 id、那个插件是否 `available()`。插件之间**从不互相 import**，
只通过内核上下文（`ctx`）协作。

```
用户查询
   │
   ▼
┌──────────────────────────── Kernel（内核，稳定不变） ────────────────────────────┐
│  registry 插件注册表 · selection 运行期选型 · config 设置                        │
│  run-store append-only 产物 · events 进度事件 · fetch 抓取+正文抽取 · errors 类型化错误 │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │  插件只依赖 src/main/engine/types.ts 这一份契约
        ┌───────────────┬───────────┼───────────────┬────────────────┐
        ▼               ▼           ▼               ▼                ▼
   pipeline/        search/     provider/      organize/        output/
   主流程           搜索         大模型          整理              输出
```

四类插件（外加作为消费方的输出），每一类都可以整体替换：

| 类别 | 契约 | 内置实现 |
|---|---|---|
| `pipeline` | `run(input, ctx, signal) → Report` | `pipeline-default`（搜索→抓取→整理→输出） |
| `search` | `search(req, ctx, signal) → SearchResult` | `search-deepseek`（原生 web_search）、`search-duckduckgo`（免 key） |
| `provider` | `complete(req, ctx, signal) → CompleteResult` | `provider-openai`（任何 OpenAI 兼容端点） |
| `organize` | `organize(input, ctx, signal) → OrganizeOutput` | `organize-llm`（严格 JSON）、`organize-extractive`（免 key） |
| `output` | `render(report, ctx, signal) → Artifact[]` | `output-markdown`、`output-html`、`output-json` |

**「可替换」的含义**：插件代码在启动时静态注册（编译进主进程 bundle），
**运行期由配置决定谁是活动的**——这与 DSH 的做法一致：可替换性来自统一接口 + 运行期选型，
而不是把第三方代码热加载进来。加一个插件＝写一个目录 + 在 `src/plugins/index.ts` 登记一行。

### 降级：不是「尽力而为」，而是如实记录

选型阶段：主插件 `available()` 为假 → 自动用配置的备用插件。
运行阶段：整理插件抛错 → 用备用整理插件重跑，并把原因写进 `provenance.degraded`。

报告与 `provenance.json` 永远写明**实际**用了哪个插件、是否降级、为什么降级。

## 快速开始

需要 Node.js ≥ 20（开发用 24）与 pnpm。

```bash
pnpm install
pnpm dev          # 启动 Electron 桌面应用（渲染进程热更新）
pnpm build        # 构建 main / preload / renderer 到 out/
pnpm test         # 98 个测试
pnpm typecheck    # 主进程 + 渲染进程分别类型检查
pnpm smoke:ui     # 启动打包后的应用，用 DevTools 协议验证界面真的渲染了
```

### 配置大模型

两种方式，任选其一：

1. **环境变量**（推荐，不落盘）：启动前设置 `DEEPSEEK_API_KEY`。
2. **应用内设置**：右上角「设置」→ 填 Base URL / 模型 / API Key。

默认端点是 `https://api.deepseek.com/v1`（OpenAI 兼容），默认模型 `deepseek-chat`。
换成 OpenAI、vLLM、Ollama 或自建网关，只改 Base URL 与模型名即可。

> ⚠️ 在设置面板里填的 API Key 以**明文**保存在应用数据目录的 `config.json`。
> 不想落盘就用环境变量。日志与界面事件都会对 key 做脱敏。

### 零 key 也能跑

不配置任何 key 时：搜索自动降级到 DuckDuckGo，整理自动降级到抽取式。
两条降级都会在报告里如实标注。

## 命令行

引擎与 Electron 无关，可以直接在命令行跑：

```bash
node scripts/run-example.ts "你想研究的问题"     # 走真实网络
node scripts/run-example.ts --offline            # 用录制夹具，不联网，并生成 examples/
```

## 产物

每次运行写入 `<数据目录>/runs/<run-id>/`，append-only：

| 文件 | 内容 |
|---|---|
| `report.md` | Markdown 报告（引用编号对应来源清单） |
| `report.html` | 自包含单文件 HTML（内联 CSS，可直接打印成 PDF） |
| `report.json` | 结构化报告原文快照 |
| `provenance.json` | 本次实际使用的插件、模型、token 用量、降级原因 |
| `events.jsonl` | 完整事件流，事后排查以它为准 |
| `export.json` | 启用 `output-json` 时输出：报告 + 引用索引（每个来源被哪些小节引用） |

示例产物见 [`examples/`](examples/)。

## 目录结构

```
src/
├── main/
│   ├── index.ts          Electron 主进程入口（建窗口、装配内核）
│   ├── ipc.ts            IPC handler（含路径越界校验）
│   └── engine/           内核 —— 不含 Electron，也不含领域知识
│       ├── types.ts      ★ 稳定契约（seam）：所有插件只依赖这一个文件
│       ├── kernel.ts     运行期选型、可用性递归解析、一次运行的编排
│       ├── registry.ts   插件注册与清单校验
│       ├── config.ts     配置默认值、深合并、校验、脱敏
│       ├── fetch.ts      抓取 + HTML→文本
│       ├── run-store.ts  append-only 产物仓库
│       ├── events.ts     事件总线与日志脱敏
│       └── errors.ts     带稳定错误码的类型化错误
├── plugins/              内置插件（每个目录一个插件）
├── preload/index.ts      contextBridge 窄接口
├── renderer/             React 界面
└── shared/ipc.ts         主 ↔ 渲染 的 IPC 契约
fixtures/                 录制的结果页夹具（测试与离线示例共用）
tests/                    84 个测试
```

## 测试

```bash
pnpm test
```

覆盖：HTML→文本抽取、配置合并与校验、插件清单校验（含坏样本）、
DuckDuckGo 解析、DeepSeek 响应映射、模型 JSON 校验与重试、降级路径、
输出渲染、内核端到端（含**零 key 全链路**：仅替换网络层，跑真实内置插件）、
以及 IPC 契约（含「每个通道都必须注册 handler」与产物路径越界校验）。

界面本身由 `pnpm smoke:ui` 验证：启动打包后的应用，通过 DevTools 协议读取真实 DOM，
确认 preload 桥已注入、界面渲染出内容、并且 IPC 可以往返。

## 已知限制

- **未做运行时热加载**：加插件需要重新构建。运行期选型已支持，热加载是后续扩展。
- **DuckDuckGo 在部分网络不可达**：它靠抓取结果页工作，机房 IP 常被直接拒绝连接。
  实测本机环境中 `duckduckgo.com` 全部域名拒连，而 `example.com` / `bing.com` / DeepSeek 正常。
  因此**零 key 全链路是靠录制夹具验证的**，不是靠线上真实搜索。
- **仅抓取静态 HTML**：不执行 JS，纯前端渲染的页面会抓到空正文。
- **API Key 明文存储**（见上）；`safeStorage` 加密是后续工作。
- **单一并发运行**：同一时刻只允许一次运行。
- 抽取式整理的摘要质量取决于页面正文质量；它能保证「不编造」，但不能保证「有洞见」。

## 与旧设计的关系

仓库早期版本是一个**讲座生成器**的设计稿（见 git 历史）。
本版本沿用了它两个可迁移的判断——**插件内核 + 能力总线**、**诚实来源记录**——
其余领域逻辑（数学对象、表格校验、讲座结构契约）已全部移除。

## License

MIT
