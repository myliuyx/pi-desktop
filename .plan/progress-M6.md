# M6 · Pi 对接验收记录（progress-M6）

> 日期：2026-09-23　分支：`dev-m6`
> 规格书：`task-M6-C0-C2.md`（第一阶段）→ `task-M6-C3-C5.md`（第二阶段）→ `task-M6-C6.md`（第三阶段）
> 本文是 M6 的验收记录与证据索引（执行方起草，C0–C5 已由主控独立复跑确认；C6 各行**待主控复核**）。

---

## 一、C0–C6 各步判据与证据

| 步 | 内容 | 判据结果 | 证据索引 |
|---|---|---|---|
| C0 | Block 六型提升共享契约 + `AgentEvent` 补 approval/字段修正 + `check:adapter` 扩用例 | ✅ 通过复核 | `task-M6-C0-C2.md` §五；`packages/ui` check:adapter 35 项（fixture 现读） |
| C1 | core 骨架：`server.ts`（HTTP+SSE + 安全三件套 + 静态托管）+ `session.ts` | ✅ 通过复核 | 同上 |
| C2 | 事件适配上收 + SSE 批处理 + 01 屏接真实会话 | ✅ 通过复核（复核修掉 `core-smoke` 的 `agent_end` 红灯 → 改 `agent_settled` + 终态顺序） | 同上；`packages/core/run/reg-smoke.txt`（4/4） |
| C3 | 授权闭环 + 信任门 A3 + 倒计时/失效态 | ✅ 通过复核（36/36；信任门五态；UI 探针 4/4） | `task-M6-C3-C5.md` §五；`run/c3-evidence.json`、`run/reg-c3.txt` |
| C4 | 会话列表/加载/续接 + 独立映射 + Sidebar 接真数据 | ✅ 通过复核（25/25；UI 探针 7/7） | `run/c4-evidence.json`、`run/reg-c4.txt`、`_probe-c4-evidence.json` |
| C5 | 04 屏 resources + 05 屏 models | ✅ 通过复核（26/26；UI 探针 8/8） | `run/c5-evidence.json`、`run/reg-c5.txt`、`_probe-c5-evidence.json` |
| C6 · §1.1 | 04 屏工具开关接 Pi | **待主控复核**（check:c6 ⑥ 组 7/7；UI live 开关读写接通，mock 形态与 testid 零改动） | `run/c6-evidence.json`；提交 5419891 |
| C6 · §1.2 | `continue-recent` 重建活动会话 | **待主控复核**（限时评估结论 = 有公开低险路径，已实现；check:c6 ⑤ 组 5/5：合成会话逼出真实切换，续写落同一 session 文件） | `run/c6-evidence.json`；`session.ts` `rebuildSession` 注释（API 出处） |
| C6 · §1.3 | 分支/fork UI | **待主控复核**（确认**记后期**：原型无分支交互，树结构主干已在 C4 由 `getBranch()` 正确处理，见 `S6 §四·4`） | 本表 |
| C6 · §二 | `check:c6` 全链路端到端终验 + 全家桶 | **待主控复核**（33/33 全绿；全家桶各项见下表） | `packages/core/scripts/c6-e2e-check.mjs`、`run/c6-evidence.json` |
| C6 · §三 | 文档收口 | **待主控复核** | 本文、`.plan/README.md`、`survey/S6-integration-design.md` §八、`.workbuddy/memory/MEMORY.md` |

## 二、两条裁决的落实情况

- **A3 信任门（跟随 Pi）**：C3 已实现（自建 `DefaultResourceLoader` + 显式 `reload({resolveProjectTrust})` 两段式；`ask` 经 uiContext 提问、never/always 直接定论）；C5 的 04 屏数据源按信任结论联动（`projectTrustBlocked` 口径）。
- **B 拒绝后重试（暂不做）**：未实现，与裁决一致；Pi 公开 `abort()` 已在 core `POST /abort` 暴露，后期扩展零障碍。

## 三、C6 全家桶终验数字（2026-09-23 实测）

| 项 | 结果 |
|---|---|
| `accept:m1` / m2 / m3 / m4 / m5 | 全通过 / 32/32 / 15/15 / 16/16 / 21/21（单 dev server 5180，`M*_ORIGIN` 显式注入） |
| `check:cn` / `check:adapter` | 20/20 / 35 项 |
| `live:smoke` | EXIT=0（c6 内另跑两遍亦全绿） |
| `check:c3` / c4 / c5 / **c6** | 36/36 / 25/25 / 26/26 / **33/33** |
| `security-check` / `smoke:check` | 全部通过 / 4/4 |
| core / ui `tsc --noEmit -p` | EXIT=0 / EXIT=0 |
| `vite build` | 10.46s；dist 隔离扫描 126 文件、严格命中 **0**（`run/build-isolation.txt`） |

## 四、遗留清单（如实，均非阻断）

1. **分支/fork 的 UI**（C6 §1.3 确认记后期）——原型无分支交互，树结构主干已在 C4 正确处理（`S6 §四·4`）。
2. **`input` 型授权卡无输入控件**（C3 遗留）——卡片只有选项按钮。
3. **MCP 暂缓**——`?mcp=1` 门控保留，恢复只改 `isMcpEnabled()` 返回值。
4. **DEV 下 `window.__chatStore` 桩**——live 模式挂真实 store 是既有口径（供脚本驱动），非缺陷。
5. 06 屏缩略窗文字不可读、主包 520 kB（既有，不排期）。
6. 换 npm 发布包（非本地依赖锁定形态变化）后重跑探针（`S6 §九·5`）。
7. `block.reason` 是否进模型上下文（`S6 §九·3`，任意 spike 顺手验）。

> 已销账（不再遗留）：`continue-recent` 只读（C6 §1.2 已实现重建）；04 屏工具开关本地持久化
> 与真实会话无关（C6 §1.1 已接 Pi）；`core-smoke` 断言 `agent_end` 红灯（主控已修）。

## 五、试用口径（C6 后最终形态）

`cd packages/core` → 起 core（`npm run smoke`，或按 `.workbuddy/memory/MEMORY.md` 的一页式命令带夹具）
→ 浏览器开 `http://127.0.0.1:<core端口>/?live=1`（core 同源托管 ui/dist，**免 token**）。
自检口径：侧边栏「历史会话」live 显示真实 `sessions` 记录、mock 形态是 8 条演示会话。
