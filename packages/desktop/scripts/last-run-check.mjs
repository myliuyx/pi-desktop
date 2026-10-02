/**
 * 跨启动目录记忆回归 —— `check:last-run`（task-desktop-stable-port.md F1/F4 补链）。
 *
 * ## 背景：F1/F4 的断链
 *
 * `last-run.json` 是桌面壳**唯一**的跨启动记忆载体（core.json 每次 spawn 前必删，
 * 只服务本次运行）。F4 的落盘链路是 `POST /cwd` 成功 → core 的 `updateCoreJsonCwd`
 * 同步写 `core.json` 的 `cwd` 字段 —— 即 **core.json 的 cwd 始终是实时真值**。
 *
 * 但 `writeLastRun` 的唯一调用点在启动编排的 `.then()` 里（main.ts 启动就绪时一次），
 * 运行期切目录**无人在场回写** ⇒ `last-run.json.cwd` 永远停在「上次启动时的快照」。
 * 后果：A→B→C 用完退出，下次启动回到**上次启动时**的目录而非 C。
 *
 * ## 修复：退出时用 core.json 的实时 cwd 回写记忆
 *
 * `before-quit` 里读一次 `core.json`（其 cwd 由 `writeFileSync` 同步落盘，且在
 * `POST /cwd` 返回 200 **之前**就已写入 ⇒ 退出时读到必然是最后切到的目录，无竞态）。
 *
 * ## 为什么判据落在纯函数上
 *
 * 退出时序本身（Electron `before-quit` + 真实 core 子进程）无法在 CI 里可靠复现，
 * 故与 CR-072 的 `buildBootCoreEnv` 同款做法：把判定从 `main.ts` 抽成纯函数
 * （`src/last-run.ts` 的 `mergeExitLastRun`），本脚本直接断纯函数 —— 全平台、不起进程、
 * 零副作用。接线正确性由 typecheck + 人工冒烟兜底。
 *
 * 隔离纪律：不碰真实 userData、不起任何进程、不写任何文件。
 * 用法：npm run check:last-run；失败非 0 退出。
 */
import { mergeExitLastRun } from "../src/last-run.ts";

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/** 上一轮记忆（形状同 main.ts 的 LastRunState） */
const DIR_A = "/home/u/work/A";
const DIR_B = "/home/u/work/B";
const DIR_C = "/home/u/work/C";

/* ---------------- L1：核心修复 —— 退出时以 core.json 的实时 cwd 为准 ---------------- */
{
  // A→B→C 后退出：记忆起点是「本次启动时的 A」，core.json 实时值是 C ⇒ 必须落 C
  const r = mergeExitLastRun({ port: 5190, cwd: DIR_A }, DIR_C);
  check(
    "L1 退出时以 core.json 的实时 cwd 覆盖启动快照（A→B→C ⇒ 落 C）",
    r.cwd === DIR_C,
    { 期望: DIR_C, 实得: r.cwd },
  );
  check("L1b 端口恒取记忆里的值（core.json 的端口在退出时已死，不可采信）", r.port === 5190, r.port);
}

/* ---------------- L2/L3：core.json 读不到时不得污染记忆 ---------------- */
{
  const r = mergeExitLastRun({ port: 5190, cwd: DIR_B }, null);
  check("L2 core.json 无 cwd 字段 ⇒ 保留原有记忆（不回落成「无记忆」）", r.cwd === DIR_B, r.cwd);

  const r2 = mergeExitLastRun({ port: 5190, cwd: DIR_B }, undefined);
  check("L3 core.json 整个读不到（undefined）⇒ 保留原有记忆", r2.cwd === DIR_B, r2.cwd);
}

/* ---------------- L4：脏值不写进记忆 ---------------- */
{
  // core.json 的 cwd 经 readCoreInfo 判空，但纯函数自身也要收口（防御性冗余，
  // 与 recent-dirs.ts「读取全程兜底」同纪律）
  const r = mergeExitLastRun({ port: 5190, cwd: DIR_B }, "   ");
  check("L4 core.json 的 cwd 是纯空白 ⇒ 视为无值，保留原记忆", r.cwd === DIR_B, r.cwd);
}

/* ---------------- L5：首次切换（记忆里原本没有 cwd）---------------- */
{
  const r = mergeExitLastRun({ port: 5190, cwd: null }, DIR_C);
  check("L5 记忆原本无 cwd + core.json 有 ⇒ 采用 core.json 的值", r.cwd === DIR_C, r.cwd);
}

/* ---------------- L6：幂等（重复退出不累积状态）---------------- */
{
  const once = mergeExitLastRun({ port: 5190, cwd: DIR_A }, DIR_C);
  const twice = mergeExitLastRun(once, DIR_C);
  check("L6 同值重复合并结果不变（幂等）", twice.cwd === DIR_C && twice.port === 5190, twice);
}

/* ---------------- 汇总 ---------------- */
const failed = checks.filter((c) => !c.pass);
if (failed.length > 0) {
  console.error(`\nlast-run 检查失败 ${failed.length} 项：`);
  for (const c of failed) console.error(`  ✗ ${c.name}`);
  process.exit(1);
}
console.log(`last-run 检查全部通过：${checks.length} 项`);
