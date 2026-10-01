/**
 * 工具行收起态的参数摘要（行首那截灰字，task-tool-diff-preview.md D3）。
 *
 * bash 显示命令本身；edit/write 若走「key=value 全量展开」的通用兜底，会把
 * edits 数组拍成 `[object Object]`、把整份写入内容拍进行首（还进 title tooltip），
 * 改为面向人的短摘要；其余工具维持原兜底不变（mock / 验收面零影响）。
 */
export function toolArgsPreview(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "edit") {
    const path = typeof args.path === "string" ? args.path : "";
    const edits = Array.isArray(args.edits) ? args.edits.length : 0;
    if (path) return edits > 0 ? `${path} · ${edits} 处替换` : path;
  } else if (toolName === "write") {
    if (typeof args.path === "string") return args.path;
  }
  if (typeof args.command === "string") return args.command;
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}
