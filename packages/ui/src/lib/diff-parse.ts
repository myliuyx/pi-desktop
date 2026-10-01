/**
 * 上游 edit 工具 `details.diff` 的解析（task-tool-diff-preview.md D1/D4）。
 *
 * diff 由 pi 的 `generateDiffString` 生成，行格式（实测样本见规格书 §1.1）：
 *   `+{行号} {内容}`  新增行 —— 行号 = 新文件行号
 *   `-{行号} {内容}`  删除行 —— 行号 = 旧文件行号
 *   ` {行号} {内容}`  上下文行 —— 行号 = 新文件行号
 *   ` {空白} ...`     省略标记行（长段未变内容的折叠，行号位是空格填充）
 * 行号右对齐 padStart（宽度按文件行数自适应），所以前缀与数字之间可能有空格。
 * 单列行号（D4 裁决）：add/ctx 共用新文件行号、del 用旧文件行号，跳行处出省略行。
 */

export type DiffLineKind = "add" | "del" | "ctx" | "skip";

export interface DiffLine {
  kind: DiffLineKind;
  /** 文件行号；省略标记行无行号 */
  lineNo?: number;
  /** 行内容（保留 tab/空格原样；空行上下文为 ""） */
  content: string;
}

/** 前缀(可选) + 空白 + 行号(可选) + 单个分隔空格 + 内容。无行号即省略标记行。 */
const DIFF_LINE_RE = /^([+-]?)\s*(\d+)?\s(.*)$/;

export function parseDetailsDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return [];
  const out: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    // 真正的空行上下文形如 " 175 "（带行号）；裸 "" 只可能是 join 伪影，跳过
    if (raw === "") continue;
    const m = DIFF_LINE_RE.exec(raw);
    if (!m) {
      // 形状外的行（理论不出现）：按上下文原样渲染，不丢内容
      out.push({ kind: "ctx", content: raw });
      continue;
    }
    const [, sign, numStr, content] = m;
    if (numStr === undefined) {
      out.push({ kind: "skip", content });
    } else {
      out.push({
        kind: sign === "+" ? "add" : sign === "-" ? "del" : "ctx",
        lineNo: Number(numStr),
        content,
      });
    }
  }
  return out;
}

/** 增删行计数（工具卡 diff 头行的 `+n / -d 行`） */
export function countDiffChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}
