/**
 * Sidebar 分区布局回归检查。
 *
 * 直接通过 Vite SSR 加载并渲染真实 Sidebar 组件，不复制组件逻辑，也不新增 DOM 测试依赖。
 * 检查的是用户可见的渲染契约：搜索输入框、顶部操作固定、历史/工作目录各自滚动、
 * 两区按 2:1 分配剩余高度，以及历史标题过滤逻辑。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS | ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL | ${name}${detail ? `\n      ${detail}` : ""}`);
}

function openingTagAt(html, testId) {
  const marker = `data-testid="${testId}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.lastIndexOf("<", markerIndex);
  const end = html.indexOf(">", markerIndex);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end + 1);
}

function indexOfTestId(html, testId) {
  return html.indexOf(`data-testid="${testId}"`);
}

function hasClasses(tag, classes) {
  if (!tag) return { ok: false, actual: [], missing: classes };
  const match = tag.match(/\bclass="([^"]*)"/);
  const actual = new Set((match?.[1] ?? "").split(/\s+/).filter(Boolean));
  const missing = classes.filter((name) => !actual.has(name));
  return { ok: missing.length === 0, actual: [...actual], missing };
}

function inlineStyle(tag) {
  const value = tag?.match(/\bstyle="([^"]*)"/)?.[1] ?? "";
  return new Map(value.split(";").filter(Boolean).map((item) => {
    const split = item.indexOf(":");
    return [item.slice(0, split).trim(), item.slice(split + 1).trim()];
  }));
}

const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  appType: "custom",
  server: { middlewareMode: true },
  logLevel: "silent",
});

try {
  const { Sidebar, filterSessionSummaries } = await server.ssrLoadModule("/src/components/shell/Sidebar.tsx");
  const { SESSION_SUMMARIES } = await server.ssrLoadModule("/src/mock/sessions.ts");
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      activeSessionId: "session-0",
      workingDirectory: "/tmp/pi-desktop-contract-check",
      footer: createElement("footer", { "data-testid": "sidebar-check-footer" }),
    }),
  );

  const contentTag = openingTagAt(html, "sidebar-content");
  const contentClasses = hasClasses(contentTag, ["flex", "min-h-0", "flex-1", "flex-col", "overflow-hidden"]);
  check("侧栏内容区自身不再整体滚动", contentClasses.ok && !contentClasses.actual.includes("overflow-y-auto"), contentTag ?? "缺少 sidebar-content");

  const actionsTag = openingTagAt(html, "sidebar-actions");
  const actionClasses = hasClasses(actionsTag, ["flex", "shrink-0", "flex-col"]);
  check("新建/搜索操作区固定且不滚动", actionClasses.ok && !actionClasses.actual.includes("overflow-y-auto"), actionsTag ?? "缺少 sidebar-actions");

  const searchTag = openingTagAt(html, "sidebar-search");
  check(
    "侧栏搜索渲染为带占位文字的输入框",
    searchTag?.startsWith("<input")
      && searchTag.includes('type="search"')
      && searchTag.includes('placeholder="搜索历史会话"')
      && searchTag.includes('aria-label="搜索历史会话"'),
    searchTag ?? "缺少 sidebar-search",
  );

  if (typeof filterSessionSummaries === "function") {
    const mcpMatches = filterSessionSummaries(SESSION_SUMMARIES, "  McP  ");
    check(
      "历史会话搜索忽略首尾空格和英文大小写",
      mcpMatches.length === 1 && mcpMatches[0]?.id === "session-demo-3",
      JSON.stringify(mcpMatches.map((session) => session.id)),
    );
    check(
      "空搜索词恢复全部历史会话",
      filterSessionSummaries(SESSION_SUMMARIES, "   ").length === SESSION_SUMMARIES.length,
    );
    check(
      "无匹配标题返回空结果",
      filterSessionSummaries(SESSION_SUMMARIES, "不存在的会话标题").length === 0,
    );
  } else {
    check("历史会话标题过滤函数可用", false, "缺少 filterSessionSummaries 导出");
  }

  const historySectionTag = openingTagAt(html, "sidebar-history-section");
  const historySectionClasses = hasClasses(historySectionTag, ["flex", "min-h-0", "flex-col", "overflow-hidden"]);
  const historySectionStyle = inlineStyle(historySectionTag);
  check(
    "历史会话区占用剩余高度的 2 份并可收缩",
    historySectionClasses.ok
      && historySectionStyle.get("flex-grow") === "2"
      && historySectionStyle.get("flex-basis") === "0%"
      && historySectionStyle.get("gap") === "10px",
    historySectionTag ?? "缺少 sidebar-history-section",
  );

  const historyTag = openingTagAt(html, "sidebar-history");
  const historyClasses = hasClasses(historyTag, ["min-h-0", "flex-1", "overflow-y-auto", "overflow-x-hidden"]);
  check("历史会话列表独立纵向滚动", historyClasses.ok, historyTag ?? "缺少 sidebar-history");

  const workingSectionTag = openingTagAt(html, "sidebar-working-directory-section");
  const workingSectionClasses = hasClasses(workingSectionTag, ["flex", "min-h-0", "flex-col", "overflow-hidden"]);
  const workingSectionStyle = inlineStyle(workingSectionTag);
  check(
    "工作目录区占用剩余高度的 1 份并可收缩",
    workingSectionClasses.ok
      && workingSectionStyle.get("flex-grow") === "1"
      && workingSectionStyle.get("flex-basis") === "0%"
      && workingSectionStyle.get("gap") === "10px",
    workingSectionTag ?? "缺少 sidebar-working-directory-section",
  );

  const workingContentTag = openingTagAt(html, "sidebar-working-directory-content");
  const workingContentClasses = hasClasses(workingContentTag, ["flex", "min-h-0", "flex-1", "flex-col", "overflow-y-auto", "overflow-x-hidden"]);
  check("工作目录内容独立纵向滚动", workingContentClasses.ok, workingContentTag ?? "缺少 sidebar-working-directory-content");

  const contentIndex = indexOfTestId(html, "sidebar-content");
  const historyIndex = indexOfTestId(html, "sidebar-history-section");
  const workingSectionIndex = indexOfTestId(html, "sidebar-working-directory-section");
  const workingContentIndex = indexOfTestId(html, "sidebar-working-directory-content");
  const pathIndex = indexOfTestId(html, "sidebar-working-directory");
  const footerIndex = indexOfTestId(html, "sidebar-check-footer");
  // 2026-09-25 滚动修复：触发条（当前目录行）挪到滚动容器**之前**固定，
  // 不再随文件树滚出视野 ⇒ 断言从 workingContent < path 反转为 path < workingContent。
  check(
    "侧栏顺序保持：操作区 → 历史区 → 工作目录区（触发条 → 滚动内容）→ Footer",
    contentIndex < historyIndex && historyIndex < workingSectionIndex && workingSectionIndex < pathIndex && pathIndex < workingContentIndex && workingContentIndex < footerIndex,
    JSON.stringify({ contentIndex, historyIndex, workingSectionIndex, workingContentIndex, pathIndex, footerIndex }),
  );
} finally {
  await server.close();
}

if (failed > 0) {
  console.error(`\nSidebar 布局检查失败：${failed} 项`);
  process.exit(1);
}
console.log("\nSidebar 布局检查全部通过");
