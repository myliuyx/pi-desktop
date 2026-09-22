# M3 进度与验收记录

> 更新日期：2026-09-22
> 里程碑：**M3 · 预览区与深色版**（计划净工时 9.5h）
> 配套：[task-M3.md](./task-M3.md) · [development-plan.md](./development-plan.md) 第三节 M3 · [acceptance-criteria.md](./acceptance-criteria.md) M3 表 · [progress-M2.md](./progress-M2.md)（教训）
> 执行方：general-purpose agent（m3-preview，单人实现）；本文档由执行方撰写，
> **验收 3-1~3-8 的逐条结论留给主控复核定稿**，实现方仅提供实测数据。

---

## 一、结论

**M3 四项任务（3.1~3.4）代码已全部落地，规格书第五节自验命令全部跑完且 EXIT=0，
自查走查 9 组断言全过、M1/M2 回归全绿。** 可交主控复核。

| 项目 | 结果 |
|---|---|
| 3.1 双 Tab（`shell/PreviewPane.tsx` + `primitives/Tabs.tsx`） | ✅ 已实现并实测 |
| 3.2 源码态（Shiki 高亮 + 行号 + 复制 + `mock/preview.ts`） | ✅ 已实现并实测 |
| 3.3 效果态（`iframe sandbox`） | ✅ 已实现并实测 |
| 3.4 02 深色版走查 | ✅ 已走查，零 `dark:` 补丁、零组件 hex，无需修令牌 |
| `tsc --noEmit -p tsconfig.app.json` | **EXIT=0**（真实口径，见第五节教训 2） |
| `vite build` | **EXIT=0**（2052 modules，主包 489.41 kB / gzip 150.79 kB，CSS 27.71 kB） |
| `npm run check:cn` | **EXIT=0**（15/15） |
| `npm run accept:m1`（红线回归） | **EXIT=0**（1-13 严格 0 宽、1-10 中间帧 3、1-12 内容区 1424 均成立） |
| `npm run accept:m2`（复用 5180） | **EXIT=0**（32/32 断言） |
| 实现方自查走查（9 组断言） | **9/9 通过**（证据 `packages/ui/_m3-walk-evidence.json`，脚本已删、可按第四节复现） |
| 新增 npm 依赖 | **0**（shiki / lucide-react 均复用既有） |
| 遗留 Blocker / Major（实现方自查口径） | **0** |

---

## 二、执行方式

单人按 task-M3.md 顺序执行：先做最高危的 PreviewPane 搬家 → 立即跑 M1 回归 →
再增量实现双 Tab / 源码态 / 效果态 → 深色走查 → 全套自验。

搬家严格「逐字搬运、先回归再增量」：`PreviewPane`（含 `PreviewPaneProps` 与全部折叠相关
className / style / 属性）先原样落到 `shell/PreviewPane.tsx`，两处引用方（`WorkbenchScreen.tsx`、
`shell/index.ts`）改 import 后立即跑 `accept:m1`（EXIT=0，1-10 / 1-12 / 1-13 全绿），
然后才开始写双 Tab。

---

## 三、逐任务状态

| # | 任务 | 产出文件 | 状态 |
|---|---|---|---|
| 3.1 | `PreviewPane` 搬家 + 双 Tab | 新 `shell/PreviewPane.tsx`（从 `WorkspaceArea.tsx` 搬出）、新 `primitives/Tabs.tsx`、改 `shell/WorkspaceArea.tsx`（删占位组件 + 清 import）、改 `shell/WorkbenchScreen.tsx` 与 `shell/index.ts`（import）、改 `lib/layout.ts`（M3 常量段） | ✅ |
| 3.2 | 源码态 | `shell/PreviewPane.tsx`（`PreviewSource` / `CopySourceButton` / `withLineData`）、新 `mock/preview.ts`、`styles/shiki.css`（追加 `.preview-source` 行号段） | ✅ |
| 3.3 | 效果态 | `shell/PreviewPane.tsx`（iframe sandbox="" + srcDoc） | ✅ |
| 3.4 | 02 深色版走查 | `ui-store.ts`（`previewTab`）、`App.tsx`（`?preview=`）、走查结论（见四） | ✅ |
| — | 状态与入口 | 改 `store/ui-store.ts`（`previewTab` + localStorage 持久化 + `initTheme` 恢复）、改 `App.tsx`（`?preview=code/effect` 仿 `?stress=` 模式）、改 `primitives/index.ts`（导出 Tabs） | ✅ |

**layout.ts 新增常量（M3 段，未动任何既有值）**：`PREVIEW_TABBAR_HEIGHT = 44`、
`PREVIEW_TABBAR_PADDING_X = 12`、`PREVIEW_COPY_RESET_MS = 1500`。

**实现要点**：

- `Tabs` 为 headless 受控组件：`role="tablist"/"tab"` + `aria-selected` + `data-active` +
  roving tabindex（激活项 0 / 其余 -1）+ ArrowLeft/ArrowRight/Home/End 键盘切换（automatic
  activation）；泛型 `<T extends string>` 让 store 的 `PreviewTab` 枚举与 `onChange` 类型精确对齐。
- 源码态行号用 **CSS counter**（shiki 每行输出 `.line` span，`::before` 参与同一行内流，
  行高/步进天然对齐）+ `position: sticky` 固定 gutter 列（横向滚动时行号保持可见），
  底色桥接 `--shiki-light-bg` / `--shiki-dark-bg`，与 `.shiki` 自身同一套机制；另给每个
  `.line` 注入 `data-line="N"` 序号，便于验收脚本定位行号节点。
- `data-line-count` 在高亮渲染完成后从 DOM 数 `.line` 数量写入（实测 137，与 DOM 行数一致），
  不从源字符串猜（尾随换行会差一行）。
- 复制按钮：`navigator.clipboard.writeText` 失败回退 `textarea + execCommand`，再失败静默；
  点击后一律进入「已复制」态 1.5s（`PREVIEW_COPY_RESET_MS`）——headless 无剪贴板权限时
  走查也能看到该态，不抛错。
- mock（`mock/preview.ts`）：自包含静态 HTML 137 行（规格 80~150 内），内联 `<style>`、
  无 `<script>`、含中文标题/表格/列表；**颜色全用 `rgb()` 记法而非 `#hex`** —— 该文件是
  独立文档用不了应用令牌，而 G1 检查模式是全局搜 `#hex` 字面量（范围含 src/ 全部 .ts），
  `rgb()` 记法两全（见第六节偏离 1）。

---

## 四、自验实测证据（命令 + exit code + 关键数值）

### 4.1 规格书第五节命令（全部在 `packages/ui` 下）

| 命令 | exit code | 关键数值 |
|---|---|---|
| `tsc --noEmit -p tsconfig.app.json`（真实口径） | **0** | 0 error（strict + noUnusedLocals + noUnusedParameters 全开） |
| `tsc --noEmit`（= `npm run typecheck` 的裸口径） | 0 | **见第五节教训 2：裸口径在 references 型 tsconfig 上不检查任何文件，必须用 `-p` 口径才算数** |
| `tsc -b && vite build`（= `npm run build`） | **0** | **2052 modules**（M2 为 2049，+3 = PreviewPane / Tabs / mock/preview）；主包 `index-*.js` **489.41 kB / gzip 150.79 kB**（M2：480.16 / 147.37）；CSS **27.71 kB**（M2：27.04）；shiki 语言/主题仍为懒加载分块 |
| `npm run check:cn` | **0** | **15/15 通过** |
| `npm run accept:m1`（先 `npm run dev -- --port 5180 --strictPort`） | **0** | 1-13：侧边栏 0、**预览区 0**、内容区 1424 == 视口宽，断言全 true；1-10：**中间帧 3**（≥3 达标，与 M2 末轮持平的临界值，见 4.4）；1-12：两栏收起内容区 1424、无横向滚动条；G4 图标 8 样本均 `rgb(138,145,158)` |
| `M2_ORIGIN=http://127.0.0.1:5180 node scripts/m2-acceptance.mjs` | **0** | **32/32 断言通过**（含 2-5 自动滚底全链、G3/G4/G6/G7） |

### 4.2 实现方自查走查（非验收脚本；Chrome 153 headless + CDP 端口 9341，证据 `packages/ui/_m3-walk-evidence.json`）

| # | 断言组 | 结果 | 关键实测值 |
|---|---|---|---|
| 1 | 默认态：effect 激活 + iframe 沙箱 | ✅ | `preview-tab-effect` `data-active="true"` + `aria-selected="true"`；code 未激活；roving tabindex 0/-1；`preview-iframe` 存在且 `sandbox=""`；**Tab 条高 44** |
| 2 | 源码态三要素 | ✅ | 点击 code 后互斥切换；`data-line-count=137` == DOM `.line` 数 137 == `data-line` 序号数；行号 `::before` content=`counter(preview-line)`、有色有底；pre 带四组 `--shiki-*` 变量；效果态 iframe 卸载；复制按钮在；`font-family` 含 JetBrains Mono |
| 3 | 复制按钮 | ✅ | 「复制」→ 点击 → 「已复制」→ ~1.7s 后回落「复制」 |
| 4 | 切回效果态 | ✅ | iframe 重新渲染、sandbox 仍在；源码面板与复制按钮卸载 |
| 5 | `?preview=code` 进入（3-4） | ✅ | 源码 Tab 默认激活、`localStorage["preview-tab"]="code"`；清除持久化后无参进入默认 effect |
| 6 | 深浅跟随（3-7 机制） | ✅ | 同一 token 计算色 浅 `rgb(36,41,46)` → 深 `rgb(225,228,232)`；pre 底 白 → `rgb(36,41,46)`；**切回浅色还原（无需重高亮）** |
| 7 | 深色无白底（3-6 抽查） | ✅ | preview-pane `rgb(28,31,36)`、tab 条/code 激活项/源码容器/shiki/行号/复制按钮/内容区/侧边栏逐个采样，**无纯白与近白（>240,240,240）背景**；行号底 `--shiki-dark-bg` 桥接生效 |
| 8 | 键盘切换 | ✅ | ArrowRight → 源码激活且焦点跟随；ArrowLeft → 切回效果且焦点跟随 |

00 屏 `/tokens` 深色回归（规格 3.4 顺手确认项）：扫描 400 个元素，排除带内联底色的色样
（Swatch / 深浅并列对比卡，浅色值是功能本身）后**真白底残留 0**、无横向溢出，body
`rgb(22,24,28)` / 文字 `rgb(232,234,237)`。✅

### 4.3 全局硬约束自查（文件级搜索）

| # | 约束 | 结果 | 实测 |
|---|---|---|---|
| G1 | 组件无 `#hex` | ✅ | `#([0-9a-fA-F]{3,6})\b` 扫 src/ 全部 .ts/.tsx/.css：**仅 `styles/tokens.css` 命中**；`mock/preview.ts` 用 `rgb()` 记法 0 命中 |
| G2 | 无 `dark:` 变体 | ✅ | `\bdark:` 命中 5 处，**全部是 M0-M2 已有代码的非变体命中**：`TokensScreen.tsx:82`（JS 对象键 `dark:`）、`highlight.ts:16`（注释）、`highlight.ts:85`（shiki API 参数对象键 `themes: { dark: ... }`）、`shiki.css:4`（注释）；**M3 新增代码 0 命中**（新增 CSS 深色选择器一律 `[data-theme="dark"]`） |
| G5 | 无 Tailwind 内置调色板 | ✅ | 新增代码仅用令牌类（`bg-bg-subtle` / `text-text-secondary` 等） |

### 4.4 1-10 中间帧的临界值说明

终版回归实测中间帧 **3**（门槛 ≥3）。与 progress-M2 第八节记录一致：这是 rAF 采样抖动
（M1 首轮 4 帧），代码未动折叠时长，非 M3 引入的回归。M5 提 `COLLAPSE_DURATION_REDUCED`
到 120ms 留余量的既有建议仍然有效，本轮按规格未改。

---

## 五、本轮修复记录（两起真实事故，教训已提炼）

### 5.1 【流程】同文件并行 Edit 造成改动静默丢失（两处，均已修复并复验）

- **现象**：第一轮走查发现「点击 Tab 无反应」。诊断探针显示原生 click 触发、React fiber
  上 `onClick` 存在，但手动调用抛 `onChange is not a function` —— 运行时 store 里根本没有
  `setPreviewTab`。排查发现 `ui-store.ts` 与 `App.tsx` 各有一批编辑**报成功但部分未落盘**：
  ui-store 缺 create() 实现体（interface 与 initTheme 有、实现无）；App.tsx 缺 import 与
  useEffect 调用（函数定义有）。
- **根因**：同一条消息里对**同一文件**并行发出多个 Edit，写入相互覆盖（最后写者基于旧内容
  胜出），工具逐个报成功但内容丢失。
- **修法**：改为全量 Write / 串行 Edit 重写受影响文件；此后同文件修改一律串行。
- **修后复验**：`-p tsconfig.app.json` 口径 0 error；走查 9/9。

### 5.2 【工具链】`npm run typecheck` 的裸 `tsc --noEmit` 是假绿（重要，跨里程碑）

- **现象**：5.1 的坏代码（引用未导入标识符）在 `tsc --noEmit` 下 **EXIT=0**，两次。
- **根因**：`tsconfig.json` 是 `"files": []` + references 的工程引用结构，裸 `tsc --noEmit`
  **不检查任何文件**。M2 记录里的真实口径一直是 `tsc --noEmit -p tsconfig.app.json`
  （progress-M2 第七节），本轮第一次误用了裸口径还差点当成通过。
- **处置**：本轮自验两个口径都跑了并如实分列（见 4.1）；**建议后续把 `package.json` 的
  `typecheck` script 改成 `tsc --noEmit -p tsconfig.app.json`**（属验收基线改动，未擅动，
  留主控决策）。
- **教训**：**EXIT=0 不等于检查发生过。** 引用配置结构先看一眼，别把「命令没报错」当
  「命令检查了」。

### 5.3 【自查】两处走查探针写错（自查脚本缺陷，非实现缺陷，M2 教训 3 的复现）

- 3-2 断言的 shiki 变量检查用了 `.shiki span`（第一个命中 `.line` span，它没有内联变量），
  误报「无双主题变量」；改成 `.shiki` pre 本身（变量载体）+ `code span:not(.line)`（token）。
- 00 屏深色抽查第一版把**色板样卡**（带内联底色的 Swatch）当成白底残留误报 12 处；
  排除内联底色元素后真残留 0。
- 两处修后均复验通过。与 M2 首轮 7 个假失败同一性质：**失败的断言要先怀疑断言本身**。

---

## 六、偏离规格 / 需记录事项

| # | 位置 | 现象 | 级别 | 处理 |
|---|---|---|---|---|
| 1 | `mock/preview.ts` | 规格未规定产物 HTML 的颜色写法；因 G1 全局搜 `#hex`（范围含 .ts），独立文档的样式值用 `rgb()` 记法而非 hex | Note | 视觉不变、不产生 G1 误报；已在文件头注释说明理由 |
| 2 | `PreviewPaneProps` | 双 Tab 落地后占位用的 `caption` prop 已无意义，随搬家一并删除（规格第七节允许合理增删） | Note | 引用方 `WorkbenchScreen` 本就无参使用，无破坏面 |
| 3 | 源码态工具行 | 复制按钮没有单独做一行工具栏，而是放 **Tab 条右端**（仅源码态渲染） | Note | 少一个高度常量、无浮层遮挡问题；验收 3-2 按 testid 定位不受影响 |
| 4 | 行号实现 | 行号在 CSS counter 之外还给每行 `.line` 注入 `data-line="N"`（shiki 行 span 本无属性，按固定前缀替换安全） | Note | 规格允许 counter 方案；注入 data 属性是为了给验收脚本一个可定位的「行号节点」落点 |
| 5 | `package.json` typecheck script | 未改（见 5.2），本轮以 `-p` 口径作为事实标准 | Note | 待主控决策是否修正 script |
| 6 | 深色修复 | 02 深色走查**未发现需要修复的硬编码或不可读处**，M3 未改任何令牌值、未新增深色专属样式（`shiki.css` 追加段为源码态布局+双主题桥接，非 dark 补丁） | Note | 与 acceptance-criteria 第四节「02 屏不该有任何独立代码」的预期一致 |

---

## 七、遗留项

- `1-10` 中间帧临界（3 帧，门槛 ≥3）：沿袭 progress-M2 的记录，建议 M5 把
  `COLLAPSE_DURATION_REDUCED` 90ms → 120ms，本轮未动。
- `package.json` 的 `typecheck` script 口径修正（裸 → `-p tsconfig.app.json`）待主控决策。
- `dark:` 字面搜索的 5 处既有命中（对象键/注释）如主控希望做成「字面 0 命中」，
  需改 M0-M2 的既有文件（`highlight.ts` 的 shiki API 对象键无法改写，只能豁免口径），留主控复核时定口径。
- 实现方自查走查脚本已按「验收脚本由主控编写」的规矩删除，证据 JSON 保留在
  `packages/ui/_m3-walk-evidence.json`；复现方式见本文档第四节（或由主控的
  m3-acceptance.mjs 全量重验）。

---

## 八、验收对照表（3-1~3-8，**全部待主控复核**）

| # | 验收项 | 实现方实测（供复核） | 依赖 testid / 特征（已按契约暴露） | 结论 |
|---|---|---|---|---|
| 3-1 | 双 Tab 存在且互斥 | 点击互斥切换、`data-active` + `aria-selected` 同步、roving tabindex + 方向键 | `preview-tab-effect` / `preview-tab-code` | **待主控复核** |
| 3-2 | 源码态：高亮 + 行号 + 复制 | 三要素齐备；`data-line-count=137` == DOM 行数；行号 counter + `data-line` 序号 | `preview-source`、`data-line-count`、`.line[data-line]`、`preview-copy` | **待主控复核** |
| 3-3 | 效果态 iframe 隔离 | `preview-iframe` 存在且 `sandbox=""`（空值全沙箱） | `preview-iframe` + `sandbox` | **待主控复核** |
| 3-4 | 01b 默认激活源码 | `?preview=code` 进入激活源码 Tab 且持久化；`?preview=effect` 同理；清除后默认 effect | URL 参数 + `localStorage["preview-tab"]` | **待主控复核** |
| 3-5 | 零 `dark:` 补丁 | M3 新增代码 0 命中（既有 5 处为对象键/注释，口径见 4.3） | — | **待主控复核** |
| 3-6 | 深色无白底黑字 | workbench 含 PreviewPane 全区域 + 00 屏抽查均无白底残留（数值见 4.2-7） | — | **待主控复核** |
| 3-7 | 深色代码块可读 | `--shiki-dark` 桥接生效，切主题配色实时跟随无需重渲染（同 2-4 机制）；行号底色同步桥接 | 源码态切深色 | **待主控复核** |
| 3-8 | G1~G8 同口径 | G1 仅 tokens.css 命中；G5 命中 0；G3/G6/G7 由 M2 回归 32/32 覆盖；G8 由 M1 回归 1-10 覆盖 | — | **待主控复核** |

---

## 九、本里程碑的教训（跨里程碑复用）

1. **同文件并行 Edit 会静默丢改动。** 工具逐个报成功不等于内容都落盘；同文件修改必须
   串行（或一次全量 Write）。改完后用「重新 Read 全文」而不是「相信成功回执」。
2. **EXIT=0 不等于检查发生过。** references 型 tsconfig 下裸 `tsc --noEmit` 是空转；
   引入任何检查命令前先确认它真的在检查目标文件。
3. **失败的断言先怀疑断言本身**（M2 教训 3 再验证）：本轮 3 个自查失败里 1 个是探针选错
   元素、1 个是抽查口径把功能当缺陷、1 个才是真缺陷（且根因是 5.1 的流程问题而非业务代码）。
4. **G1 的字面搜索范围包含数据文件。** mock 里的「生成物 HTML」用 `rgb()` 记法可避开
   误报——但要写明理由，别让后人以为颜色随手写。

---

## 十、主控复核（定稿，2026-09-22）

主控不采信执行方回报，全部独立复跑 + 自写验收脚本定稿。**结论：M3 通过验收，3-1~3-8 全部成立，可进入 M4。**

### 10.1 主控独立复跑（非采信执行方数据）

| 命令 | exit code | 说明 |
|---|---|---|
| `tsc --noEmit -p tsconfig.app.json` | **0** | 主控独立执行 |
| `tsc --noEmit`（裸口径，验证 5.2 的说法） | 0 | 主控读 `tsconfig.json` 确认 `"files": []` + references —— 裸口径确实无文件可查，5.2 属实 |
| `npm run build` | **0** | 主控独立执行 |
| `npm run check:cn` | **0** | 主控独立执行 |
| `npm run accept:m1` | **0** | 主控独立执行（dev server 5180） |
| `M2_ORIGIN=…5180 npm run accept:m2` | **0** | 主控独立执行，32/32 |

### 10.2 主控自写验收脚本 `scripts/m3-acceptance.mjs`（已加入 `npm run accept:m3`）

按 M2 铁律由主控（非实现方）编写：15 项显式布尔断言，**15/15 通过**，证据
`packages/ui/_m3-evidence.json`（可复跑）。覆盖：G1/G2/G5 静态扫描（45 个文件）、
3-1a/3-1b 双 Tab 互斥（含「效果态无源码面板 / 源码态 iframe 卸载」双向反例）、
3-3 iframe `sandbox=""` + srcdoc 4072 字符 + 占满 480×725、3-2 三要素（`data-line-count=137`
== DOM `.line` 数、`data-line` 序号连续 1..137、gutter 34.19px sticky、mono、5 种 token 色）、
复制按钮「已复制→1.9s 回落」、3-7 主题跟随（token 色 `rgb(3,47,98)`↔`rgb(158,203,255)`，
DOM 行数不变=未重渲染，深色 pre 底 `rgb(36,41,46)`=github-dark）、3-6+G3+G4+G6
（6 面板深色亮度 ≤0.014、交互元素最低对比度 6.27、图标双主题全 `rgb(138,145,158)`、无横向溢出）、
3-4a 持久化 + 3-4b `?preview=code` 入口。

### 10.3 验收对照定稿

| # | 验收项 | 结论 |
|---|---|---|
| 3-1 | 双 Tab 存在且互斥 | ✅（双向反例均实测） |
| 3-2 | 源码态：高亮 + 行号 + 复制 | ✅（137 行、counter+sticky gutter、复制回落实测） |
| 3-3 | 效果态 iframe sandbox 隔离 | ✅ |
| 3-4 | 01b 默认源码（`?preview=code` + 持久化） | ✅ |
| 3-5 | 零 `dark:` 补丁 | ✅（验收口径 = m2/m3 脚本的 Tailwind 变体正则，**命中 0**；字面搜索的 5 处既有命中均为对象键/注释，非变体，遗留#3 就此关闭——无需改 M0-M2 文件） |
| 3-6 | 深色无白底黑字残留 | ✅（含预览区/源码区 6 面板实测） |
| 3-7 | 深色代码块可读 | ✅（双主题桥接、无重渲染实测） |
| 3-8 | G1~G8 | ✅（G1/G2/G5 主控脚本直测；G3/G6 本轮直测；G4 直测；G7 由 M2 回归覆盖；G8 由 M1 1-10 回归覆盖） |

### 10.4 主控决策与新增遗留

1. **`typecheck` script 已修正**：`"tsc --noEmit"` → `"tsc --noEmit -p tsconfig.app.json"`
   （5.2 / 偏离5 / 遗留2 就此关闭）。依据：M0-M2 全部验收记录的事实口径即 `-p` 口径，
   裸口径在 references 型 tsconfig 上是空转。
2. **`npm run accept:m3` 已加入 package.json**（脚本本身由主控编写，非实现方产物）。
3. **新增 Minor 遗留（M5.3 打磨项）**：Tab 面板侧的 `role="tabpanel"` + `aria-labelledby`
   接线未做（Tabs 已输出 `aria-controls`，但内容区容器未挂对应 id/role）。不影响 3-1~3-8，
   归入 M5 交互打磨。
4. **既有遗留不变**：1-10 中间帧临界 3 帧（M5 提 `COLLAPSE_DURATION_REDUCED` 至 120ms 的
   建议维持）；`chat-store` 的 `window.__chatStore` 验收桩接 Pi 时还原。

### 10.5 主控复核方式备注

- 源码走读：`PreviewPane.tsx`（折叠特征逐字保留核对）、`Tabs.tsx`（aria/roving/键盘）、
  `ui-store.ts`（previewTab + initTheme 恢复）、`App.tsx`（`?preview=` 仿 `?stress=`）、
  `layout.ts`（M3 三常量）、`shiki.css`（`.preview-source` 段全令牌 + `--shiki-*` 桥接）。
- G1/G2 用主控自己的 Grep 独立扫过（hex 仅 tokens.css；`dark:` 命中 4 处全为对象键/注释，
  与脚本口径一致），与脚本结果互证。
- 环境记录：PowerShell 执行策略会拦截 `npm.ps1`，需用 `npm.cmd`；`package.json` 的
  `packageManager` 锁不受影响。
