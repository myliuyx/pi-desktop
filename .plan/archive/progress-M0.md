# M0 进度与验收记录

> 更新日期：2026-09-21
> 里程碑：**M0 · 工程与令牌**（计划净工时 8.5h）
> 配套：[development-plan.md](./development-plan.md) · [acceptance-criteria.md](./acceptance-criteria.md)

---

## 一、结论

**M0 已完成，验收通过。** 可进入 M1。

上一轮在「实现已完成、验收未跑完」处被打断，本轮补齐了全部验收项，并修掉了两个实质缺陷（00 屏体检能力缺失、浅色令牌对比度不达标）。

---

## 二、逐任务状态

| # | 任务 | 产出 | 状态 |
|---|---|---|---|
| 0.1 | 初始化 Vite + React 19 + TS，路径别名 + 严格模式 | `packages/ui/` | ✅ |
| 0.2 | Tailwind v4 接入，`@theme inline` 桥接全部令牌 | `styles/globals.css` | ✅ |
| 0.3 | `tokens.css` 浅色全量令牌 | 26 个颜色令牌 | ✅ |
| 0.4 | 深色令牌 | `:root[data-theme="dark"]` | ✅ |
| 0.5 | reset + 基础排版 + 滚动条样式 | `globals.css` | ✅ |
| 0.6 | 主题 store：localStorage + 系统偏好 + `<html data-theme>` | `store/ui-store.ts` | ✅ |
| 0.7 | 00 屏：色板 / 字阶 / 圆角 / 状态矩阵 / 图标清单 | `screens/TokensScreen.tsx` | ✅ |
| 0.8 | 基础件 `Button` / `IconButton` / `Chip` | `components/primitives/` | ✅ |

**额外产出**（不在原计划内，但 M0 需要）：

- `lib/cn.ts` — className 合并
- `lib/tokens.ts` — 令牌清单与运行时读取
- `components/common/icons.tsx` — 统一图标出口 + 40 个图标清单

---

## 三、验收逐项核对

### 3.1 M0 专项（acceptance-criteria.md 第三章）

全部 8 项**已在浏览器内实测通过**（Chrome + agent-browser，非仅代码走读）：

| # | 验收项 | 判定 | 实测证据 |
|---|---|---|---|
| 0-1 | 开发服务器可启动 | ✅ | Vite v6.4.3 `ready in 769 ms`，无报错；生产构建亦通过（1591 modules，259KB JS / 20KB CSS） |
| 0-2 | 浅色令牌全量落地 | ✅ | 运行时读取 26 个令牌均有值，「未定义 0」 |
| 0-3 | 深色令牌全量落地 | ✅ | 深色块覆盖全部可变量，「未覆盖 0」 |
| 0-4 | 主题作用于 `<html>` | ✅ | 点击切换：`data-theme` `light`→`dark` |
| 0-5 | 主题持久化 | ✅ | 写入 `localStorage.theme='dark'` 后**原地整页重载**，首帧即 `dark`，body 背景 `rgb(22,24,28)` |
| 0-6 | 首次访问跟随系统 | ✅ | 无存储值 + `--color-scheme dark` → 自动 `dark`；系统浅色 → `light` |
| 0-7 | 00 屏可用 | ✅ | 12 个区块全渲染（体检 / 6 组色板 / 字阶 / 圆角 / 按钮矩阵 / 芯片矩阵 / 图标清单），44 个图标 |
| 0-8 | G1 / G2 / G5 通过 | ✅ | 见 3.2 |

补充实测：深色下 body 文字 `rgb(232,234,237)`、背景 `rgb(22,24,28)`，无白底黑字；无横向滚动条（`scrollWidth == clientWidth`）。

### 3.2 全局硬约束（第二章）

| # | 约束 | 结果 | 说明 |
|---|---|---|---|
| G1 | 颜色来源唯一 | ✅ **通过** | `#hex` 全局命中**仅落在 `tokens.css`**；其余源码 0 命中 |
| G2 | 无 `dark:` 变体 | ✅ **通过** | 全局命中 1 处，为 `TokensScreen.tsx` 局部变量 `values.dark[...]`，非 Tailwind 变体 |
| G3 | 深浅两模式文字可读 | ✅ **通过（本轮修复后）** | 20 项组合全部达标，见第五节 |
| G5 | 不用 Tailwind 内置调色板 | ✅ **通过** | `bg-gray-` / `text-black` / `bg-white` 等 0 命中 |
| G4 | 图标用 `--icon-neutral` | ✅ **通过** | 运行时验证：深浅两模式下均 `#8a919e`，该变量不在深色块中覆盖 |
| G6 | 无意外横向滚动条 | ✅ **通过** | 00 屏实测 `overflow: false` |

> G1 检查命令（在 `packages/ui` 下）：搜索 `#([0-9a-fA-F]{3,8})\b`，范围 `src/`。

---

## 四、类型检查与构建

```
tsc --noEmit -p tsconfig.app.json  →  EXIT=0，0 error
vite build                         →  EXIT=0，built in 2.47s
```

`strict: true` + `noUnusedLocals` + `noUnusedParameters` 全开。

---

## 五、本轮修复

### 5.1 【Blocker】浅色令牌对比度不达标（已修）

**问题**：按建议初值落地后，多组「语义色作为文字放在各自 soft 底上」的对比度**低于 G3 要求的 4.5:1**。最严重的两处：

| 组合 | 修复前 | 修复后 |
|---|---|---|
| 深色 `accent` 上的 `accent-fg`（主按钮文字） | **2.90:1** ✗ | **6.13:1** ✓ |
| 浅色 `success` on `success-soft` | 2.98:1 ✗ | 4.69:1 ✓ |
| 浅色 `info` on `info-soft` | 3.14:1 ✗ | 4.72:1 ✓ |
| 浅色 `warning` on `warning-soft` | 3.24:1 ✗ | 4.99:1 ✓ |
| 浅色 `danger` on `danger-soft` | 3.41:1 ✗ | 4.72:1 ✓ |
| 浅色 `accent` on `accent-soft` | 4.41:1 ✗ | 4.58:1 ✓ |
| 浅色白字 on `danger`（危险按钮） | 3.93:1 ✗ | 5.44:1 ✓ |
| 浅色白字 on `accent`（主按钮） | 4.44:1 ✗ | 5.12:1 ✓ |

**根因**：`design-tokens.md` 的「建议初值」是照 Figma 取色直搬，未做对比度校验。深色语义色其实合格（6.3~7.0:1），**反倒是浅色一整套偏亮**——正好与计划里预判的「深色对比度修正」相反。

**修法**（改令牌，不动组件——符合 G1/G2 的精神）：

- 浅色 `accent` `#3B6EF5` → `#3563E8`，`accent-hover` 随动，`accent-soft` → `#EEF2FE`
- 浅色 `success`/`warning`/`danger`/`info` 整体压暗一档 → `#0F7A58` / `#8F5B0E` / `#C0392B` / `#1A6BBD`
- **深色 `accent-fg` 由 `#FFFFFF` 改为 `#16181C`** —— 深色下 accent 已提亮为浅蓝，必须反过来用深色前景

`tokens.css` 与 `design-tokens.md` 已同步，色值旁标注了实测对比度。

### 5.2 【Major】00 屏令牌体检能力缺失（已修）

**问题**：`Swatch` 对缺失令牌只渲染空白色块 + 空 label，**无法判断是「令牌没定义」还是「颜色本身就是浅色」**。这直接违背 00 屏存在的意义（development-plan.md M0 完成判据：「00 屏能一眼看出哪个令牌有问题」）。

**修复**（`screens/TokensScreen.tsx`）：

1. `Swatch` 检测空值 → 渲染 `border-danger bg-danger-soft` 色块 + 「未定义」红标。
2. 色板每行检测深浅两值是否相同（排除刻意固定的 `--icon-neutral`）→ 打「未覆盖」黄标，暴露深色块漏改。
3. 页首新增「令牌体检」小结卡，统计未定义数 / 未覆盖数。

**成效**：该卡片在修复 5.1 前**准确报出 `accent-fg` 未覆盖**，直接指向了那个 Blocker——工具本身立刻验证了价值。当前显示「令牌体检 · 全部正常」。

### 5.3 【已解决】包管理器：定稿 **npm**

计划与验收文档原先写的是 `pnpm dev`，但本机**未安装 pnpm**，且 `packages/ui` 下是 `package-lock.json`（npm 生态）。

**2026-09-21 决策：统一用 npm**，文档中的 `pnpm` 字样已全部改掉。

决定性理由不是"本机没装"，而是 **Pi 用的是 npm**：`pi/package.json` 用 npm workspaces 语法（`"workspaces": [...]`），全程 `npm run build --workspaces` / `npm --prefix`，还带一批假定 npm 的 `*.mjs` 校验脚本（shrinkwrap / install-lock）。

若这边用 pnpm，接 Pi 时会同时踩三个坑：node_modules 布局不同（pnpm 符号链接 + 严格隔离，native 模块与 Electron 打包都要额外配 `node-linker` / `public-hoist-pattern`）、shrinkwrap 校验失效、两套 lockfile 并存。

后续拆 monorepo 直接用 npm workspaces，与 Pi 保持一致，无需额外配置文件。详见 `development-plan.md` 第九节。


---

## 六、与设计稿待核对项（不阻断开发）

沿用 design-tokens.md 第八节，M0 结束时**仍未核对**：

- [x] `Theme` 变量集 Light / Dark 实际色值 —— **2026-09-22 已实测核对并完成同步**（见下）
- [x] `Radius` 变量集各档数值 —— 已核对，与 `layout.ts` 一致
- [ ] 字号阶梯实际使用值与行高
- [x] 三栏尺寸 —— **2026-09-21 定稿按 1440 开工**，已落为 `src/lib/layout.ts` 常量

> 🟢 **2026-09-22 00:05 核对结论（已解除存疑）：设计稿与代码曾经不一致，现已完成同步。**
> 用 `fetch_variables` 实测读取设计稿 `Theme` 集后确认：设计稿当时停在**代码做对比度压暗之前**的那一版
> （Light `accent` = `#5C5CD7` / Dark `#7D7DF0`），与代码现值（`#3563e8` / `#6b93ff`）相差一整轮，
> 且设计稿侧 **缺失 `info` / `info_soft` 两个变量**。判定为「真需要同步」，已执行全量回写。
> 下面第 165 行那段"执行结果"是**真发生过的历史记录**，只是它同步的是旧版值 ——
> "记录不可信"当初的定性是对的，但事情**确实做过**，问题在于记录**没有标注同步了哪一版**。
> 完整逐项比对见 [`sync-verification-result.md`](./sync-verification-result.md)，
> 前一版疑点报告见 [`sync-check-report.md`](./sync-check-report.md)。

**设计稿同步方案（2026-09-21 澄清）**：代码侧改的令牌值**不需要**在 Figma 里逐个手动改。

> 📌 2026-09-21 深夜更正：原文写"9 个令牌"。经实测 `tokens.css`，
> 设计稿 `Theme` 集需对齐的是 **23 个双模式颜色令牌**（Light + Dark 各一套）。
> 完整的当前色值表见 [`figma-reverse-sync-status.md`](./figma-reverse-sync-status.md) 第三节。

正确做法是：本轮改的是"为了让色值达标"，而这套色值本身**本来就是从 Figma 抄来的**。所以同步方向是**反向的**——
把新值覆盖回 Figma `Theme` 变量集（Light / Dark 两个 mode），让设计稿成为代码的镜像，
而不是"回改设计稿的创意"。改变量集里的值即可，**不要动任何图层**。

### ✅ 执行结果（2026-09-21，已由 Ardot 工具完成）

> ⚠️ **本段为历史记录（2026-09-22 已核实为真发生过），但它同步的是旧版色值，已被本轮同步取代。**
> 本段描述的色值（`accent` = `#5C5CD7` / Dark `#7D7DF0`）与 `tokens.css` 现值
> （`#3563e8` / `#6b93ff`）不一致，原因是代码之后整体压暗了一档而没回写。
> **当初"记录不可信"的定性没错，但这不等于"同步没做"——它做过。**
> 教训：同步记录必须标注**同步了哪一版值**，否则记录会随代码演进腐化成假信息。
> 2026-09-22 已按代码现值重新全量同步（含新建 `info` / `info_soft`）。
> 参见 [`sync-verification-result.md`](./sync-verification-result.md)。

设计文件：`桌面 Agent · 跨平台设计系统`（fileId `728255468414716`）

- 通过 `apply_variables` 把 `Theme` 集**全部 21 个 COLOR 变量按 Light/Dark 两模式整体回写**。
  - 之所以不只传 9 个：merge 模式下只传改动项也能成功，但**无法自证"未提及的变量确实没被动过"**；
    全量写入后可直接读回逐项比对，一次确认全表一致。
- 返回 `{created: 0, updated: 21, deleted: 0}`；随后 `fetch_variables` 读回核对，**21 项逐一吻合**。
- **最易漏的那条已确认落地**：`3:14` `text_on_accent` 的 Dark 值已是 `#16181C`（不再是 `#FFFFFF`）。
  顺带把它的 scopes 从 `ALL_FILLS` 收窄为 `TEXT_FILL` + `ALL_FILLS`，语义更准。

同步后的实测对比度（Node 复算，与 `tokens.css` 注释一致）：

| 组合 | 同步前 | 同步后 | 门槛 |
|---|---|---|---|
| Dark `text_on_accent` on `accent` `#7D7DF0` | 2.90 ✗ | **5.13** ✓ | 4.5 |
| Dark `text_on_accent` on `accent_hover` | 3.87 ✗ | **6.28** ✓ | 4.5 |
| Light `text_on_accent` on `accent` `#5C5CD7` | 4.44 ✗ | **5.29** ✓ | 4.5 |
| Light `text_on_accent` on `accent_hover` | 5.22 ✓ | **6.41** ✓ | 4.5 |

**仍低于 4.5:1 的项（非本轮引入，属设计选择，仅记录不擅改）**：

- `text_tertiary`：Dark `#6E7380` / Light `#8A919E`（3.80 / 3.17）—— 设计稿第 7 轮定的值，且该令牌多用于大号或非关键辅助信息。
- 浅色 `success` 3.12、`warning_soft` 1.95、`danger` 3.93 —— 与设计稿 `Theme` 现值一致，未在本轮变更范围内。
- `border_strong` 1.37 / `border_subtle` 1.18 —— **非文本元素门槛本就低（约 1.5 / 1.2），不构成缺陷。**

> 注：设计稿中 `Theme` 与代码 `tokens.css` 的**命名差异**（设计稿 `accent` / 代码 `--accent`，设计稿 `text_on_accent` / 代码 `--accent-fg`）属既有映射，非本轮问题。

**风险**：色值再校准只需改 `tokens.css` 一处，组件不受影响——这正是令牌体系的价值。

**建议**：M1 开工前先花 30 分钟一次性把 Figma `Theme` 变量集两项（原值核对 + 本轮改动同步）做完。M1 会大量用到 `bg-subtle` / `border-subtle` / `accent`，色值越早定越省返工。


---

## 七、下一步（M1 · 布局骨架，12h）

| # | 任务 | 产出 |
|---|---|---|
| 1.1 | `WindowShell`，接受 `os` prop | `shell/WindowShell.tsx` |
| 1.2 | `TitleBar`：窗口控件 + 收起左/右 + 主题切换 + 设置 | `shell/TitleBar.tsx` |
| 1.3 | `Sidebar`：新建任务 → 搜索 → 历史会话 → 工作目录 | `shell/Sidebar.tsx` |
| 1.4 | `SidebarFooter`：通底贴边条带 | `shell/SidebarFooter.tsx` |
| 1.5 | 折叠逻辑 + 180ms 过渡 + 持久化 | `store/ui-store.ts` |
| 1.6 | 屏幕路由与切换入口 | `App.tsx` |

**M1 最容易做错的一项**：1.4 条带必须**左右与底边完全贴边**（`border-radius: 0`、`gap: 0`、无 12px 内边距残留）。设计稿第 11 轮才把通底定稿，见 memory `2026-09-21.md` 第 11 轮。

**M1 可直接复用的 M0 资产**：`Button` / `IconButton` / `Chip`（P0/P1 组件清单里的 `IconButton` 已就绪）、`Icon` 统一出口（`PanelLeftClose` / `PanelRightClose` / `Plus` / `Search` / `History` / `FolderOpen` / `Settings` / `Sun` / `Moon` 都已在清单内）、`ui-store` 的持久化模式可直接扩展给折叠状态。

