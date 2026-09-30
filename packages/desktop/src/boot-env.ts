/**
 * bootCore env 信封构造（CR-072）—— 从 `main.ts` 的 `bootCore` 抽出的**可测纯函数**。
 *
 * 背景（CR-072）：桌面壳 `bootCore` 以 `{ ...process.env, ...5 项覆写 }` 起 core 子进程，
 * **完全透传宿主的 `CORE_*`**。宿主若因自托管文档（README 教 `CORE_HOST=0.0.0.0`）设了
 * `CORE_HOST=0.0.0.0`，内嵌 core 就会绑到 **0.0.0.0**（内网可达）—— 桌面这个本应边界最紧的
 * 形态反而可能变成内网服务端；`CORE_TOKEN` / `CORE_AGENT_DIR` / `CORE_CWD` 亦可被宿主随意指认。
 *
 * 本函数只负责「算出要 spawn core 的 env 对象（+ 残留告警）」，不碰 child_process、不碰 Electron，
 * 便于 `scripts/boot-env-check.mjs` 离线起 core 实测绑定地址。修复策略 = **白名单化**：桌面壳对
 * core 的 env 完全收敛，宿主 `CORE_*` 一律不外传，另显式钉死安全收敛的固定值。
 */

export interface BootCoreEnvInput {
  /** 宿主（父进程）env，通常是 `process.env` */
  parentEnv: Record<string, string | undefined>;
  /** 运行时文件目录 → CORE_RUN_DIR（桌面壳指定为 <userData>/run） */
  runDir: string;
  /** 同源托管前端产物 → CORE_UI_DIST */
  uiDist: string;
  /** agent 目录 → CORE_AGENT_DIR（桌面壳在 userData 下的固定位置，**不由宿主 env 决定**） */
  agentDir: string;
  /** 监听端口 → CORE_PORT */
  port: string;
}

export interface BootCoreEnvResult {
  /** 传入 `spawn` 的 env */
  env: Record<string, string>;
  /** 被丢弃的宿主 `CORE_*` 变量名（桌面壳据此点名告警，不静默吞掉） */
  warnings: string[];
}

/**
 * 【先红态】如实承接当前 `bootCore` 的透传信封：`{ ...process.env, 覆写 ELECTRON_RUN_AS_NODE /
 * NODE_OPTIONS / CORE_RUN_DIR / CORE_UI_DIST / CORE_PORT }` —— **不收敛 `CORE_*`**。
 * 宿主 `CORE_HOST=0.0.0.0` 会透传给 core，使其绑内网（CR-072 病根，`boot-env-check` 据此标红）。
 * fix 提交改为白名单：显式钉 `CORE_HOST:"127.0.0.1"` / `CORE_ALLOWED_HOSTS:""` / **删** `CORE_TOKEN`
 * / 显式 `CORE_AGENT_DIR`，并把残留 `CORE_*` 登记进 `warnings`。
 */
export function buildBootCoreEnv(input: BootCoreEnvInput): BootCoreEnvResult {
  const env: Record<string, string> = {};
  // 全量透传宿主 env（含 CORE_*，= CR-072 病根）
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  // electron 自身的 NODE_OPTIONS 可能含纯 Electron 才认的开关，别带进子进程
  env.NODE_OPTIONS = "";
  env.CORE_RUN_DIR = input.runDir;
  env.CORE_UI_DIST = input.uiDist;
  env.CORE_PORT = input.port;
  // 【先红态】不设 CORE_HOST / CORE_ALLOWED_HOSTS / CORE_TOKEN / CORE_AGENT_DIR：宿主值原样透传。
  return { env, warnings: [] };
}
