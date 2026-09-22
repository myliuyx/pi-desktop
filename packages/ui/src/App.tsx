import { useEffect, useState } from "react";
import { WorkbenchScreen } from "@/components/shell/WorkbenchScreen";
import { TokensScreen } from "@/screens/TokensScreen";
import { RunDetailScreen } from "@/screens/RunDetailScreen";
import { SkillsScreen } from "@/screens/SkillsScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { ShellsScreen } from "@/screens/ShellsScreen";
import { createStressSession, EMPTY_SESSION } from "@/mock/sessions";
import { useChatStore } from "@/store/chat-store";
import { useUiStore, type PreviewTab } from "@/store/ui-store";

/**
 * 屏幕路由。
 *
 * 用 hash 而不是引入 router 依赖：
 * - 本机文件/静态托管下 hash 一定能工作，不需要服务端 rewrite
 * - 原型阶段只有 6 个目标，不值得引入路由库
 * M5 已扩到 6 屏（00 令牌页 / 01 工作台 / 01b 源码态 / 02 深色 / 03 运行详情 /
 * 04 技能与工具 / 05 设置 / 06 窗口壳）。06 屏自身是独立 hash（`#/shells`）。
 * 若将来真的需要嵌套路由 / 历史栈，再评估 react-router。
 *
 * ⚠️ `readScreen()` 改成**查表**而不是逐条 if：
 * 逐条 if 的写法在只认 1 个值时够用，扩到 6 个值后每个新增屏都要改一遍判断链，
 * 且「非法值回落 workbench」这条兜底语义会在链式写法里变得不明显。
 */
export type ScreenId = "workbench" | "run-detail" | "skills" | "settings" | "tokens" | "shells";

/** hash 值 → 屏幕 id 的对照表。表的键即合法 hash，其余一律回落 workbench */
const SCREEN_BY_HASH: Record<string, ScreenId> = {
  workbench: "workbench",
  "run-detail": "run-detail",
  skills: "skills",
  settings: "settings",
  tokens: "tokens",
  shells: "shells",
};

/**
 * 解析 hash 里的「路径 + 查询串」两段。
 *
 * 为什么需要它（M5 踩到的真实缺陷）：06 屏的单壳入口写成 `#/shells?os=win`，
 * 这里的 `?os=win` 属于 **hash** 而不是 `location.search` ——
 * 浏览器不会把 hash 里问号之后的部分放进 `window.location.search`。
 * 早期实现直接用 `location.hash.replace(/^#\/?/,"")` 整段查表，
 * 拿到的是 `"shells?os=win"`，**既匹配不到 `SCREEN_BY_HASH`（回落 workbench）、
 * 又拿不到 os 参数**，表现为「?os= 完全无效」。
 *
 * 所以先按第一个 `?` 把 hash 切成 path / query 两段：
 * - path 用于查表定位屏幕
 * - query 供屏幕自己的参数解析（如 `?os=`）使用
 */
function readHashParts(): { path: string; query: URLSearchParams } {
  if (typeof window === "undefined") return { path: "", query: new URLSearchParams() };
  const raw = window.location.hash.replace(/^#\/?/, "");
  const qIndex = raw.indexOf("?");
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const queryStr = qIndex === -1 ? "" : raw.slice(qIndex + 1);
  return { path, query: new URLSearchParams(queryStr) };
}

function readScreen(): ScreenId {
  if (typeof window === "undefined") return "workbench";
  return SCREEN_BY_HASH[readHashParts().path] ?? "workbench";
}

/**
 * 压力测试入口（验收 2-2 用）：`?stress=600` 载入 600 条消息的会话。
 *
 * 为什么做成正式能力而不是临时调试代码：验收 2-2 要求「灌入 500+ 条消息后
 * DOM 渲染节点数远小于总数」，这个场景必须可复现 —— 靠临时改 mock 数据文件
 * 是没法反复跑的（M1 的教训：验收要可复跑，不能依赖"记得上次怎么改的"）。
 * 参数不存在时不做任何事，不影响正常演示。
 */
function applyStressParam(): void {
  if (typeof window === "undefined") return;
  const raw = new URLSearchParams(window.location.search).get("stress");
  if (!raw) return;
  const count = Number.parseInt(raw, 10);
  if (!Number.isFinite(count) || count <= 0) return;
  useChatStore.getState().loadSession(createStressSession(count));
}

/**
 * 01b 屏入口（验收 3-4）：`?preview=code` 进入时激活「预览源码」Tab，
 * `?preview=effect` 激活「预览效果」。参数不存在时不做任何事。
 *
 * 与 `?stress=` 同理做成正式能力 —— 01b 屏在原型里的唯一差别就是
 * 「预览区激活的 Tab 不同」，必须可复现、可复跑，不能靠手点。
 */
function applyPreviewTabParam(): void {
  if (typeof window === "undefined") return;
  const raw = new URLSearchParams(window.location.search).get("preview");
  if (raw !== "code" && raw !== "effect") return;
  useUiStore.getState().setPreviewTab(raw as PreviewTab);
}

/**
 * 空会话入口（验收 5-7）：`?empty=1` 载入 0 条消息的空会话。
 *
 * 为什么做成正式能力：验收 5-7 要求「空状态不塌陷」，这个场景必须**可复现**。
 * 靠手动删数据没法反复跑（M2 的教训：验收要可复跑）。参数不存在时不做任何事。
 */
function applyEmptyParam(): void {
  if (typeof window === "undefined") return;
  const raw = new URLSearchParams(window.location.search).get("empty");
  if (raw !== "1") return;
  useChatStore.getState().loadSession(EMPTY_SESSION);
}

export default function App() {
  const [screen, setScreen] = useState<ScreenId>(readScreen);

  useEffect(() => {
    applyStressParam();
    applyPreviewTabParam();
    applyEmptyParam();
    const onHashChange = () => setScreen(readScreen());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /**
   * 屏幕分发。
   *
   * 标题栏 / 侧边栏底部的「设置」按钮跳 05 设置屏（M4 起不再是 00 屏体检页）；
   * 00 屏体检页保留在 `#/tokens` 路由上，从 05 屏的返回按钮与直接改 hash 都进得去。
   * 三屏（03/04/05）都是「工作台里的一块」，共用 WindowShell + Sidebar，
   * 只换内容区 —— 与 WorkbenchScreen 的区别是**不渲染 PreviewPane**（见 lib/layout.ts 的 M4 段）。
   * 06 屏（`#/shells`）同样是「工作台里的一块」，但内容区是并排三端壳 / 单壳全屏。
   */
  const goWorkbench = () => setScreen("workbench");
  const goSettings = () => setScreen("settings");

  switch (screen) {
    case "run-detail":
      return <RunDetailScreen onBackToWorkbench={goWorkbench} onOpenSettings={goSettings} />;
    case "skills":
      return <SkillsScreen onBackToWorkbench={goWorkbench} onOpenSettings={goSettings} />;
    case "settings":
      return <SettingsScreen onBackToWorkbench={goWorkbench} />;
    case "tokens":
      return <TokensScreen onBackToWorkbench={goWorkbench} />;
    case "shells":
      return <ShellsScreen onBackToWorkbench={goWorkbench} onOpenSettings={goSettings} />;
    default:
      return <WorkbenchScreen onOpenSettings={goSettings} />;
  }
}
