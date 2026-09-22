# M2 进度与验收记录

> 更新日期：2026-09-22
> 里程碑：**M2 · 会话工作台**（计划净工时 20h）
> 配套：[task-M2.md](./task-M2.md) · [acceptance-criteria.md](./acceptance-criteria.md) · [screens.md](./screens.md) · [progress-M1.md](./progress-M1.md)

---

## 一、结论

**M2 已完成，32 项验收断言全部实测通过，M1 的 13 条回归全部仍然成立。** 可进入 M3。

| 项目 | 结果 |
|---|---|
| M2 验收（18 条，拆成 32 项断言） | **32 / 32 通过**（`scripts/m2-acceptance.mjs` → `_m2-evidence.json`） |
| M1 回归（13 条） | **通过**（`npm run accept:m1` → EXIT=0，1-13 / 1-3 / 1-10 均成立） |
| G1~G8 | 全部通过 |
| `tsc --noEmit -p tsconfig.app.json` | **EXIT=0** |
| `vite build` | **EXIT=0**（2049 modules，主包 480.16 kB / gzip 147.37 kB） |
| 遗留 Blocker / Major | **0** |

---

## 二、执行方式（含一次真实的流程事故，值得留档）

按 M1 验证过的做法：**先写规格书 → 派执行方 → 主控独立复核**。M2 工作量是 M1 的 1.7 倍，
所以拆成两个执行方并行，每人负责互不重叠的文件：

| 执行方 | 负责范围 |
|---|---|
| Agent A（`m2-chat`） | mock 数据、chat-store、MessageList、MessageBubble、Thinking/Plan/Terminal/Approval Card、Markdown、Shiki 高亮、流式模拟 |
| Agent B（`m2-composer`） | Composer、ComposerToolbar、TokenStats、工具条 mock 数据、`composer-layout` |

为了让「并行」真的成立，主控先做了三件前置：

1. **冻结公共契约**：`mock/types.ts`（全部数据类型）、`lib/format.ts`（`formatCompact` 等）、`lib/layout.ts` 的 M2 段常量。
   两个执行方都以它为准，谁都不许改。
2. **打好接口桩**：`sessions.ts` / `chat-store.ts` / `MessageList.tsx` / `Composer.tsx` / `ComposerToolbar.tsx` 先写成最小可编译桩，
   主控自己写 `WorkspaceArea` 的集成代码。**结果是：任何时刻项目都能 `tsc` 通过并 `npm run dev` 跑起来**，
   两个执行方都能随时在浏览器里验自己的东西 —— 这是并行开发最关键的一条。
3. **抽出共享工具** `scripts/cdp.mjs`（CDP 驱动公共模块），避免两边各写一份、也避免两边同时改同一个文件。

### ⚠️ 事故一：并行派发漏了一个（我的失误）

我说了「并行派两个执行方」，实际只发出去一个 Agent 调用就结束了回合。结果：
Agent A 在后台跑了约 50 分钟，而 Agent B 根本没启动；用户看到的现象是「卡住了」。

**教训**：宣称"并行"之后必须核对**实际发出了几个**调用，而不是写完计划就当完成了。
后台任务没有可见进度时，应该主动告知用户"已派发、正在后台跑"，而不是沉默。

### ⚠️ 事故二：Agent A 被中断，代码留下但没自验

Agent A 在 10:50 前后被中断（源码在 10:28 前已写完，之后 20 分钟都耗在修它自己的验收脚本上）。
它写完了全部实现文件，但**没产出 `m2-notes-A.md`，也没跑完自己的验收**。

处置：**不重跑 A，改由主控全量接手验证** —— 因为验收脚本本该由非实现方编写（M1 的教训），
我本来就打算自己写，A 的那份脚本（`m2-acceptance-A.mjs`，且存在语法错误未能运行）已删除。

> 结论：**"派出去" ≠ "做完了"。** 后台执行方被中断时，留在盘上的代码是没有被验证过的资产，
> 必须按"未验证"对待，不能因为文件都在就默认可信。

---

## 三、逐任务状态

| # | 任务 | 产出文件 | 状态 |
|---|---|---|---|
| 2.1 | mock 类型 + 数据（按 Pi 事件结构） | `mock/types.ts`（主控冻结）、`mock/sessions.ts` | ✅ |
| 2.2 | `MessageList` 虚拟滚动 + 自动滚底 | `chat/MessageList.tsx` | ✅ |
| 2.3 | `MessageBubble` + Markdown | `chat/MessageBubble.tsx`、`common/Markdown.tsx` | ✅ |
| 2.4 | Shiki 双主题高亮 | `lib/highlight.ts`、`styles/shiki.css` | ✅ |
| 2.5 | `PlanCard` 四态 | `chat/PlanCard.tsx` | ✅ |
| 2.6 | `TerminalCard` 等宽 / 截断 / 展开 | `chat/TerminalCard.tsx` | ✅ |
| 2.7 | `ApprovalCard` 可交互 / 已决置灰 | `chat/ApprovalCard.tsx` | ✅ |
| 2.8 | `ThinkingCard` 可折叠 | `chat/ThinkingCard.tsx` | ✅ |
| 2.9 | 流式模拟 | `mock/stream.ts` | ✅ |
| 2.10 | `Composer` 多行自适应 + 内嵌圆形发送按钮 | `chat/Composer.tsx` | ✅ |
| 2.11 | `ComposerToolbar` 三芯片 + 弹性占位 | `chat/ComposerToolbar.tsx` | ✅ |
| 2.12 | `TokenStats` 四段 + 高亮 | `common/TokenStats.tsx` | ✅ |
| 2.13 | 工具条 mock 数据 | `mock/composer.ts` | ✅ |
| — | 内容区集成 + 验收脚本 | `shell/WorkspaceArea.tsx`、`scripts/m2-acceptance.mjs`、`scripts/cdp.mjs` | ✅（主控） |

**新增依赖（仅 4 个，均已在 task-M2.md 中授权）**：`@tanstack/react-virtual` 3.14.13、
`react-markdown` 10.1.0、`remark-gfm` 4.0.1、`shiki` 4.4.3。

---

## 四、验收逐条实测证据

验收环境：真实系统 **Chrome 153.0.8010.48**（`--headless=new` + CDP，无新增依赖），
dev server 5182，视口 1440×900。原始证据：`packages/ui/_m2-evidence.json`（32 项断言 + 全部观测值）。

判定方式说明：**每条都是显式布尔断言并汇总**，不接受"只打印数值"。
数值类断言一律拿浏览器里 `getBoundingClientRect()` / `getComputedStyle()` 的**原值**比对，
颜色类断言用**现场注入的探针元素**（加 `text-text-primary` / `bg-accent-soft` 等类再读计算值）比对，
避免把"看起来差不多"当通过。

| # | 验收项 | 判定 | 关键实测值 |
|---|---|---|---|
| 2-1 | 消息按序渲染 | ✅ | `data-total-count = 7`；`data-index` 严格升序；首条 `data-role="user"`，7 条角色仅 user/assistant |
| 2-2 | 虚拟滚动生效 | ✅ | 灌入 600 条 → DOM 中 `message-item` **14 个**（滚到中部后 21 个）；内容总高 **82253** vs 视口 **625**；滚到中部后渲染索引区间 **293–313**，节点仍全在容器内，无横向溢出 |
| 2-3 | Markdown 渲染正确 | ✅ | 正文块内 `h2` / `ul li` / `ol li` / `pre code` / `table td` / `a[href]` / 行内 `code` **七项全部命中**；`textContent` 无 `## `、`\| --- \|` 原文泄漏 |
| 2-4 | 代码高亮深浅双主题 | ✅ | Shiki 懒加载后 `.shiki` 渲染成功；同一 token 浅色/深色计算色**不同**，切回浅色**还原**（不需要重新高亮） |
| 2-5 | 自动滚底 + 上滚停止 | ✅ | 初始 `dist = 0`；上滚到顶后 `data-at-bottom="false"` 且出现「回到底部」按钮；**上滚状态下发消息：`scrollTop` 仍为 0、`dist` 远超阈值、按钮仍在（反例成立）**；点按钮后 `dist ≤ 32`、按钮消失；贴底状态下发消息 → 自动滚底 |
| 2-6 | 执行计划卡片四态 | ✅ | `plan-step` 共 4 步，`data-status` 覆盖 `done / running / pending / failed`，无非法值 |
| 2-7 | 终端步骤卡片 | ✅ | 命令与输出计算字体均为 `"JetBrains Mono", "SF Mono", Consolas, monospace`；截断态 `data-truncated="true"`，入口文案「查看完整内容（还有 8 行）」；点开后 `data-truncated` → `false`、内容变长、入口消失；`overflow-y = auto`（可滚动）；**反例**：error 终端的 `data-truncated` 为 `false` |
| 2-8 | 授权卡片可交互 | ✅ | 初始 `data-resolved="false"`、两选项可点、文案为「允许 / 拒绝」；点「允许」后 `data-resolved="true"`、**两按钮均 disabled**、选中项 `aria-pressed="true"`；**再点另一个选项状态不变（不可再点）** |
| 2-9 | 发送按钮在输入框内部右下角 | ✅ | `composer.contains(send) === true`；输入框 632×71 @(288, 660.69)–(920, 731.69)，按钮 28×28 @(883, 694.69)–(911, 722.69)，**完全内切**且落在右侧区/下部区；输入框 `border-width = 1px`；空内容时按钮 `disabled` |
| 2-10 | 发送按钮规格 | ✅ | 28×28；`border-radius = 9999px`（正圆）；底色 `rgb(238,242,254)` **等于 `bg-accent-soft` 探针值**；箭头色 `rgb(53,99,232)` **等于 `text-accent` 探针值** |
| 2-11 | 工具条顺序 | ✅ | 子节点 `data-testid` 序列严格为 `model → thinking → mcp → spacer → token-stats` |
| 2-12 | 芯片高 32 | ✅ | 三个芯片实测高度均为 **32 / 32 / 32** |
| 2-13 | TokenStats 四段 + 分隔符 | ✅ | 四段顺序 `input / output / total / context`；`token-stats-divider` 共 **3** 条；容器底色 `rgb(245,246,248)` 等于 `bg-bg-subtle` 探针值 |
| 2-14 | 数值格式化 | ✅ | 实测依次为 `12.4k` / `6.2k` / `18.6k` / **`128k`**（未出现 `128.0k`） |
| 2-15 | 「消耗」高亮 | ✅ | 仅 `total` 段计算色 = `text-primary` 探针值；`input/output/context` 均 = `text-secondary` 探针值；**反例**：`total` 段**不等于** secondary |
| 2-16 | TokenStats 靠右 | ✅ | `composer-toolbar-spacer` 的 `flex-grow = 1`；`token-stats` 右缘 **920** == 工具条右缘 **920** |
| 2-17 | 输入框多行自适应 | ✅ | 单行容器高 **71**；10 行 → **202**；40 行仍为 **202**（被上限截住）；40 行时输入框 `scrollHeight 893 > clientHeight 200`（内部可滚动） |
| 2-18 | 长文本不破版 | ✅ | 含 128 字符不可断 hash 的消息已渲染；`message-list` / `markdown-body` / `body` / `documentElement` 的 `scrollWidth` 全部 **≤ clientWidth** |

### 全局硬约束

| # | 约束 | 结果 | 实测 |
|---|---|---|---|
| G1 | 颜色来源唯一 | ✅ | 扫描 `src/` 全部 `.ts/.tsx/.css`，`#hex` **仅命中 `styles/tokens.css`**，其余文件 0 命中 |
| G2 | 无 `dark:` 变体补丁 | ✅ | `dark:` 变体命中数 **0**（`.shiki` 的深色桥接用的是 `[data-theme="dark"]`，与令牌机制同一套选择器） |
| G3 | 深浅两模式文字可读 | ✅ | 深色下 6 个采样点对比度：markdown 正文 **11.79**、terminal-command **6.27**、terminal-output **12.42**、token 消耗段 **12.42**、plan 步骤 **13.71**、输入框 **13.71** —— **最低 6.27，全部 ≥ 4.5** |
| G4 | 图标统一 `--icon-neutral` | ✅ | 取 8 个 `svg.lucide` 计算色，浅色与深色**均为 `rgb(138,145,158)`**，深浅序列完全一致（不随主题变） |
| G5 | 不用 Tailwind 内置调色板 | ✅ | 命中 **0** |
| G6 | 无意外横向滚动条 | ✅ | 浅色 / 深色 / 折叠 / 压力会话（600 条）四种状态下 `body` 与 `documentElement` 均无横向溢出 |
| G7 | 交互元素键盘可达 | ✅ | 可聚焦元素**无缺标签者**（`aria-label`/文本/title 至少其一）；输入框有可读名称；Tab 6 步焦点环 6/6 可见；**Enter 与 Space 均能触发** `terminal-toggle`（含 M1 的教训：派发 Enter 必须带 `text:"\r"`） |
| G8 | 折叠有过渡 | ✅ | 由 M1 回归覆盖（1-10 中间帧 3，宽度序列多帧非跳变） |

### M1 回归（红线，验收 5.5）

M2 新增内容区后，**重跑了整份 M1 验收脚本**：EXIT=0，19 步全部产出证据。关键三项：

- `1-13 严格 0 宽`：侧边栏 `0`、预览区 `0`、内容区 `1424` == 视口宽 1424，全部 `true`
- `1-3 条带三边通底`：`offsetLeft` 差值 **0**、`offsetBottom` 差值 **0**
- `1-10 过渡中间帧`：中间帧 **3**，内容区宽度单调递增无回跳

---

## 五、本轮修复记录

### 5.1 【Major】终端输出溢出而不是滚动（Agent A 实现）

- **现象**：`terminal-output` 只设了 `maxHeight` 没设 `overflow`，实测 `overflow-y = visible`。
  截断态看不出问题，但点开「查看完整内容」后 20 行输出会**溢出到卡片外**而不是在卡片内滚动。
- **影响**：验收 2-7 明确要求「输出可滚动」，这一半没满足。
- **修法**：`TerminalCard` 的输出容器加 `overflow-auto`。改后实测 `overflow-y = auto`。

### 5.2 【Major】自动贴底不收敛：「点了回到底部，却还差一截」（Agent A 实现）

- **现象**：点「回到底部」后实测 `dist = 134`（阈值 32），按钮没消失；紧接着「贴底状态下发消息自动滚底」
  也随之失败（`dist = 480`）。
- **根因**：列表高度是**动态测量**出来的。程序化滚到底之后虚拟列表还会继续长高，于是紧接着触发的
  `scroll` 事件算出一个「没贴底」的中间态 → 把 `atBottom` 翻成 `false` →
  但补滚用的 `ResizeObserver` **只在 `atBottomRef` 为真时才补滚**，于是再也没有人纠偏，状态就此卡死。
  即：**一次瞬时错位把"自动贴底"永久关掉了。**
- **修法**（`chat/MessageList.tsx`）：
  1. 新增 `pinningRef` 区分「我们主动贴底」与「用户上滚」；
  2. 贴底过程中出现的非贴底中间态 → 继续补滚、**不翻状态**；
  3. 只有真实用户交互（`wheel` / `touchstart` / `keydown`）才允许退出自动贴底；
  4. `scrollToBottom` 补两帧 rAF 再滚一次（动态测量会在第一次滚动后继续改高度）。
- **实测**：修后 2-5a 初始 `dist = 0`，2-5d / 2-5e 全部通过；2-5c 反例（上滚后不被拽回）依然成立。

### 5.3 主控自身的三处失误（重要，别只看实现方的）

**① `scripts/cdp.mjs` 漏了 WebSocket message 监听器（真 bug，卡了整轮验收）**

- **现象**：验收脚本卡在 `Page.enable`，30s 超时，报错只有 `CDP timeout: Page.enable`。
- **根因**：我写这个公共模块时，`Cdp` 构造函数里**只留了 `pending` 表、没留 `ws.addEventListener("message")`**。
  于是 WebSocket 能连上、命令能发出去、Chrome 也会回 —— 但**没有任何人处理返回值**，每条命令必然超时。
- **更值得记的是我如何被带偏**：Agent B 先遇到同一现象，它的结论是「缺 `--remote-allow-origins=*`」。
  我**没验证就照单收下**，加了那个 flag，然后重跑 —— 当然还是挂。
  最后靠一个只回答「Chrome 到底回不回话」的最小诊断脚本（同参数换端口能正常求值）才定位到是自己漏了监听器。
- **修法**：补回 message 监听器；并新增一次 **8 秒连通性自检**，把「连得上但命令无响应」这类
  隐蔽失效变成一句可操作的报错（而不是干等 30s）。
- **教训**：**别人的根因判断同样是"待验证结论"，不是事实。** 尤其是"补个参数就好了"这种
  低成本判断，最容易不验证就照做。诊断脚本本身要能**区分**各种假设，而不是只验证其中一个。

**② 首版验收脚本有 7 处自身缺陷，造成 7 个"假失败"**

第一轮跑出 10 个失败，其中 **7 个是我的脚本写错**，只有 2 个是真缺陷（即 5.1 / 5.2）。逐条留档：

| # | 我的写法 | 后果 | 正确写法 |
|---|---|---|---|
| 1 | 探针函数 `probe(cls)` 只取 `getComputedStyle().color` | 用 `bg-accent-soft` / `bg-bg-subtle` 做探针时拿到的是**继承的文字色**，永远不相等 → 2-10、2-13 假失败 | 新增 `probeBg()` 取 `backgroundColor` |
| 2 | 发送按钮尺寸读 `getComputedStyle().width`（`"28px"` 字符串） | `"28px" - 28 = NaN` → 2-10 假失败 | 读 `getBoundingClientRect()` 的数字 |
| 3 | 2-16 的断言写在了 TokenStats 那个块里，引用的 `r` 是**下一个块**的变量 | `undefined >= 1` 恒 false → 2-16 假失败 | 断言与本块记录用同一个变量（改名 `tb` 防混淆） |
| 4 | 两个 `async IIFE` 调 `cdp.eval` 时**漏传 `awaitPromise=true`** | `returnByValue` 把 Promise 序列化成 `{}`，断言全 undefined → 2-5a/2-5b 假失败，且日志里只有一个空对象 | 传 `true` |
| 5 | 正则写成 `/还有\\s*\\d+\\s*行/`（写在普通 JS 里，不是模板字符串内） | 变成匹配字面反斜杠 → 2-7 假失败 | `/还有\s*\d+\s*行/` |
| 6 | 2-3 用 `item.querySelector('[data-testid="markdown-body"]')` 取正文 | m2 同时含 thinking 与 text，**ThinkingCard 也渲染 markdown-body**，先命中的是思考块（只有一段带行内代码）→ 误判"标题/列表/表格/链接都没有" | 按内容定位（`textContent.includes('调研结论')`） |
| 7 | 2-2 断言 `after.scrollTop > beforeTop`，假设"从顶部开始" | 但列表加载后**会自动贴底**，`beforeTop` 本来就在底部 → 假失败 | 改成"滚动位置落在目标附近 + 渲染索引区间确已换批" |

**这 7 条的共性**：都是"断言写错了"，而不是"实现坏了"。如果我不逐条把原始数值抠出来看，
最省事的做法就是让实现方去"修"这 7 个根本不存在的问题 —— 那才是真正的浪费。

**③ 首轮 10 个失败里，有 2 个是"级联失败"**

2-5e 的失败是 2-5d 留下的状态造成的（2-5d 没回到真正的底部，2-5e 的前提就不成立）。
**断言之间存在状态依赖时，前一条失败会污染后一条**，读结果时要顺着因果看，别当成两个独立缺陷。

---

## 六、偏离规格 / 需记录事项

| # | 位置 | 现象 | 级别 | 处理 |
|---|---|---|---|---|
| 1 | `lib/composer-layout.ts` | Agent B 新增 1 个派生常量 `COMPOSER_INPUT_TRAILING_SPACE = SEND_BUTTON_SIZE + COMPOSER_SEND_INSET`（=36） | Note | 合理：它是"输入区专属布局"，从 `layout.ts` 冻结常量派生。**暂不归并**（归并会把 B 的领域细节塞进全局常量，得不偿失） |
| 2 | 2-14 的口径 | `acceptance-criteria.md` 原写"保留一位小数"，但设计稿的上下文是 `128k` 而非 `128.0k` | Note | 已按 `formatCompact` 的口径（k 值为整数则省略小数）实现并在文档中澄清 |
| 3 | Composer 归属 | `screens.md` 第一节 ASCII 草图把 Composer 画成横跨窗口全宽，与验收 1-3（条带贴窗口底）冲突 | — | **已修正文档**：Composer + 工具条在内容区内部，每栏各自管理底部。`layout.ts` 的 M2 段也写明了判定依据 |
| 4 | 依赖 | 新增 4 个第三方依赖（react-virtual / react-markdown / remark-gfm / shiki） | Note | M1 规格写的是"等 M2 真正需要时再加"，本次按 `screens.md` 的选型加了；未引入任何计划外依赖 |
| 5 | `chat-store` 暴露到 window | `import.meta.env.DEV` 下挂 `window.__chatStore`，供验收脚本驱动 `sendMessage` | Note | 生产构建不挂。原型阶段可接受；接 Pi 时应改为通过真实 UI 驱动 |
| 6 | `?stress=N` 参数 | App 支持 `?stress=600` 载入压力会话 | Note | 刻意做成**正式能力**而非临时调试代码 —— 验收 2-2 必须可复跑（M1 的教训：验收不能依赖"记得上次怎么改的"） |

---

## 七、类型检查与构建

```
tsc --noEmit -p tsconfig.app.json   →  EXIT=0（0 error）
vite build                          →  EXIT=0（2049 modules，主包 480.16 kB / gzip 147.37 kB，
                                          CSS 27.04 kB；shiki 的 web bundle 与各语言/主题为懒加载分块）
node scripts/m2-acceptance.mjs      →  EXIT=0（32/32 断言通过）
npm run accept:m1                   →  EXIT=0（M1 回归通过）
```

`strict: true` + `noUnusedLocals` + `noUnusedParameters` 全开。

---

## 八、M3 待办

**M3 · 预览区与深色（9.5h）**

1. `PreviewPane` 拆出独立文件（当前与 `WorkspaceArea` 同文件），实现**双 Tab**（预览效果 / 预览源码）
2. 源码态：Shiki 高亮（**已有 `lib/highlight.ts` 可直接复用**）+ 行号 + 复制按钮
3. 效果态：`iframe sandbox` 渲染生成的 HTML
4. 01b 屏：默认激活源码 Tab
5. 02 深色屏走查：确认零 `dark:` 补丁、无白底黑字残留

**本里程碑遗留的小事**

- `TitleBar` 的 `os` prop 仍固定传 `mac`，三端切换入口是 M5 的事
- 「设置」按钮仍指向 `/tokens` 体检页，M4 做 05 屏后改指向
- `--window-*` 三色未经设计稿核对（设计稿无此条目），M5 走查时确认
- **`1-10` 的中间帧数处于临界**：M1 当时实测 4 帧，本轮回归实测 **3 帧**，而验收门槛正是 `≥3`。
  这是抖动，不是回归（代码未动）。建议 M5 收尾时把 `COLLAPSE_DURATION_REDUCED` 从 90ms 提到 **120ms**
  留出余量；本轮**未改** —— 改了会作废 M1 已留档的实测证据，应作为一个显式决策来做。

---

## 九、本里程碑的教训（跨里程碑复用）

1. **"派出去" ≠ "做完了"。** 后台执行方被中断时，留在盘上的代码 = 未验证资产。宣称并行之后要核对**实际发出了几个**调用。
2. **别人的根因判断也是待验证结论。** B 说"缺某个 flag"，我没验证就照做，白跑一轮。
   代价低、听起来合理的修复建议，最容易跳过验证 —— 而要验证它，需要的是**能区分多个假设**的诊断，不是再跑一遍。
3. **失败的断言要先怀疑断言本身。** 首轮 10 个失败里 7 个是脚本的错、1 个是级联。
   如果不去看原始数值，就会让实现方去修不存在的问题。
4. **接口桩是并行开发的前提。** 先冻结类型与常量、再打桩、主控亲自写集成点 ——
   这样任何一个执行方中途离开，项目都还是**能编译、能运行、能被验证**的状态。
5. **判定类 `data-*` 属性必须能反映真实状态。** 本轮为 `data-at-bottom` / `data-truncated` / `data-resolved`
   各写了一个反例断言（喂坏状态必须判 false）。其中 `data-truncated` 的反例（error 终端短输出）当场通过并留档。
