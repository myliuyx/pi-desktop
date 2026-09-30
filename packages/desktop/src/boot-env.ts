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
  /**
   * 上次工作目录 → CORE_CWD（task-desktop-stable-port.md F4）。取值来源是桌面壳自己
   * 落盘的 last-run.json（上一轮 core 的自报目录），**不是宿主 env**——与 CR-072
   * 「宿主 CORE_* 一律不外传」不冲突；缺省/空 = 不设该键（core 回落 process.cwd()）。
   * 传空串会踩 core 的「空白值警告回落」分支，故约定只传非空或干脆不传。
   */
  cwd?: string;
}

export interface BootCoreEnvResult {
  /** 传入 `spawn` 的 env */
  env: Record<string, string>;
  /** 被丢弃的宿主 `CORE_*` 变量名（桌面壳据此点名告警，不静默吞掉） */
  warnings: string[];
}

/**
 * CR-072：bootCore env **白名单化**。桌面壳对 core 的 env 完全收敛：
 * 1. 非 `CORE_*` 的宿主变量（PATH/HOME/…，core 与工具子进程要用）照常透传；`NODE_OPTIONS`
 *    不透传（electron 专属开关，见原 bootCore 注释），下方显式置空；
 * 2. 任何宿主 `CORE_*` **一律不外传**（这正是 CR-072 的病根：`{ ...process.env }` 会带上它们）
 *    —— 逐个登记进 `warnings`，由调用方向用户点名告警，不静默吞掉；
 * 3. 桌面壳显式钉死一组**合法** `CORE_*`，含安全收敛的固定值：
 *    - `CORE_HOST:"127.0.0.1"`：桌面 core 仅绑回环，绝不因宿主 `CORE_HOST` 暴露内网；
 *    - `CORE_ALLOWED_HOSTS:""`：清空追加白名单，Host 校验收紧；
 *    - `CORE_AGENT_DIR`：指向桌面壳在 userData 下的固定位置，**不由宿主 env 决定**（否则会
 *      静默读写非预期 agentDir，见 CR-072 / CR-074）；
 *    - `CORE_TOKEN`：此处**删除**（见下方注释，不能设成空串）。
 *
 * 与 README 自托管口径的冲突前提（CR-072 注释锚定）：README 教用户给自托管 core 设
 * `CORE_HOST=0.0.0.0`；那对「core 独立跑」成立，但**桌面形态必须与之解耦**——桌面是本应边界
 * 最紧的形态，内嵌 core 只服务本机窗口（`createWindow(\`http://127.0.0.1:port/\`)`），无任何
 * 理由随宿主 env 变成内网可达。故这里无条件钉死回环，用户的自托管 env 不影响桌面版。
 */
export function buildBootCoreEnv(input: BootCoreEnvInput): BootCoreEnvResult {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) continue;
    if (key === "NODE_OPTIONS") continue; // electron 专属开关，下方显式置空
    if (key.startsWith("CORE_")) {
      warnings.push(key); // 宿主 CORE_* 一律不外传，逐条点名
      continue;
    }
    env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.NODE_OPTIONS = "";
  // 桌面壳显式钉死的合法 CORE_*
  env.CORE_RUN_DIR = input.runDir;
  env.CORE_UI_DIST = input.uiDist;
  env.CORE_PORT = input.port;
  env.CORE_HOST = "127.0.0.1";
  env.CORE_ALLOWED_HOSTS = "";
  env.CORE_AGENT_DIR = input.agentDir;
  // F4：恢复上次工作目录。只认非空值（空串会触发 core 的空白值警告回落，白报警告）
  if (input.cwd) env.CORE_CWD = input.cwd;
  /*
   * CORE_TOKEN：**删除**（不设值）—— core 取 `process.env.CORE_TOKEN ?? randomUUID()` 生成随机
   * token。不能设成空串 ""：空串不触发 `??`，core 会用空 token，于是 /health 的 Authorization
   * 头值 `Bearer `（尾随空格）被 HTTP 层裁成 `Bearer`、与 core 的 `Bearer ` 永不相等，恒 401
   * （boot-env-check 实证过）。删除既阻断宿主注入的已知/弱 token，又保留「随机 UUID」安全默认
   * （core 写入 core.json，桌面读它鉴权，见 desktop main.ts 的 readCoreInfo）。
   */
  return { env, warnings };
}
