/**
 * 会话清单索引 —— 让清单代价与「会话总数据量」解耦。
 *
 * ## 为什么需要它（2026-09-30 实测）
 *
 * 原先 `sessions.ts` 的 `listSessions()` 直调 Pi 的 `SessionManager.list()`，
 * 后者对**每一个**会话文件 readline 逐行 `JSON.parse` 并拼接全部消息文本
 * （`allMessagesText`，core 一个字节都不用）。104 会话 / 40MB 实测 **539ms**，
 * 且随数据总量线性增长 —— 会话涨到上万时不可接受。
 *
 * 本模块只提取清单真正需要的字段，并做两层缓存：
 * - **热层** 进程内 Map：命中只做 `stat`（实测 197 文件 2ms）。
 * - **冷底** `<agentDir>/session-index.json`：core 重启后首屏也是毫秒级。
 *
 * ## 失效判据为什么是「整文件指纹」而不是「尾读增量」
 *
 * Pi 的 `session-manager.ts` `_rewriteFile()` 会 `openSync(file, "w")` **全量重写**
 * 会话文件（改名 / 分支触发）。所以「只读新增字节」会读到被截断的文件。
 * 指纹取 `(size, mtimeMs)`，任一变化即失配、整文件重扫。
 *
 * **已知局限**：同尺寸且 mtime 被还原的编辑会漏检。本仓会话文件由 Pi 单写者
 * append/rewrite，实践中不构成问题；不引入内容哈希（那要每次读全量，直接抵消优化）。
 *
 * ## 依赖方向（勿破坏）
 *
 * 本模块**绝不 import `sessions.ts`**（会成环）。标题兜底逻辑用的是 Pi 的
 * `session_info.name`；`name` 为空时由调用方（sessions.ts）用 `readFirstUserText`
 * 回读首条 user 文本再走它自己的 `titleFallbackFromFirstMessage`。
 */

import fs from "node:fs";

/** 块读大小（1MB）：足够吞掉绝大多数行，避免频繁 read 系统调用 */
const READ_BLOCK = 1 << 20;

/** 轻量扫描结果（清单所需字段 + 标题兜底判据） */
export interface LightScan {
  id: string;
  cwd: string;
  /** Pi 的 session_info.name（后写覆盖前写；空串 → null） */
  name: string | null;
  messageCount: number;
  /** header.timestamp 原样（ISO 字符串） */
  created: string;
  /** epoch ms：最后一条 message 的 timestamp，退化 header，再退化 mtime */
  modified: number;
  /** 是否出现过 role=user 的消息 —— 决定 title 是否需要回读 firstMessage 兜底 */
  hasFirstUser: boolean;
}

/** 与 `sessions.ts` 的 `textOfContent` 同口径（content 各部分 text 拼接，无分隔符） */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join("");
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 轻量扫一个会话文件：只取清单字段，**不逐行 JSON.parse**。
 *
 * 判据用行的前缀（`{"type":"message",` 等）。可靠性已在 40 个真实会话文件的
 * 2527 条 message 上实测：与真实 parse 出的 type **匹配 / 不匹配 = 0**；
 * 且所有行均以 `{"type":` 开头（无前导空格、无键序变体）。
 * 即使将来行格式漂移，最坏后果是「这一行的计数/时间戳漏掉」；
 * header 与 name 仍走完整 parse 兜底 —— 不会读出错值。
 */
export function scanSessionFileLight(filePath: string): LightScan | null {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(READ_BLOCK);
  let carry = "";
  let header: Record<string, unknown> | null = null;
  let name: string | null = null;
  let messageCount = 0;
  let hasFirstUser = false;
  let lastActivity = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      const chunk = carry + buf.subarray(0, read).toString("utf8");
      const lines = chunk.split("\n");
      // 最后一段可能是被块切断的半行，留到下一轮拼接
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('{"type":"session",')) {
          if (!header) header = parseJson(line);
        } else if (line.startsWith('{"type":"message",')) {
          messageCount++;
          // role=user 判定：先看字符串再 parse 确认（诱饵字符串在工具输出里真实存在）
          if (!hasFirstUser && line.includes('"role":"user"')) {
            const e = parseJson(line);
            if (e && (e.message as { role?: unknown } | undefined)?.role === "user") hasFirstUser = true;
          }
          const m = /"timestamp":"([^"]+)"/.exec(line.slice(0, 300));
          if (m) {
            const t = Date.parse(m[1]);
            if (Number.isFinite(t) && t > lastActivity) lastActivity = t;
          }
        } else if (line.startsWith('{"type":"session_info",')) {
          const e = parseJson(line);
          if (e) {
            const raw = e.name;
            name = typeof raw === "string" && raw.trim() ? raw.trim() : null;
          }
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!header || typeof header.id !== "string") return null;
  const st = fs.statSync(filePath);
  const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  const modified = lastActivity > 0 ? lastActivity : Number.isFinite(headerTime) ? headerTime : st.mtimeMs;
  return {
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    messageCount,
    created: typeof header.timestamp === "string" ? header.timestamp : new Date(st.mtimeMs).toISOString(),
    modified,
    hasFirstUser,
  };
}

/**
 * 读首条 user 消息的文本（标题兜底用）。
 *
 * 只在「会话没有自定义 name」时被调用 —— 索引刻意不存 firstMessage（长文本，
 * 存了索引会大三倍，实测 540B/条 → 存文本后数倍）。找到首条 user 文本立即返回，
 * 不读完文件。
 */
export function readFirstUserText(filePath: string): string | null {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(READ_BLOCK);
  let carry = "";
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) return null;
      const chunk = carry + buf.subarray(0, read).toString("utf8");
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith('{"type":"message",')) continue;
        if (!line.includes('"role":"user"')) continue;
        const e = parseJson(line);
        const message = e?.message as { role?: unknown; content?: unknown } | undefined;
        if (message?.role !== "user") continue;
        const text = extractText(message.content).trim();
        if (text) return text;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}