/**
 * C4 · 会话持久化封装 —— `SessionManager` 的薄封装 + **独立**的 `SessionEntry[] → Message[]` 映射。
 *
 * ## 为什么必须另写一份映射（`.plan/archive/survey/S2-sessions.md` §四，本模块的存在理由）
 *
 * 会话文件里存的是 **`SessionEntry[]`（Pi 的落盘形状，带 id/parentId 的树）**，
 * 而实时对话走的是 **`AgentEvent`（事件流）** —— 两条路径的输入完全不同，
 * `packages/ui/src/adapter/reduce.ts` 的 `applyEvent` **不可复用**
 * （它处理的是 `message_start/update/end` + `tool_execution_*`，没有 entry 概念）。
 * 硬凑复用会出现「历史会话能显示、但字段对不上」这类静默错误。
 *
 * ## 映射口径（逐条，全部有出处）
 *
 * | entry | 处理 |
 * |---|---|
 * | `message`（role=user/assistant） | → 一条 `Message`，content 各部分映射为 Block |
 * | `message`（role=toolResult） | → **挂到对应 assistant 消息**上的 `TerminalBlock`（按 toolCallId 找宿主） |
 * | `message`（role=system） | 跳过（系统提示不该出现在对话流里），计入 `skipped` |
 * | `custom_message` | `display === false` → 跳过；否则 → assistant 文本消息（`S2 §四·3`） |
 * | `usage` | → `TokenUsage`（**但仅当分支上没有助手消息自带 usage 时**才用它，避免与消息 usage 重复计） |
 * | `compaction` / `branch_summary` | → assistant 文本消息（带标记前缀）—— 让历史不出现「凭空少了一段」 |
 * | `model_change` / `thinking_level_change` / `custom` / `label` / `session_info` | 跳过，计入 `skipped` |
 *
 * **树结构取主干**：用 `SessionManager.getBranch()`（当前 leaf → root 的**单条 active 分支**）。
 * 分支/fork 的 UI 明确记为后期（`S6 §四·4`）—— 本模块不渲染旁支，也不丢数据（文件里还在）。
 *
 * `TerminalBlock.exitCode` / `truncated` **刻意不填**：Pi 的会话 entry 里没有这两个字段
 * （与事件通道同因，见 `S6 §三·3`），Fabricate 一个 0/1 会让 UI 显示假成功。
 */

import {
  SessionManager,
  type CustomMessageEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  Block,
  Message,
  SessionLoadResult,
  SessionLoadStats,
  SessionSummary,
  TokenUsage,
} from "./contract.ts";
import { isRecord, num } from "./guards.ts";
import { fileRefNames, stripFileRefBlocks } from "./prompt-files.ts";
import { usageOf } from "./adapt.ts";
import { listSessionsCached, readFirstUserText } from "./session-list-cache.ts";

/* ---------------------------------------------------------------------------
 * 通用小工具
 * ------------------------------------------------------------------------- */

/** entry.timestamp / SessionInfo 的 Date → epoch ms（HTTP 过不了 Date 对象，core 侧统一转换） */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** 消息内容数组 → 我们的 Block[]（text / thinking / toolCall 三型，与实时 reducer 同形；
 *  image part 映射 ImageBlock 元数据，见下方 2026-10-01 注释） */
/** image part 的定位坐标（`ImageBlock` 只需定位，字节由取图端点负责） */
interface ImageLocator {
  sessionId: string;
  entryId: string;
}

function contentToBlocks(content: unknown, locator?: ImageLocator): Block[] {
  if (!Array.isArray(content)) {
    // 容错：旧版本/手改过的会话可能把 content 存成裸字符串
    return typeof content === "string" && content ? [{ type: "text", content }] : [];
  }
  const blocks: Block[] = [];
  for (const [partIndex, part] of content.entries()) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", content: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      // 2026-10-01 图片真缩略图批次：产出 ImageBlock 元数据（**不含** base64），
      // UI 拿定位三元组向 `GET /sessions/image` 换原图。
      // 替换掉 D3-A 的 `[图片]` 占位（当时是「不塞 base64 进载荷」的成本权衡，
      // 现由按需取图端点承担该成本）。
      // 无 locator（usageFromActiveBranch 路径）⇒ 跳过：那个 messages 会被丢弃。
      if (locator) {
        const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
        const data = part.data as string;
        blocks.push({
          type: "image",
          id: `${locator.entryId}-${partIndex}`,
          mimeType,
          bytes: Math.floor((data.length * 3) / 4),
          sessionId: locator.sessionId,
          entryId: locator.entryId,
          partIndex,
        });
      }
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      // 与实时通道一致：历史里的思考默认折叠（reducer 亦如此）
      blocks.push({ type: "thinking", content: part.thinking, collapsed: true });
    } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
      blocks.push({
        type: "tool_call",
        toolCallId: part.id,
        toolName: part.name,
        args: isRecord(part.arguments) ? (part.arguments as Record<string, unknown>) : {},
      });
    }
  }
  return blocks;
}

/** 工具结果内容拼成单段文本（`tool_execution_end.result.content[*].text` 同口径） */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => isRecord(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/** 命令文本：bash 取 args.command，其余工具退化为「工具名 + 参数摘要」 */
function commandOf(toolName: string, args: Record<string, unknown> | undefined): string {
  if (args && typeof args.command === "string") return args.command;
  const detail = args && Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 200) : "";
  return detail ? `${toolName} ${detail}` : toolName;
}

/**
 * 汇总一条 usage（助手消息的 `usage` 与 `UsageEntry.usage` 同一形状：pi-ai 的 `Usage`）。
 * `cacheRead/cacheWrite` **不并入 input** —— 它们已在 `totalTokens` 里，再叠加会重复计。
 *
 * 口径（2026-09-24 用户裁定）：`input`/`output` 取**最近一次**（`input` 已含历史上下文，
 * 累加会重复计）；`total` **历史累加** = ΣPi `totalTokens`（含 cache，故 ≥ Σ(input+output)）。
 * *Sum 五项（task-context-ring-token-popover.md D1）：会话累计口径，供环悬停浮框明细；
 * 分量四项 0 合法直接写，costTotal（Σ `usage.cost.total`，pi 按当次模型单价算好）>0 才写。
 */
function foldUsage(target: TokenUsage, usage: unknown): void {
	if (!isRecord(usage)) return;
	target.input = num(usage.input);
	target.output = num(usage.output);
	target.total += num(usage.totalTokens);
	// F2：cache 两项随「最近一次」口径带出（>0 才写，纪律同 contextTokens）
	const cacheRead = num(usage.cacheRead);
	const cacheWrite = num(usage.cacheWrite);
	if (cacheRead > 0) target.cacheRead = cacheRead;
	if (cacheWrite > 0) target.cacheWrite = cacheWrite;
	// D1 累计五项：Σ 分量 + Σ 费用（旧会话 jsonl 无 cost 字段 → num(undefined)=0 → 不写）
	target.inputSum = (target.inputSum ?? 0) + num(usage.input);
	target.outputSum = (target.outputSum ?? 0) + num(usage.output);
	target.cacheReadSum = (target.cacheReadSum ?? 0) + cacheRead;
	target.cacheWriteSum = (target.cacheWriteSum ?? 0) + cacheWrite;
	const cost = isRecord(usage.cost) ? num(usage.cost.total) : 0;
	if (cost > 0) target.costTotal = (target.costTotal ?? 0) + cost;
  /*
   * 已用上下文（最后一次带 usage 的 assistant 覆盖写入，口径同 Pi 的
   * `calculateContextTokens`：totalTokens 优先，否则 input+output+cacheRead+cacheWrite）。
   * 0 不写 → 无有效 usage 时 UI 回落 contextWindow（Windows 旧会话/entry 兜底形态）。
   */
  const contextTokens =
    num(usage.totalTokens) ||
    num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
  if (contextTokens > 0) target.contextTokens = contextTokens;
}

/* ---------------------------------------------------------------------------
 * SessionInfo → SessionSummary
 * ------------------------------------------------------------------------- */

/**
 * 首条 user 消息 → 标题兜底素材：@引用展开的 `<file>` 块是前置机器块，直接进标题会以
 * `<file name="F:\…` 开头（侧栏/页头不可读）。剥块取剩余正文；纯引用无正文时用引用名占位
 * （单名直出，多名「首名 等 N 个引用」）。块格式与拆解同源在 prompt-files.ts。
 */
export function titleFallbackFromFirstMessage(raw: string): string {
	const body = stripFileRefBlocks(raw);
	if (body) return body;
	const names = fileRefNames(raw);
	if (names.length === 1) return names[0];
	if (names.length > 1) return `${names[0]} 等 ${names.length} 个引用`;
	return "";
}

/**
 * `toSessionSummary` 的输入形状。
 *
 * 为什么不用 `SessionInfo`（2026-09-30 放宽）：清单现在走 `session-list-cache.ts`
 * 的两层索引（spec A4），缓存里没有 `SessionInfo`（不存 firstMessage 等长文本）。
 * 放宽为「本函数真正读到的字段」后，两条来源（Pi 的 `SessionInfo` 与缓存索引）
 * 都能直接用同一个装配逻辑 —— 标题口径与既有 `session-title-check` 覆盖不分叉。
 * `SessionInfo` 结构上兼容本接口，故既有调用方零改动。
 */
export interface SummarySource {
  id: string;
  name?: string;
  firstMessage: string;
  modified: string | number | Date;
  messageCount: number;
}

/** `title = name ?? firstMessage`（`S2 §三` 的裁决；两者皆空时给一个明确占位，不返回空标题） */
export function toSessionSummary(info: SummarySource): SessionSummary {
	const name = typeof info.name === "string" ? info.name.trim() : "";
	const first = typeof info.firstMessage === "string" ? info.firstMessage.trim() : "";
	return {
		id: info.id,
		title: name || titleFallbackFromFirstMessage(first) || "(未命名会话)",
		updatedAt: toEpochMs(info.modified),
		messageCount: typeof info.messageCount === "number" ? info.messageCount : 0,
	};
}

/* ---------------------------------------------------------------------------
 * SessionEntry[] → Message[]
 * ------------------------------------------------------------------------- */

export interface EntriesToMessagesOptions {
  /** 上下文窗口大小（`TokenUsage.contextWindow` 的唯一来源；来自当前模型，取不到则 0） */
  contextWindow?: number;
  /**
   * 会话 id —— `ImageBlock` 定位三元组之一。
   *
   * **缺省时 contentToBlocks 跳过 image part**：唯一不传它的调用方是
   * `usageFromActiveBranch`（只取 tokenUsage、丢弃 messages），产出
   * `sessionId: ""` 的坏块只会让 UI 拼出无效 URL。
   */
  sessionId?: string;
}

/**
 * 独立映射（**不要**与实时 reducer 合并，见文件头）：
 * 输入是主干上的 `SessionEntry[]`，输出是可直接喂 UI 的 `Message[]` 与用量汇总。
 */
export function entriesToMessages(
  entries: SessionEntry[],
  options: EntriesToMessagesOptions = {},
): { messages: Message[]; tokenUsage: TokenUsage; stats: SessionLoadStats } {
  const messages: Message[] = [];
  const skipped: Record<string, number> = {};
  const skip = (kind: string) => {
    skipped[kind] = (skipped[kind] ?? 0) + 1;
  };

  const usageFromMessages: TokenUsage = { input: 0, output: 0, total: 0, contextWindow: options.contextWindow ?? 0 };
  const usageFromEntries: TokenUsage = { input: 0, output: 0, total: 0, contextWindow: options.contextWindow ?? 0 };
  let sawMessageUsage = false;
  let sawEntryUsage = false;

  /** toolCallId → 该 toolCall 所在的 assistant 消息在 messages[] 里的下标 */
  const callOwner = new Map<string, number>();
  /** toolCallId → 该 toolCall 的参数（补 TerminalBlock.command 用） */
  const callArgs = new Map<string, Record<string, unknown>>();
  /** 最近一条 assistant 消息下标（toolResult 找不到宿主时的兜底位置） */
  let lastAssistant = -1;

  const timestampOf = (entry: SessionEntry): number => toEpochMs(entry.timestamp);

  for (const entry of entries) {
    const ts = timestampOf(entry);

    if (entry.type === "message") {
      const message = entry.message as unknown as Record<string, unknown>;
      const role = message?.role;

      if (role === "user" || role === "assistant") {
        // 只有带 sessionId 的调用（readSession）才产出 ImageBlock；
        // usageFromActiveBranch 走不到 images（它的 messages 会被丢弃），
        // 不传 locator 即让 contentToBlocks 内部跳过 image part。
        const blocks = contentToBlocks(
          message.content,
          options.sessionId ? { sessionId: options.sessionId, entryId: entry.id } : undefined,
        );
        // F2：逐条计量挂回消息（历史会话重载后 footer 仍在；与实时通道同经 adapt.usageOf 投影）
        const usage = role === "assistant" ? usageOf(message.usage) : undefined;
        // 模型标签回填（2026-09-27 用户裁决）：落盘 entry 与实时事件同源，assistant 消息
        // 带模型字段；旧版本会话文件没有 → 不设键，UI 不显示（同 usage 诚实展示纪律）
        const model = role === "assistant" && typeof message.model === "string" ? message.model : undefined;
        const responseModel =
          role === "assistant" && typeof message.responseModel === "string" ? message.responseModel : undefined;
        // 模型请求失败保留（2026-09-28 用户裁决：失败要可见，不许静默）：Pi 失败落盘
        // stopReason="error" 的消息，content 常为空壳 —— 此前被 empty-assistant-message
        // 静默跳过，重载后错误痕迹彻底消失。现保留为带 errorMessage 的消息（空壳也留），
        // 渲染层据此出错误框；aborted 是用户主动中止，维持原跳过行为。
        const failed = role === "assistant" && message.stopReason === "error";
        const errorMessage = failed
          ? typeof message.errorMessage === "string" && message.errorMessage.trim()
            ? message.errorMessage
            : "未知错误"
          : undefined;
        if (role === "assistant") {
          // 记下 toolCall 宿主，供后面的 toolResult 归位
          for (const b of blocks) {
            if (b.type === "tool_call") {
              callOwner.set(b.toolCallId, messages.length);
              callArgs.set(b.toolCallId, b.args);
            }
          }
        }
        if (blocks.length === 0) {
          if (failed) {
            messages.push({
              id: `m-${entry.id}`,
              role: "assistant",
              blocks: [],
              timestamp: ts,
              ...(model ? { model } : {}),
              ...(responseModel ? { responseModel } : {}),
              errorMessage,
            });
            lastAssistant = messages.length - 1;
            continue;
          }
          skip(role === "user" ? "empty-user-message" : "empty-assistant-message");
          continue;
        }
        messages.push({
          id: `m-${entry.id}`,
          role,
          blocks,
          timestamp: ts,
          ...(usage ? { usage } : {}),
          ...(model ? { model } : {}),
          ...(responseModel ? { responseModel } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        });
        if (role === "assistant") {
          lastAssistant = messages.length - 1;
          if (isRecord(message.usage)) {
            foldUsage(usageFromMessages, message.usage);
            sawMessageUsage = true;
          }
        }
        continue;
      }

      if (role === "toolResult") {
        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
        const block: Block = {
          type: "terminal",
          toolCallId,
          command: commandOf(toolName, callArgs.get(toolCallId)),
          output: textOfContent(message.content),
          status: message.isError === true ? "error" : "success",
          // 历史会话里的终端同样默认收起，与实时口径一致
          collapsed: true,
          // details 与实时通道同口径透传（task-tool-diff-preview.md）：edit 的
          // 展示用 diff 在 ToolResultMessage.details 里随会话 jsonl 落盘；无则不写键
          ...(isRecord(message.details) ? { details: message.details } : {}),
        };
        const owner = callOwner.get(toolCallId);
        if (owner !== undefined) {
          messages[owner] = { ...messages[owner], blocks: [...messages[owner].blocks, block] };
        } else if (lastAssistant >= 0) {
          // 宿主未命中（跨段的工具结果）：挂到最近一条 assistant 消息，避免整条结果丢失
          messages[lastAssistant] = {
            ...messages[lastAssistant],
            blocks: [...messages[lastAssistant].blocks, block],
          };
        } else {
          messages.push({ id: `m-${entry.id}`, role: "assistant", blocks: [block], timestamp: ts });
          lastAssistant = messages.length - 1;
        }
        continue;
      }

      // role === "system" 或未知 role
      skip(`message:${String(role)}`);
      continue;
    }

    if (entry.type === "custom_message") {
      const custom = entry as CustomMessageEntry;
      if (custom.display === false) {
        // `display` 是扩展对 TUI 渲染的控制（`session-manager.ts:152-154`），历史渲染同等遵守
        skip("custom_message:hidden");
        continue;
      }
      const content = textOfContent(custom.content);
      if (!content) {
        skip("custom_message:empty");
        continue;
      }
      messages.push({
        id: `m-${entry.id}`,
        role: "assistant",
        blocks: [{ type: "text", content }],
        timestamp: ts,
      });
      lastAssistant = messages.length - 1;
      continue;
    }

    if (entry.type === "usage") {
      // ⚠️ `UsageEntry` **未从包顶层导出**（`index.d.ts` 的 session-manager 导出清单里没有它），
      //    故按结构取 `usage` 字段；形状即 pi-ai 的 `Usage`（与助手消息的 usage 同源）。
      const usageEntry = entry as unknown as { usage?: unknown };
      if (isRecord(usageEntry.usage)) {
        foldUsage(usageFromEntries, usageEntry.usage);
        sawEntryUsage = true;
      }
      skip("usage");
      continue;
    }

    if (entry.type === "compaction") {
      const summary = typeof (entry as { summary?: unknown }).summary === "string" ? (entry as { summary: string }).summary : "";
      if (summary) {
        messages.push({
          id: `m-${entry.id}`,
          role: "assistant",
          blocks: [{ type: "text", content: `（会话此前被压缩，以下为摘要）\n\n${summary}` }],
          timestamp: ts,
        });
        lastAssistant = messages.length - 1;
      } else {
        skip("compaction:empty");
      }
      continue;
    }

    if (entry.type === "branch_summary") {
      const summary = typeof (entry as { summary?: unknown }).summary === "string" ? (entry as { summary: string }).summary : "";
      if (summary) {
        messages.push({
          id: `m-${entry.id}`,
          role: "assistant",
          blocks: [{ type: "text", content: `（分支摘要）\n\n${summary}` }],
          timestamp: ts,
        });
        lastAssistant = messages.length - 1;
      } else {
        skip("branch_summary:empty");
      }
      continue;
    }

    // model_change / thinking_level_change / custom / label / session_info：非消息类，跳过
    skip(entry.type);
  }

  /*
   * 用量来源二选一（不叠加）：助手消息自带的 usage 是逐条真实计量，
   * `UsageEntry` 的 `kind` 在 Pi 里是**任意分类**（如 cache_warm），语义不等价，
   * 只在没有任何消息级 usage 时才拿它兜底。
   */
  const useEntryUsage = !sawMessageUsage && sawEntryUsage;
  const tokenUsage = useEntryUsage ? usageFromEntries : usageFromMessages;

  return {
    messages,
    tokenUsage,
    stats: {
      entryCount: entries.length,
      messageCount: messages.length,
      skipped,
      usageSource: sawMessageUsage ? "assistant-usage" : sawEntryUsage ? "usage-entries" : "none",
      mainBranchOnly: true,
    },
  };
}

/* ---------------------------------------------------------------------------
 * SessionManager 封装（list / listAll / open / findById / continueRecent）
 * ------------------------------------------------------------------------- */

export interface SessionRef {
  cwd: string;
  /**
   * 会话目录。**必须与活动会话实际使用的目录一致**（`<agentDir>/sessions/<encoded-cwd>/`），
   * 由 `SessionManager.getSessionDir()` 提供；缺省时走 Pi 的默认目录（`~/.pi/agent/sessions`）。
   */
  sessionDir?: string;
}

/**
 * `readFirstUserText` 的防御包装：单个文件在扫描后消失（TOCTOU）或不可读时退化为
 * `null`，绝不让一条会话的故障拖垮整个清单请求（`GET /sessions` 返回 500）。
 */
function safeReadFirstUserText(filePath: string): string | null {
  try {
    return readFirstUserText(filePath);
  } catch {
    return null;
  }
}

/**
 * 会话清单。`all=true` 走跨项目目录（不过滤 cwd），否则只列 `ref.cwd`。
 *
 * 2026-09-30 起改走 `session-list-cache.ts` 的两层索引（spec 方案 A4）：
 * 原先直调 `SessionManager.list()` 会为**每个**会话文件 readline 逐行 parse
 * 并拼接全部消息文本，104 会话 / 40MB 实测 539ms 且随数据量线性增长。
 *
 * **语义对齐**：`all=false` 时按 `info.cwd`（header 里的真实值，非目录名反推）
 * 与 `path.resolve(ref.cwd)` 比较 —— 与原先 `SessionManager.list` 的
 * `sessionCwdMatches` 同口径。标题兜底（name 空时回读首条 user 文本）复用
 * 本文件既有的 `titleFallbackFromFirstMessage`，口径与 `toSessionSummary` 不分叉。
 */
export async function listSessions(ref: SessionRef, options: { all?: boolean } = {}): Promise<SessionSummary[]> {
  const { entries } = await listSessionsCached(ref, options);
  return entries.map(({ path: filePath, info }) => {
    /*
     * `toSessionSummary` 口径是 `title = name ?? firstMessage`：有 name 时 firstMessage
     * 根本不参与运算，而 `readFirstUserText` 要 open + 扫描文件（113 会话实测 ~290ms，
     * 其中 100 条有 name ⇒ 纯浪费）。故只在「无名 + 有 user 消息」时才回读 ——
     * 输出逐条比对零差异（见 task-3-report 的等价性验证）。索引刻意不存 firstMessage。
     */
    const firstMessage = !info.name && info.hasFirstUser ? (safeReadFirstUserText(filePath) ?? "") : "";
    return toSessionSummary({
      id: info.id,
      // name 为 null 时不传（SummarySource.name 是可选 string）
      ...(info.name ? { name: info.name } : {}),
      firstMessage,
      modified: info.modified,
      messageCount: info.messageCount,
    });
  });
}

/** 按 id 找会话文件（`findById` 只比对会话头里的 id，不接受路径，天然免疫目录穿越） */
export function findSessionPath(ref: SessionRef, id: string): string | undefined {
  return SessionManager.findById(ref.cwd, id, ref.sessionDir);
}

export interface LoadedSession {
  result: SessionLoadResult;
  /** 会话文件路径（复核用；不在 HTTP 响应里暴露） */
  path?: string;
}

function titleOf(manager: SessionManager, fallback: string): string {
  const name = manager.getSessionName()?.trim();
  if (name) return name;
  // 没有自定义名时用「首条 user 消息」兜底（与 SessionInfo.firstMessage 同口径；
  // @引用展开的 <file> 块同样在此剥离，保证 /sessions/load 的标题与清单同形）
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message?.role !== "user") continue;
    const raw = textOfContent(message.content).trim();
    if (!raw) continue;
    const title = titleFallbackFromFirstMessage(raw);
    if (title) return title.slice(0, 80);
  }
  return fallback;
}

/** 把一个已打开的 `SessionManager` 读成 `SessionLoadResult`（主干 + 消息映射） */
export function readSession(
  manager: SessionManager,
  options: { contextWindow?: number; path?: string } = {},
): LoadedSession {
  const entries = manager.getBranch();
  const { messages, tokenUsage, stats } = entriesToMessages(entries, {
    contextWindow: options.contextWindow,
    sessionId: manager.getSessionId(),
  });
  const header = manager.getHeader();
  // updatedAt：取主干上最后一次活动时间（`SessionInfo.modified` 在只按 id 打开时拿不到，
  // 而这是同一个语义 —— Pi 的 modified 就是「最后一条 entry 的时间」）。
  let updatedAt = header ? toEpochMs(header.timestamp) : 0;
  for (const entry of entries) updatedAt = Math.max(updatedAt, toEpochMs(entry.timestamp));
  if (!updatedAt) updatedAt = Date.now();
  return {
    path: options.path ?? manager.getSessionFile(),
    result: {
      id: manager.getSessionId(),
      title: titleOf(manager, "(未命名会话)"),
      updatedAt,
      messages,
      tokenUsage,
      stats,
    },
  };
}

/**
 * 活动分支的用量汇总 —— 供 `rebuildSession` 重置内存累计用。
 *
 * 必须与 `readSession` 同源（`getBranch()`，leaf → root 单条活动分支）：
 * 用 `getEntries()` 会把被弃旁支的 usage 折进来，导致「加载回来的 tokenUsage」
 * 与「内存里 reset 后的累计」分叉（Pi docs/extensions.md:174 同样要求
 * branch-sensitive state 从 getBranch 重建）。
 */
export function usageFromActiveBranch(manager: SessionManager, contextWindow: number): TokenUsage {
  return entriesToMessages(manager.getBranch(), { contextWindow }).tokenUsage;
}

/** 打开指定 id 的会话（找不到返回 null，由调用方决定 404 还是回落） */
export function loadSessionById(
  ref: SessionRef,
  id: string,
  options: { contextWindow?: number } = {},
): LoadedSession | null {
  const sessionPath = findSessionPath(ref, id);
  if (!sessionPath) return null;
  const manager = SessionManager.open(sessionPath, ref.sessionDir, ref.cwd);
  return readSession(manager, { ...options, path: sessionPath });
}

/**
 * 续接最近一次会话（`continueRecent`）—— 本函数**只负责读出**最近会话的内容。
 *
 * 「把 core 的活动 `AgentSession` 切过去」由 `session.ts` 的 `rebuildSession` 完成
 * （C6 §1.2：`createAgentSession({ sessionManager: SessionManager.open(file) })`
 * 公开路径，续写落同一 session 文件）；返回值里的 `path` 就是重建用的文件路径。
 */
export function continueRecentSession(
  ref: SessionRef,
  options: { contextWindow?: number } = {},
): LoadedSession {
  const manager = SessionManager.continueRecent(ref.cwd, ref.sessionDir);
  const sessionPath = manager.getSessionFile();
  if (!sessionPath) {
    // 没有任何历史会话：返回一个空壳（UI 侧表现为「无可续接」而不是报错）
    return {
      result: {
        id: manager.getSessionId(),
        title: "(未命名会话)",
        updatedAt: Date.now(),
        messages: [],
        tokenUsage: { input: 0, output: 0, total: 0, contextWindow: options.contextWindow ?? 0 },
        stats: {
          entryCount: 0,
          messageCount: 0,
          skipped: {},
          usageSource: "none",
          mainBranchOnly: true,
        },
      },
    };
  }
  return readSession(manager, { ...options, path: sessionPath });
}
