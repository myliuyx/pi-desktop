/**
 * 功能开关 —— 只由「正式验收入口」驱动，**不做用户偏好持久化**。
 *
 * 为什么单独成文件（而不是塞进 `ui-store` 或 `mock/`）：
 * - 它**不是 UI 状态**（不进 store、不该被持久化，也不该出现在 05 屏设置项里），
 *   它是「这次运行以什么形态启动」，与 `?stress=` / `?preview=` / `?empty=` 同族；
 * - 也**不是 mock 数据**（`mock/` 放的是内容，不是行为开关）。
 *
 * ## MCP 开关的来源（2026-09-23 用户裁决「MCP 暂缓」）
 *
 * Pi 没有 MCP 概念（`pi/packages/coding-agent/docs/usage.md:310` 原文
 * `It intentionally does not include built-in MCP, ...`），所以「有哪些 MCP 服务器」
 * 这份清单**在 Pi 侧没有任何数据源** —— 装了第三方 MCP 扩展之后，那份清单归那个扩展管，
 * Pi 不保证是否 / 以什么形式暴露给宿主。**在没有来源的情况下继续展示 mock 数据属于误导**，
 * 故默认关闭。
 *
 * ## 为什么保留 `?mcp=1` 而不是直接删掉
 *
 * `accept:m2` 的 2-11（工具条顺序）与 `accept:m4` 的 4-4（MCP 区块 5 条断言）
 * 都依赖 MCP 区块存在。按 `.plan/pi-survey-plan.md` §五纪律，验收处置只能二选一：
 * **保留 mock 分支供回归** 或 退役并归档证据 —— 本实现选前者。
 * 于是：**组件代码、testid 契约、mock 数据全部原样保留在源码里**，仅默认不渲染；
 * 验收脚本带上 `?mcp=1` 即可继续跑原断言，**期望值一行都不用改**。
 *
 * 与「不动清单」的关系：本开关**没有移除任何 `data-testid`**（关闭时只是不渲染），
 * 因此不构成对不动清单的破坏；恢复也只需让本函数返回 `true`。
 *
 * @see .plan/pi-survey-plan.md S5「MCP 暂缓处置」
 * @see src/App.tsx 的 `applyStressParam()` / `applyPreviewTabParam()` / `applyEmptyParam()`
 */

/** 打开 MCP 区块的 URL 查询参数名（`?mcp=1`），走 `window.location.search` */
export const MCP_QUERY_PARAM = "mcp";

/** 打开真实链路（live）的 URL 查询参数名（`?live=1`），走 `window.location.search` */
export const LIVE_QUERY_PARAM = "live";

/**
 * MCP 区块是否启用。
 *
 * **默认 `false`**（MCP 暂缓）。带 `?mcp=1` 时为 `true`，供 `accept:m2` / `accept:m4` 回归。
 *
 * 说明：直接读 `window.location.search` 而不是经 store ——
 * 该参数在页面加载前就已确定，且 `location.search` 不随 hash 路由变化
 * （本项目是 hash 路由，见 `App.tsx` 的 `readHashParts()`），因此无需响应式。
 */
export function isMcpEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(MCP_QUERY_PARAM) === "1";
}

/**
 * 是否启用真实链路（live）。
 *
 * **默认 `false`**（与 MCP 同门控范式：默认形态必须仍是 mock）。
 * 带 `?live=1` 时为 `true`，UI 才会经 core 连接真实模型；
 * 同时读 `?core=<url>`（可选，跨源覆盖，默认同源 ""）与 `?token=<bearer>`（core 的 Bearer token）。
 *
 * 说明：同 MCP，直接读 `window.location.search`（页面加载即确定，不随 hash 变化）。
 */
export function isLiveEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(LIVE_QUERY_PARAM) === "1";
}

/**
 * 读取 live 模式配置（core 基址 + Bearer token）。
 *
 * token 来源优先级：
 * 1. `?token=` URL 参数（跨源 dev 场景：vite 5173 → core 5190 时手动带）；
 * 2. `window.__CORE_TOKEN__` —— **core 同源托管时由 server 注入到 index.html**（2026-09-23 起），
 *    ⇒ 用户只需打开 `http://127.0.0.1:<port>/?live=1`，token 不再进 URL / 收藏夹 / 历史记录。
 *
 * baseUrl：`?core=` 覆盖；core 同源托管时缺省相对路径 ""。
 */
export function getLiveConfig(): { baseUrl: string; token: string } {
  if (typeof window === "undefined") return { baseUrl: "", token: "" };
  const params = new URLSearchParams(window.location.search);
  const core = params.get("core");
  const token =
    params.get("token") ?? (window as { __CORE_TOKEN__?: string }).__CORE_TOKEN__ ?? "";
  return { baseUrl: core ?? "", token };
}

