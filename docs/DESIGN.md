# Researcher — 设计

状态：**M0–M5 已实现**。本文记录架构决策与理由，实现细节以代码为准。

---

## 1 目标

把「用大模型做资料调研」从一次性对话，变成一条**可替换、可复现、可追溯**的流水线：

1. 用户输入问题，得到带引用、带来源状态的合成报告。
2. 主流程、搜索、整理、输出**四类角色全部是插件**，换后端只改配置。
3. 零 API key 也能端到端跑通。
4. 报告必须诚实：写清用了哪个插件、哪些来源失败、哪里降级了。

## 2 关键决策与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 引擎语言 | TypeScript / Node | Electron 主进程、渲染进程、插件同一种语言；无需跨进程桥接引擎 |
| 插件加载 | 编译期静态注册，**运行期选型** | 与 DSH 一致：可替换性来自统一接口 + 运行期选择，而非热加载第三方代码 |
| 契约位置 | 单一 `engine/types.ts` | 插件只依赖它，因此插件之间零耦合；换任一插件不影响其它插件 |
| 抓取为何不做成插件 | 内核内置服务 | 抓取+正文抽取是通用管道能力，不是领域逻辑；用户只要求 4 类插件 |
| 整理的输出形态 | 结构化 JSON 而非散文 | 结构可校验、可过滤编造引用、可被不同输出插件复用 |
| 默认整理策略 | 抽取式（`organize-extractive`）为零 key 兜底，LLM 为质量升级 | 保证「装了就能用」，同时给出升级路径 |
| 与旧讲座生成器的关系 | 只保留「插件内核」与「诚实记录」两条原则 | 数学对象、表格校验等是领域逻辑，与本产品无关 |

## 3 分层

```
┌──────────────────────────────────────────────────────────────┐
│ Electron 主进程   窗口、IPC、生命周期                          │
├──────────────────────────────────────────────────────────────┤
│ 内核 engine/      注册表 · 选型 · 配置 · run 仓库 · 事件 · 抓取  │  ← 不认识 Electron
├──────────────────────────────────────────────────────────────┤
│ 契约 types.ts     SearchProvider / LlmProvider / Organizer /  │  ← 插件只依赖这一层
│                   OutputPlugin / Pipeline / PluginContext     │
├──────────────────────────────────────────────────────────────┤
│ 插件 plugins/     内置实现，互不 import                        │
└──────────────────────────────────────────────────────────────┘
```

内核与 Electron 完全解耦，因此 `scripts/run-example.ts` 能用同一个内核在命令行跑完整个流程。

## 4 插件契约要点

```ts
interface SearchProvider {
  readonly id: string
  readonly kind: 'search'
  available(ctx: AvailabilityContext): boolean      // 纯本地检查，禁止网络
  search(req, ctx: PluginContext, signal?): Promise<SearchResult>
}
```

**为什么 `available()` 接受一个上下文对象而不是零参数**：
`organize-llm` 自己不需要 key，但它**依赖**大模型 provider 可用。
把「查询另一个插件是否可用」的能力交给内核（而不是让它 import provider），
既解决了依赖判断，又没有破坏「插件之间零耦合」。内核用 `seen` 集合防止配置写出循环依赖时无限递归。

**为什么所有方法都接收 `ctx`**：搜索插件需要 HTTP、LLM 插件需要配置、
输出插件需要写产物。统一传 `ctx` 比给每个方法设计不同的注入方式更简单，也更一致。

## 5 一次运行的时序

```
kernel.run(input, bus, signal)
  ├─ 校验查询（空 / 超长 → INVALID_INPUT）
  ├─ 建 run 目录，事件同时落盘 events.jsonl
  ├─ emit run:start
  └─ pipeline.run(input, ctx, signal)
       ├─ [search]   ctx.search() → 选型（含降级）→ 去重 → 截断 → emit source:found
       ├─ [fetch]    并发抓取（保序），单源失败记入 failures，不致命
       ├─ [organize] ctx.organize() → 失败则 ctx.organizeFallback() 重跑并记录原因
       ├─ 组装 Report + Provenance
       └─ [output]   逐个 output 插件 render()
  ├─ 写 report.json / provenance.json
  └─ emit run:done（必须是最后一个事件）
```

**并发抓取为什么要保序**：结果按下标写回，因此同样的输入得到同样的报告顺序。
不保序会让报告随网络快慢而变，diff 两次运行就没有意义了。

## 6 失败与降级策略

| 情形 | 行为 |
|---|---|
| 主搜索插件不可用 | 用配置的备用插件；`provenance.searchFallbackUsed = true` |
| 搜索插件运行期抛错 | 整次运行失败（没有来源就无事可做），错误码 `SEARCH_FAILED` |
| 单个来源抓取失败 | 记入 `failures`，整理阶段只用成功正文，报告里逐条标注 |
| LLM 输出非法 JSON | 追加修复指令重试一次；仍失败 → 降级到备用整理插件并记录原因 |
| 用户取消 | `AbortSignal` 贯穿全部阶段；抛 `CANCELLED`，已落盘产物保留 |
| 429 限流 | 带退避重试一次（LLM provider）；仍失败则作为类型化错误上报 |
| 瞬时网络故障 | 抓取层按 `fetch.maxRetries` 重试（连接重置、TLS 握手被丢、超时、429、5xx）；4xx 与取消不重试 |
| 配置损坏 | 备份为 `config.json.bad`，回退缺省配置，不让应用起不来 |

## 7 安全与诚实

- **渲染进程**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；
  只通过 preload 暴露的窄接口访问主进程；CSP 限制到 `'self'`。
- **报告正文一律当文本渲染**，不用 `dangerouslySetInnerHTML`——抓来的网页里带脚本也不会被执行。
- **API key 脱敏**：日志与事件在写出去之前，会把配置里出现的 key 字面量替换成 `***`。
- **产物路径**：读写前先与 run 仓库的真实产物清单比对，拒绝越界路径。
- **诚实性不是可选项**：`provenance` 记录实际使用的插件与降级原因；
  抽取式整理的摘要里写明「未经大模型改写，不代表对来源内容的判断」。

## 8 已知限制与后续方向

- 插件热加载（当前需要重新构建）。
- 搜索适配器只实现了 DeepSeek 与 DuckDuckGo；Tavily / Exa / Brave 只是再写一个适配器。
- 抓取不执行 JS，纯前端渲染页面会抓到空正文；可换成无头浏览器或第三方抽取服务。
- 凭据用 `safeStorage` 加密存储。
- 流式整理（边生成边显示）。
- PDF 导出与打包分发。
