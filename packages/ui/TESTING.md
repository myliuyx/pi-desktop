# UI 测试说明与已知缺口

## 现有断言脚本（全部不需要浏览器）

| 命令 | 覆盖内容 |
|---|---|
| `npm run typecheck` | 类型检查（必须 `-p tsconfig.app.json`，裸 `tsc` 会假绿） |
| `npm run check:adapter` | Pi 事件 → UI `Message[]` 回放断言（reducer / 翻译器 / 授权 / 工具块 / usage 不被吞 / 思考块 streaming） |
| `npm run check:format` | `formatCompact` 数值进位边界 |
| `npm run check:cn` | 内容区 class 串（Tailwind 类名口径） |

浏览器内行为（DOM/交互/真实链路）由 CDP 验收脚本（`accept:m1`~`m5`、`live:smoke`）负责，本文件不重复。

## 已知测试缺口

> 记录于 2026-09-24（Task 7 收尾）。以下均为**有意不补**，不是遗漏。

### 1. store 层 usage 消费未做断言（原计划的 `handleLiveUsage` 抽取已降级）

- **现状**：`src/store/chat-store.ts` 的 `ensureLive` 订阅内，`event.type === "usage"` 分支
  直接 `useChatStore.setState({ tokenUsage: event.usage })` 并 `return`，不进 reducer。
- **为何不按原计划**把它抽成导出函数、再让 `adapter-check.mjs` 加载 `chat-store`：
  Node 原生 TS 运行（`--experimental-strip-types`）**加载不了**该模块，障碍有三层，实测如下：

  1. `@/...` 路径别名全仓 **226 处**，Node 不读 tsconfig 的 `paths`
     （报错：`Cannot find package '@/mock'`）；
  2. `live-transport.ts` 等使用 bundler 式**无扩展名相对导入**（`./agent-transport`），
     Node ESM 要求显式扩展名；
  3. 传递依赖 `agent-transport.ts:115` 用了**构造函数参数属性**
     （`constructor(private readonly cfg: LiveConfig)`），strip-only 模式不支持，需换
     `--experimental-transform-types`。

  要跑通需额外引入解析 loader + 切换 transform 模式，属明显扰动，且会把浏览器向模块拉进
  断言脚本；而被测分支只有 3 行，断言价值低。故按 controller ruling 记为已知缺口。

- **已有替代防线**：`check:adapter` 第八节已锁死「usage 事件不被 reducer 吞掉、且不改消息树」
  这一回归；store 层写入目前靠类型检查 + 人工核对。
- **若将来要补的最小风险形态**：在 `src/adapter/reduce.ts`（`adapter-check` 已能加载）加一个
  纯函数，如 `usagePatch(event: AgentEvent): TokenUsage | null`，`chat-store` 调用它而非内联判断，
  断言即可写在 `adapter-check.mjs` 内，无需触碰 `@/` 别名与 transform 模式。

### 2. TerminalCard 折叠 DOM 行为未覆盖

`src/components/chat/TerminalCard.tsx` 的展开/收起是 React 组件状态
（`useState` + `onClick`），需要 DOM 测试环境。仓库**未引入 vitest / RTL**（约束：不新增依赖），
故不做单元断言；该交互由 CDP 验收脚本覆盖。

### 3. `contextText`（TokenStats 第四段）未覆盖

`src/components/common/TokenStats.tsx:50` 的 `contextText` 决定「上下文」段展示
（`占用率%/窗口` vs 回落窗口大小）。它当前位于 `.tsx` 内，直接 import 需要 React/DOM
与别名解析。**其实该函数是纯函数**：若把口径逻辑抽到 `src/lib/` 下的纯模块，
即可在 `check:format` 里补边界断言（本次按 ruling 未做，留作后续可选优化）。

### 4. `THINKING_HINT` 档位文案疑似语义倒挂（需产品确认）

`src/mock/composer.ts:70` 起：

| 档位 | 现文案 |
|---|---|
| `minimal` | 极简思考，最省用量 |
| `low` | 快速回答，几乎不思考 |

按档位强弱 `minimal < low`，字面上「极简思考」看起来比「几乎不思考」更弱/更省，
与档位名顺序疑似相反。**需产品确认口径**；本任务只记录，**不改文案**
（文案属用户可见口径，不能在收尾任务里单方面改动）。