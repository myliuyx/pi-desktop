import { forwardRef, useState, type HTMLAttributes } from "react";
import { ChevronDown, Paperclip } from "lucide-react";
import { cn } from "@/lib/cn";
import { MESSAGE_MAX_WIDTH } from "@/lib/layout";
import type { MessageRole, TextBlock } from "@/mock/types";
import { Markdown } from "@/components/common/Markdown";
import { Icon } from "@/components/common/icons";

export interface MessageBubbleProps extends HTMLAttributes<HTMLDivElement> {
  block: TextBlock;
  role: MessageRole;
  /** 流式进行中：在末尾显示一个跳动光标 */
  streaming?: boolean;
  /**
   * user 消息的贴图附件（粘图批次，Message.attachments 透传；BlockView 持有整个
   * message 所以由它传）。仅乐观回显存在（core 序列化恒不写），历史回放没有该字段。
   */
  attachments?: { id: string; dataUrl: string }[];
}

/* -------------------------------------------------------------------------
 * 注入文件块解析（at-file 批次 · D5 2026-09-28 渲染层折叠）
 *
 * 背景：历史上core 把 @引用展开成 `<file name="绝对路径">内容</file>` 前置块后整体交给
 * pi（PromptOptions 没有「正文之外的文本上下文通道」），pi 原样记录进 session ——
 * 于是**发送瞬间**气泡显示本地原文，**刷新后**（/sessions/load 回放）气泡变成
 * 一大段file 块（用户实测报告「一次看还好，刷新一下页面就变了」）。
 * 上游限制动不了，在渲染层统一：user 消息正文里的 file 块折叠成「📎 文件名」
 * 折叠条，其余文本照常 —— 两条路径的显示从此一致，内容仍可展开查看。
 * assistant 消息不做此解析（其正文的 `<file>` 字面量是内容，不是注入）。
 *
 * ★ 2026-10-02：@引用**已停止注入**（模型自己read/ls，避免同一份内容读两遍）。
 * 本折叠条**仅为历史 session 解拆而保留**——旧会话已把块持久化进正文，不拆则刷新后
 * 漏出机器文本。故文案已从「已注入模型上下文」改为中性的「历史注入内容」，
 * 避免让用户误以为当前仍在注入。新会话不再产生file 块，自然不出现此条。
 * ------------------------------------------------------------------------- */

interface InjectedFileSegment {
  kind: "file";
  name: string;
  body: string;
}
interface TextSegment {
  kind: "text";
  text: string;
}
type ContentSegment = TextSegment | InjectedFileSegment;

/** 匹配历史 core 注入块格式（自 2026-10-02 起新消息不再产生，仅解旧session） */
const INJECTED_FILE_BLOCK_RE = /<file name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>\n?/g;

/** 把 content 拆成 [text | file] 序列；无 file 块时返回单个 text 段 */
export function splitInjectedFileBlocks(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let last = 0;
  for (let m = INJECTED_FILE_BLOCK_RE.exec(content); m; m = INJECTED_FILE_BLOCK_RE.exec(content)) {
    if (m.index > last) segments.push({ kind: "text", text: content.slice(last, m.index) });
    segments.push({ kind: "file", name: m[1] ?? "", body: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
}

/** 历史注入文件折叠条：默认折叠，点击展开内容（session 里的真实正文） */
function FileBlockChip({ name, body }: { name: string; body: string }) {
  const [open, setOpen] = useState(false);
  // testid 按文件名安全化而非序号——多条消息各带一个 chip 时裸 index 必重复
  // （dir-tree 批次「同种状态行裸 testid 重复」教训的同类坑）
  const safeName = name.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9_-]/g, "-") || "file";
  return (
    <div data-testid={`message-file-chip-${safeName}`} className="my-1 min-w-0">
      <button
        type="button"
        data-file-name={name}
        aria-expanded={open}
        title={name}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-left text-xs",
          "border border-border-subtle bg-bg-surface text-text-secondary",
          "transition-colors duration-150 ease-out hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
        )}
      >
        <Icon icon={Paperclip} size={12} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 truncate font-mono">{name.split(/[\\/]/).pop()}</span>
        <span className="shrink-0 text-text-tertiary">历史注入内容</span>
        <Icon
          icon={ChevronDown}
          size={11}
          className={cn("shrink-0 text-text-tertiary transition-transform duration-150", open && "rotate-180")}
        />
      </button>
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-bg-surface p-2 font-mono text-xs text-text-secondary">
          {body}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * 文本气泡（消息里的 TextBlock）。
 *
 * 气泡底色按角色区分，但**全部走语义令牌**：
 * - 助手：bg-surface + 细边框（与卡片同族）
 * - 用户：accent-soft 底（呼应发送按钮的底色，形成呼应）
 * 气泡 `max-width` 取自 MESSAGE_MAX_WIDTH，且 `min-w-0` 让长内容能收缩、配合
 * Markdown 的 overflow-wrap 不撑破容器（验收 2-18）。
 */
export const MessageBubble = forwardRef<HTMLDivElement, MessageBubbleProps>(function MessageBubble(
  { block, role, streaming = false, attachments, className, ...rest },
  ref,
) {
  // F1 §2.4：空文本（mock 首字未到的占位块）不渲染 —— 否则等待占位行下方会并存一个空壳气泡。
  // 粘图批次豁免：纯图消息正文为空但有附件，气泡（及其附件行）必须照常出现。
  if (!block.content.trim() && !(role === "user" && attachments && attachments.length > 0)) return null;

  // 历史 session 解拆（at-file D5）：user 消息按「text + file 块」拆段渲染；assistant 不拆（见上方注释）
  const segments = role === "user" ? splitInjectedFileBlocks(block.content) : null;

  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 rounded-xl px-3.5 py-2.5",
        role === "user"
          ? "bg-accent-soft text-text-primary"
          : "border border-border-subtle bg-bg-surface text-text-primary",
        className,
      )}
      style={{ maxWidth: MESSAGE_MAX_WIDTH }}
      {...rest}
    >
      {segments ? (
        segments.map((seg, i) =>
          seg.kind === "file" ? (
            <FileBlockChip key={i} name={seg.name} body={seg.body} />
          ) : seg.text.trim() ? (
            <Markdown key={i} content={seg.text} />
          ) : null,
        )
      ) : (
        <Markdown content={block.content} />
      )}
      {/* 粘图批次：user 气泡的贴图缩略图（乐观回显）。纯展示不做灯箱；样式全走 rgb token（G1） */}
      {attachments && attachments.length > 0 ? (
        <div data-testid="message-attachments" className="mt-1.5 flex max-w-full flex-wrap gap-1.5">
          {attachments.map((g) => (
            <img
              key={g.id}
              src={g.dataUrl}
              alt="粘贴的图片"
              data-testid={`message-attachment-${g.id}`}
              className="h-16 max-w-full rounded-lg border border-border-subtle object-cover"
            />
          ))}
        </div>
      ) : null}
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-text-primary align-middle"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
});
