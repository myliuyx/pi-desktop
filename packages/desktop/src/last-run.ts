/**
 * 跨启动记忆（last-run.json）的合并判定 —— 从 `main.ts` 抽出的**可测纯函数**。
 *
 * ## 背景：F1/F4 记忆链路的断点（本次修复的根因）
 *
 * `last-run.json` 是桌面壳**唯一**的跨启动记忆载体（`core.json` 每次 spawn 前必删，
 * 只服务本次运行）。落盘链路分两段：
 *
 * 1. **core.json 的 cwd 始终是实时真值** —— `POST /cwd` 成功即触发 core 的
 *    `updateCoreJsonCwd`，`writeFileSync` 同步写盘，且发生在端点返回 200 **之前**
 *    ⇒ 任何时刻读到的都是最后切到的那个目录，无竞态。
 * 2. **`last-run.json` 却只在启动时写一次** —— `writeLastRun` 的唯一调用点是启动
 *    编排的 `.then()`（core 就绪那一刻）。运行期切目录**无人在场回写**。
 *
 * ⇒ `last-run.json.cwd` 永远停在「上次启动时的快照」：A→B→C 用完退出，下次启动回到
 * 上次启动时的目录，不是 C。
 *
 * ## 修复：退出时用 core.json 的实时 cwd 回写记忆
 *
 * 在 `before-quit` 里读一次 core.json 并合并进记忆。选此时机的理由就是上面第 1 条的
 * 同步落盘性质 —— 不需要新增任何通知通道（那是方案 B/IPC），也不用轮询。
 *
 * ## 已知取舍（诚实声明）
 *
 * 崩溃 / 任务管理器强杀 / 断电时这一跳更新会丢，退化回「上次启动时的目录」——
 * 与修复前持平，不算变差。做到崩溃也不丢需要 core 经 IPC 实时上报（方案 B）。
 *
 * 端口**不取** core.json 的值：退出那一刻它指向的 core 进程正在被杀，是死端口；
 * 记忆里的端口仍是「下次该尝试复用的那个」，必须原样保住（`readLastRun` 原口径）。
 */

/** 记忆文件形状（与 `main.ts` 的 LastRunState 同构，刻意独立以免纯函数反向依赖 Electron 侧） */
export interface LastRunState {
  port: number;
  cwd: string | null;
}

/**
 * 退出时合并「记忆」与「core.json 的实时 cwd」，产出待落盘的最终记忆。
 *
 * - `liveCwd` = 本次运行中 core.json 记录的真实 cwd；`null` / `undefined` = core.json
 *   读不到或无该字段（core 尚未就绪就被杀、或旧版 core.json 无 cwd 字段）。
 * - **读不到时保留原记忆**（不回落成 `null`）：记忆是「最后已知的好值」，
 *   用空值覆盖等于凭空抹掉一次跨启动记忆 —— 与 `recent-dirs.ts`「读失败保留原值」
 *   同纪律。
 * - 纯空白视为无值（`readCoreInfo` 已判空，这里是防御性冗余）。
 * - 端口恒取 `last.port`，理由见上方注释。
 */
export function mergeExitLastRun(last: LastRunState, liveCwd: string | null | undefined): LastRunState {
  const cwd = typeof liveCwd === "string" && liveCwd.trim().length > 0 ? liveCwd : null;
  return { port: last.port, cwd: cwd ?? last.cwd };
}
