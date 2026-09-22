# 纯 UI 原型 · 实现方案总览

> 制定日期：2026-09-21
> 阶段目标：**只用 mock 数据把 8 屏界面做出来**，不接 Pi、不接 LLM、不接后端。

---

## 一、目标与范围

### 做什么

把 Ardot 上的「桌面 Agent · 跨平台设计系统」（8 屏）在浏览器里实现为可交互的 React 原型，能：

- 切换深浅模式
- 折叠 / 展开左右栏
- 浏览消息流（文本流式、执行计划、终端步骤、授权卡片）
- 在预览区切换「预览效果 / 预览源码」
- 在各屏之间跳转，用于设计走查

### 不做什么

- 不接 Pi / 不调用任何 LLM（Agent Core 接入是下一阶段）
- 不做 Electron 壳（壳层后置，前端代码可 90% 复用）
- 不做真实文件系统与终端（全部 mock）
- 不做持久化（刷新即重置，除主题与折叠偏好）

### 为什么先做这一步

设计稿已迭代 12 轮，说明还会继续改。浏览器 HMR 是秒级反馈，套进桌面壳后每次看效果都要重载，迭代成本差一个量级。定稿后再套壳，前端代码几乎不用动。

---

## 二、关键决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | **单包起步**：只建 `packages/ui`，暂不搭 monorepo | 本阶段只有一个前端包，workspace 配置是纯开销。接入 Pi 时再拆 `core` / `desktop` / `web` |
| 2 | **令牌用 CSS 变量，不用 Tailwind 内置调色板** | 设计稿的 `Theme` 变量集是语义化的（`bg_app` / `bg_subtle` / `border_subtle`），语义令牌才能一键换肤，且与 Figma `variableModes` 心智一致 |
| 3 | **组件用 headless（Radix），不用 AntD / MUI** | 现成组件库自带设计语言，与稿子打架，改起来比手写更累 |
| 4 | **先做浅色，深色靠令牌自动派生** | 对应设计稿第 11 轮的做法：深色是浅色副本施加 `variableModes` 的结果，不是独立维护的第二套样式 |
| 5 | **8 屏用路由切换，都挂在同一套布局上** | 便于设计走查时快速对比，也提前暴露布局不一致 |

---

## 三、工程结构

```
packages/ui/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx                      # 路由 + 屏幕切换
    ├── styles/
    │   ├── tokens.css               # 语义令牌（浅色 / 深色），唯一颜色来源
    │   └── globals.css              # reset + 基础排版
    ├── lib/
    │   └── cn.ts                    # className 合并
    ├── components/
    │   ├── primitives/              # 无业务的基础件
    │   │   ├── Button.tsx
    │   │   ├── IconButton.tsx
    │   │   ├── Chip.tsx
    │   │   ├── Segmented.tsx
    │   │   ├── Tabs.tsx
    │   │   ├── ScrollArea.tsx
    │   │   └── Tooltip.tsx
    │   ├── shell/                   # 窗口与布局
    │   │   ├── WindowShell.tsx      # 接受 os="mac" | "win" | "linux"
    │   │   ├── TitleBar.tsx         # 含收起左/右、主题切换、设置
    │   │   ├── Sidebar.tsx
    │   │   ├── SidebarFooter.tsx    # 模型/设置 分段控件
    │   │   └── PreviewPane.tsx      # 预览效果 / 预览源码 双 Tab
    │   ├── chat/
    │   │   ├── MessageList.tsx
    │   │   ├── MessageBubble.tsx
    │   │   ├── PlanCard.tsx         # 执行计划
    │   │   ├── TerminalCard.tsx     # 终端步骤
    │   │   ├── ApprovalCard.tsx     # 授权卡片
    │   │   └── Composer.tsx         # 输入区 + 工具条
    │   └── common/
    │       ├── TokenStats.tsx       # 输入/输出/消耗/上下文
    │       └── icons.tsx            # 统一图标出口
    ├── screens/
    │   ├── WorkbenchScreen.tsx      # 01 浅色 / 02 深色
    │   ├── WorkbenchSourceScreen.tsx# 01b 源码态
    │   ├── RunDetailScreen.tsx      # 03
    │   ├── SkillsScreen.tsx         # 04
    │   ├── SettingsScreen.tsx       # 05
    │   └── ShellsScreen.tsx         # 06
    ├── mock/
    │   ├── types.ts
    │   └── sessions.ts
    └── store/
        └── ui-store.ts              # 主题、折叠、当前屏
```

---

## 四、里程碑

| 里程碑 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **M0** | 工程搭建 + 令牌体系 | Vite 跑起来，深浅切换可用，色板页可查 | ✅ 已完成（[progress-M0.md](./progress-M0.md)） |
| **M1** | 布局骨架 | `WindowShell` + 三栏 + 折叠 + 侧边栏（含通底条带） | ✅ 已完成（[progress-M1.md](./progress-M1.md)） |
| **M2** | **会话工作台 01**（最重） | 消息流、执行计划、终端步骤、授权卡片、输入区 | ✅ 已完成（[progress-M2.md](./progress-M2.md)） |
| **M3** | 预览区 + 深色版 | 01b 源码态、02 深色版由令牌自动派生 | ⏳ 未开工 |
| **M4** | 其余三屏 | 03 运行详情 / 04 技能与工具 / 05 设置 | ⏳ 未开工 |
| **M5** | 窗口壳 + 走查 | 06 三端壳、整体对齐设计稿、交互细节打磨 | ⏳ 未开工 |

**M2 是重点**，其余屏可快速带过。

> 进度口径：M0 8.5h + M1 12h + M2 20h = **40.5h / 83.5h ≈ 48.5%**（按含 20% 缓冲的总口径）。
> 每个里程碑结束都产出 `progress-M{里程碑}.md`，作为该里程碑「做到哪」的**单一权威记录**。

---

## 五、文件导航

| 文件 | 内容 |
|---|---|
| [design-tokens.md](./design-tokens.md) | 令牌体系：命名规则、CSS 变量定义、Tailwind 映射、深浅切换 |
| [screens.md](./screens.md) | 8 屏逐个拆解、组件清单、mock 数据结构、验收标准 |

---

## 六、开工前需确认的两件事

1. **令牌的具体色值**需要从设计稿核对。本方案给出的是建议初值，命名体系与结构是正确的，数值需对照 Figma `Theme` 变量集校正。
2. **窗口尺寸**：设计稿画布每屏间距 1540，估计 frame 宽约 1440。需确认实际设计宽度（1440 还是 1280），这决定三栏的断点与间距。
