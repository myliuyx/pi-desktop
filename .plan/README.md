# 文档索引（唯一入口）

> 最后更新：2026-09-23（文档归档整理：M0–M6 全部收官）
> **当前阶段**：M0–M5（纯 UI 原型）与 **M6（Pi 对接）全部完成并通过主控终验**。
> 现在是「本地 core 服务 + 浏览器套壳」的**可用真实链路**（默认 mock，`?live=1` 走真实）。
> **没有进行中的里程碑规格** —— 开新工作前先看「遗留清单」，从里面挑。
> 本文件是文档的唯一入口。**新增文档必须登记到这里，否则视为不存在。**

---

## 一、读法（给未来的我 / AI 会话的硬规则）

1. **项目长期记忆 `.workbuddy/memory/MEMORY.md` 会自动注入**——不要重复读它，更不要读每日日志。
2. **不要通读 `.plan/`**。日常迭代只读 A 层两三份；B 层按需；**C 层（archive）默认不读**
   （只有追溯「当时怎么定的」才看）。
3. 不确定读哪份时，先看本文件的表格。

---

## 二、A 层 · 活跃（日常迭代入口）

| 文档 | 什么时候读 |
|---|---|
| [`pi-integration-points.md`](./pi-integration-points.md) | **任何"接 Pi / 换 mock / 改数据链路"的工作**——逐文件替换点、模型配置对接口径、思考档位、**不动清单** |
| [`engineering-pitfalls.md`](./engineering-pitfalls.md) | **写/改任何脚本或跑验收前**——9 条教训 + 7 条脚本规则（bash shim、`_chk` 前缀、显式 cd、tsc 带 `-p` 等） |

### 遗留清单（当前 backlog，细节见 [`archive/progress-M6.md`](./archive/progress-M6.md) §四）

| # | 事项 | 备注 |
|---|---|---|
| 1 | 分支 / fork 的 UI | 记后期；树结构主干已在 C4 正确处理 |
| 2 | `input` 型授权卡无输入控件 | 授权卡目前只有选项按钮 |
| 3 | MCP 暂缓 | `?mcp=1` 门控保留；恢复只改 `isMcpEnabled()` 返回值 |
| 4 | 06 屏缩略窗不可读 / 主包 520 kB | 既有，不排期；单壳 `#/shells?os=` 替代 / React.lazy |
| 5 | 换 npm 发布包形态后重跑探针 | `S6 §九·5`（core 已用发布包，指依赖锁定形态变化时） |
| 6 | `block.reason` 是否进模型上下文 | 任意 spike 顺手验 |
| 7 | （体验项）信任门 / 授权卡的 UX 打磨 | 已可用，未做视觉细修 |

---

## 三、B 层 · 按需参考（改 UI / 令牌 / 验收时才读）

| 文档 | 什么时候读 |
|---|---|
| [`ui-rulings.md`](./ui-rulings.md) | 改布局或交互前——**防回退台账**（R1–R10 + MCP 门控裁决） |
| [`screens.md`](./screens.md) | 需要 8 屏定义、组件清单、mock 数据结构时 |
| [`design-tokens.md`](./design-tokens.md) | 动颜色/令牌时。颜色唯一来源仍是 `packages/ui/src/styles/tokens.css` |
| [`acceptance-criteria.md`](./acceptance-criteria.md) | 需要验收标准总纲时（实际验收跑 `packages/ui` 的 accept 脚本） |
| [`sync-verification-result.md`](./sync-verification-result.md) | 设计稿 ↔ 代码令牌同步的**单一权威来源** |
| [`docs/pi-agent-core-调研.md`](../docs/pi-agent-core-调研.md) | 需要选型理由、Pi 的风险清单时（历史背景） |

## 四、C 层 · 归档（历史，默认不读；2026-09-23 归档整理）

全部在 [`archive/`](./archive/)。**只有在追溯「某个结论当时怎么定的」时才看。**

| 文件/目录 | 是什么 |
|---|---|
| `task-M1..M5.md` / `progress-M0..M5.md` | 原型期各里程碑规格书与验收记录 |
| `task-M6-C0-C2.md` / `task-M6-C3-C5.md` / `task-M6-C6.md` | **M6 三份规格书**（契约提升 / core 骨架 / 消息流接通；授权+信任门 / 会话 / 04·05 屏；收尾） |
| `progress-M6.md` | **M6 验收记录**（C0–C6 判据与证据索引、主控终验数字、**遗留清单细节**） |
| `survey/`（S0–S6 六份） | **Pi 梳理期产物**——事件映射、授权通道、传输选型、会话、对接设计蓝图（实现依据，维护时按需查） |
| `spike-core-2026-09-23.md` | core 骨架 spike 记录（架构假设销账 + 两条裁决项来源） |
| `decision-rulings-2026-09-23.md` | 两条裁决单（信任门 A3 跟随 Pi；拒绝后重试暂不做） |
| `pi-survey-plan.md` | 梳理期总方案（S0–S6 定义、MCP 暂缓处置执行记录） |
| `poc-pi-2026-09-22.md` | Pi 可行性 POC 记录 |
| `development-plan.md`、`README-prototype-2026-09-21.md`、`sync-check-report.md`、`figma-reverse-sync-status.md`、`m2-notes-B.md`、`diffs/`、`shots/` | 原型期历史（同前） |

---

## 五、当前状态速览

- **里程碑**：M0–M5（纯 UI 原型，2026-09-22）+ **M6（Pi 对接，2026-09-23）全部完成并通过主控终验**
- **形态**：本地 core 服务（`packages/core`，依赖 npm 发布包 `@earendil-works/pi-coding-agent`）
  + 浏览器套壳（`packages/ui` 8 屏六路由）；默认 mock，`?live=1` 走真实链路（**免 token**，core 注入凭证）
- **体验**：`cd packages/core` 起服务（见 MEMORY 命令口径）→ 开 `http://127.0.0.1:5190/?live=1`
- **分支**：`dev-m6`（M6 全部提交在此）；**master 停在梳理期收尾点，合并待指示**
- **验收命令**：ui 侧 `accept:m1~m5` / `check:cn` / `check:adapter` / `live:smoke` / `probe:c4` `probe:c5`；
  core 侧 `check:c3` `check:c4` `check:c5` `check:c6` / `security-check` / `smoke:check`
  （终验数字见 [`archive/progress-M6.md`](./archive/progress-M6.md) §三、§五）
- **遗留**：见上方 A 层清单（7 项，均非阻断）

---

## 六、文档纪律（从踩过的坑里长出来的）

1. **新文档必须登记到本索引**，否则下个会话找不到、也容易重复造。
2. **里程碑结束后**，把该里程碑的规格书与验收记录 `git mv` 入 `archive/`，根目录只留活跃文档
   （2026-09-23 已按此整理 M6 与梳理期全部产物）。
3. **同一结论只放一处。** 需要多处引用时，只放指针，不放副本。
4. **写结论标出处**（`文件:行号`），不凭记忆或上一轮摘要。
5. 归档用 `git mv`（保留历史，随时可回溯），不要直接删内容文档。
6. 移动文档后**必须全仓修正引用路径**（本次用脚本修了 28 处：packages 注释、验收脚本、B 层文档）。
