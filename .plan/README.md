# 文档索引（唯一入口）

> 最后更新：2026-09-22
> **当前阶段**：纯 UI 原型 M0–M5 已全部完成并通过验收（8 屏六路由可演示），进入 **Pi 对接阶段**。
> 本文件是文档的唯一入口。**新增文档必须登记到这里，否则视为不存在。**

---

## 一、读法（给未来的我 / AI 会话的硬规则）

1. **项目长期记忆 `.workbuddy/memory/MEMORY.md` 会自动注入**——不要重复读它，更不要读每日日志
   （`.workbuddy/memory/YYYY-MM-DD.md`）除非要追溯某次具体改动。
2. **不要通读 `.plan/`**。按任务类型只读 A 层对应的一两份；B 层按需；**C 层（archive）默认不读**。
3. 不确定读哪份时，先读本文件的表格，不要逐个打开文件"看看"。

---

## 二、A 层 · 活跃（当前阶段直接指导工作）

| 文档 | 什么时候读 |
|---|---|
| [`survey/S4-transport-decision.md`](./survey/S4-transport-decision.md) | **动 core 包前必读**——传输层选型结论（独立 core 进程 + HTTP/SSE）、`AgentTransport` 接口草案、四个必做设计点 |
| [`survey/S1-event-mapping.md`](./survey/S1-event-mapping.md) | **写适配层前必读**——Pi 事件→Block 映射表、实测与文档的三处不一致、对 chat-store 的冲击 |
| [`survey/S0-our-contract.md`](./survey/S0-our-contract.md) | 梳理 Pi 的靶子——我们这侧冻结的契约：Block 六型字段、chat-store 五方法语义、92 个 testid 清单 |
| [`pi-integration-points.md`](./pi-integration-points.md) | **任何"接 Pi / 换 mock / 改数据链路"的工作**。含逐文件替换点、模型配置对接口径、思考档位、不动清单 |
| [`pi-survey-plan.md`](./pi-survey-plan.md) | 梳理 Pi、决定对接顺序时。六阶段，每阶段绑定"动我们哪些文件 + 影响哪些验收" |
| [`poc-pi-2026-09-22.md`](./poc-pi-2026-09-22.md) | 需要 Pi 可行性证据、环境坑、复现方式时。结论：Electron 内真实会话已跑通 |

## 三、B 层 · 按需参考（改 UI / 令牌 / 验收时才读）

| 文档 | 什么时候读 |
|---|---|
| [`ui-rulings.md`](./ui-rulings.md) | 改布局或交互前——**防回退台账**，记录 R1–R10 逐条裁决 |
| [`screens.md`](./screens.md) | 需要 8 屏定义、组件清单、mock 数据结构时 |
| [`design-tokens.md`](./design-tokens.md) | 动颜色/令牌时。颜色唯一来源仍是 `packages/ui/src/styles/tokens.css` |
| [`acceptance-criteria.md`](./acceptance-criteria.md) | 需要验收标准总纲时。实际验收跑 `packages/ui` 的 accept 脚本 |
| [`sync-verification-result.md`](./sync-verification-result.md) | 设计稿 ↔ 代码令牌同步的**单一权威来源** |
| [`docs/pi-agent-core-调研.md`](../docs/pi-agent-core-调研.md) | 需要选型理由、Pi 的风险清单、落地步骤原议 |

## 四、C 层 · 归档（历史，默认不读）

放在 [`archive/`](./archive/)。**只有在追溯"某个里程碑当时怎么定的"时才看**，日常不用打开。

| 文件 | 是什么 |
|---|---|
| `task-M1..M5.md` | 各里程碑的执行规格书（已完成） |
| `progress-M0..M5.md` | 各里程碑的验收记录与实测证据（已完成） |
| `development-plan.md` | M0–M5 总排期（净工时 69.5h 已用尽，缓冲 14h 未动用） |
| `README-prototype-2026-09-21.md` | 旧版 README（原型方案总览），**M3–M5 状态已过时**，仅作历史 |
| `sync-check-report.md` | 历史问题核查报告，问题已关闭，转为方法论留档 |
| `figma-reverse-sync-status.md` | 设计稿反向同步状态（已完成） |
| `m2-notes-B.md` | M2 执行方交接笔记（含一条被主控推翻的根因判断，有教训价值） |
| `diffs/` | M5 全屏走查差异清单、R7–R9 设计稿回写执行单 |
| `shots/` | M1 阶段截图证据（6 张） |

## 五、当前状态速览

- **原型**：M0–M5 全部完成并通过验收；8 屏六路由（00 令牌 / 01 工作台含源码态 / 03 运行详情 /
  04 技能与工具 / 05 设置 / 06 窗口壳）全部可演示
- **工时**：净工时 69.5h 用尽，**14h 缓冲未动用**
- **Pi 侧**：依赖已装、构建已通、POC 四步全过（Electron 44.4.3 内真实会话跑通）
- **适配层已落地**：`packages/ui/src/adapter/`（`pi-events` / `from-pi` / `reduce`），
  带状态纯 reducer；`npm run check:adapter` = 24 项断言（真实会话 dump 回放）
- **已完成的梳理**：S0 我方契约 / S1 事件映射 / S4 传输层选型（均见 `survey/`）；
  剩 S2 会话持久化、S3 授权闭环、S5 自建能力、S6 汇总
- **下一个建议做 S3**：授权应答是唯一需要在 transport 上开**反向通道**的能力，
  而 S4 的接口草案尚未包含它，早做可避免 core 接口返工
- **下一步（大方向）**：按 `pi-integration-points.md` 把 mock 换成真实数据链路；
  `chat-store` 五方法签名冻结，只换内部实现
- **开工前必读**：`survey/S0-our-contract.md` → `survey/S1-event-mapping.md` → `survey/S4-transport-decision.md`
  （三份加起来就能动手，不必通读 `.plan/`）
- **遗留（非阻断）**：06 屏缩略窗口文字不可读（有单壳全尺寸替代）、主包 520 kB、
  DEV 下 `window.__chatStore` 桩（接 Pi 时改回真实 UI 驱动）

---

## 六、文档纪律（从踩过的坑里长出来的）

1. **新文档必须登记到本索引**，否则下个会话找不到、也容易重复造。
2. **里程碑结束后**，把该里程碑的规格书与验收记录移入 `archive/`，根目录只留活跃文档。
3. **同一结论只放一处。** 状态类信息散落在 N 个文件里，必然"改了一部分、漏了一部分"
   （`sync-check-report.md` 就是这么来的）——需要多处引用时，只放指针，不放副本。
4. **写结论标出处**（`文件:行号`），不凭记忆或上一轮摘要。
5. 归档用 `git mv`（保留历史，随时可回溯），不要直接删内容文档。
