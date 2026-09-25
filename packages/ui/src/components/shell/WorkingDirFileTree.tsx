import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, File, Folder, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import type { DirEntryResult } from "@/services/agent-transport";
import { useChatStore } from "@/store/chat-store";

/**
 * 侧栏「工作目录」触发条下方的文件树（dir-tree 批次，task-sidebar-file-tree.md §4.6）。
 *
 * ## 渲染门槛（D2，诚实于形态）
 *
 * 三者缺一不渲染（返回 null，触发条区域保持 dir-menu 批次前的原样）：
 * - 浏览器环境（SSR —— `check:sidebar-layout` 走服务端渲染，不能有 DOM 副作用）；
 * - live 形态（mock 没有 core，没有 fs 数据源，不渲染任何"像列表的东西"）；
 * - `liveCwd` 已拿到（unavailable 占位期与触发条的「未知目录」口径一致，不渲染半棵树）。
 *
 * ## 数据与刷新（D3/D7）
 *
 * - 唯一真相源：`chat-store.liveCwd`（cwd 变化 ⇒ 清空展开集、重拉根）+
 *   `chat-store.fsVersion`（`refreshSessions()` 成功就 +1 ⇒ 保持展开集、重拉根 +
 *   各已展开目录）——agent 每轮跑完 / 切目录 / 多标签 SSE 广播全部自动覆盖。
 * - 根请求显式传 `liveCwd`（不用 `path` 缺省）：listing 虽是绝对路径的纯函数，
 *   但根与"core 当前 cwd"是两个概念，并发切换时不能依赖服务端时序。
 * - 展开 = 现拉（新鲜优先，不缓存）：每次展开都发一次 `listDirs(dir, {includeFiles:true})`；
 *   收起 = 丢弃子树状态。请求竞态用 picker 同款序号守卫，key 按请求身份命名空间化
 *   （根 = `root:<cwd>`，子 = 目录绝对路径），晚到旧响应直接丢弃。
 *
 * ## 交互边界（D1）
 *
 * 目录行是 button（展开/收起；加载失败时点击 = 原地重试）；文件行是**纯展示 div**
 * （无 button 语义、无 hover 反馈）——「看着能点但没动作」是本项目明令禁止的哑交互，
 * 文件的打开/引用语义留后续批次。
 */

/** 单个已展开目录的子级状态（含加载失败——失败不收起，点击重试） */
interface DirChildren {
  status: "loading" | "ready" | "error";
  error?: string;
  entries: DirEntryResult[];
  truncated: boolean;
}

/** 根目录（= liveCwd）的列表状态；null = 尚未发过请求 */
interface RootListing {
  status: "loading" | "ready" | "error";
  error?: string;
  entries: DirEntryResult[];
  truncated: boolean;
}

/** 扁平渲染行：树在视觉上是缩进列表，DOM 也是扁平的（testid 序 = 可见序，§4.0） */
type TreeRow =
  | { type: "entry"; entry: DirEntryResult; depth: number }
  | { type: "status"; kind: "loading" | "error" | "empty" | "truncated"; depth: number; message?: string };

/** 根的守卫 key：cwd 内嵌——切换瞬间的在途旧根响应与新根同 key 概率为零，天然不互踩 */
const rootSeqKey = (cwd: string) => `root:${cwd}`;

export function WorkingDirFileTree() {
  const liveCwd = useChatStore((state) => state.liveCwd);
  const fsVersion = useChatStore((state) => state.fsVersion);

  const [root, setRoot] = useState<RootListing | null>(null);
  const [expanded, setExpandedState] = useState<Record<string, DirChildren>>({});
  /** expanded 的同步镜像：effect / 回调里要读"当前展开集"而不把它列进依赖 */
  const expandedRef = useRef<Record<string, DirChildren>>({});

  /** 每个请求身份（根/各目录）独立序号：只认最后一次，晚到的旧响应丢弃（picker 同款） */
  const seqRef = useRef(new Map<string, number>());

  const applyExpanded = useCallback((next: Record<string, DirChildren>) => {
    expandedRef.current = next;
    setExpandedState(next);
  }, []);

  const fetchChildren = useCallback(
    async (dirPath: string) => {
      const transport = getLiveTransport();
      if (!transport) return;
      const seq = (seqRef.current.get(dirPath) ?? 0) + 1;
      seqRef.current.set(dirPath, seq);
      applyExpanded({
        ...expandedRef.current,
        [dirPath]: { status: "loading", entries: [], truncated: false },
      });
      try {
        const r = await transport.listDirs(dirPath, { includeFiles: true });
        if (seqRef.current.get(dirPath) !== seq) return;
        // 请求期间被收起/被 cwd 重置 ⇒ 丢弃（内容是对的，但那刻用户已经不要它了）
        if (!expandedRef.current[dirPath]) return;
        applyExpanded({
          ...expandedRef.current,
          [dirPath]: { status: "ready", entries: r.entries, truncated: r.truncated },
        });
      } catch (e) {
        if (seqRef.current.get(dirPath) !== seq) return;
        if (!expandedRef.current[dirPath]) return;
        applyExpanded({
          ...expandedRef.current,
          [dirPath]: {
            status: "error",
            error: e instanceof Error ? e.message : String(e),
            entries: [],
            truncated: false,
          },
        });
      }
    },
    [applyExpanded],
  );

  const fetchRoot = useCallback(
    async (cwd: string) => {
      const transport = getLiveTransport();
      if (!transport) return;
      const key = rootSeqKey(cwd);
      const seq = (seqRef.current.get(key) ?? 0) + 1;
      seqRef.current.set(key, seq);
      setRoot({ status: "loading", entries: [], truncated: false });
      try {
        const r = await transport.listDirs(cwd, { includeFiles: true });
        if (seqRef.current.get(key) !== seq) return;
        setRoot({ status: "ready", entries: r.entries, truncated: r.truncated });
      } catch (e) {
        if (seqRef.current.get(key) !== seq) return;
        setRoot({
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          entries: [],
          truncated: false,
        });
      }
    },
    [],
  );

  /*
   * 单一 effect 承接两条刷新通道（D3/D7），按"本次提交里谁变了"分派：
   * - cwd 变（含启动 null→值）：清空展开集 + 重拉根（seenFs 同步推进，防同一次
   *   refreshSessions 的双变化触发两轮请求）；
   * - 仅 fsVersion 变（agent 跑完 / SSE 广播 / 流式完成）：保持展开集，
   *   重拉根 + 各已展开目录。
   * expandedRef 镜像让这里不必把 expanded 列进依赖（守卫挡住其它重跑）。
   */
  const cwdRef = useRef<string | null>(null);
  const seenFsRef = useRef(0);
  useEffect(() => {
    if (!liveCwd) return;
    if (cwdRef.current !== liveCwd) {
      cwdRef.current = liveCwd;
      seenFsRef.current = fsVersion;
      applyExpanded({});
      void fetchRoot(liveCwd);
      return;
    }
    if (seenFsRef.current !== fsVersion) {
      seenFsRef.current = fsVersion;
      void fetchRoot(liveCwd);
      for (const dirPath of Object.keys(expandedRef.current)) void fetchChildren(dirPath);
    }
  }, [liveCwd, fsVersion, applyExpanded, fetchRoot, fetchChildren]);

  /** 展开/收起/重试三合一（D7：展开必现拉；D1 相邻：失败态点击 = 原地重试） */
  const toggleDir = useCallback(
    (dirPath: string) => {
      const current = expandedRef.current[dirPath];
      if (current && current.status === "error") {
        void fetchChildren(dirPath);
        return;
      }
      if (current) {
        const next = { ...expandedRef.current };
        delete next[dirPath];
        applyExpanded(next);
        return;
      }
      void fetchChildren(dirPath);
    },
    [applyExpanded, fetchChildren],
  );

  /*
   * 渲染门槛（hooks 之后才返回 null —— 规则 of hooks；SSR / mock / unavailable 都走这里）。
   * root === null 且 liveCwd 就绪 = 首拉在途，按 loading 行呈现（effect 在 commit 后立刻发出）。
   */
  if (typeof document === "undefined" || !isLiveEnabled() || !liveCwd) return null;

  const rows: TreeRow[] = [];
  if (root?.status === "ready") {
    const walk = (entries: DirEntryResult[], depth: number) => {
      for (const entry of entries) {
        rows.push({ type: "entry", entry, depth });
        if (entry.kind !== "dir") continue;
        const child = expanded[entry.path];
        if (!child) continue;
        if (child.status === "loading") {
          rows.push({ type: "status", kind: "loading", depth: depth + 1 });
        } else if (child.status === "error") {
          rows.push({ type: "status", kind: "error", depth: depth + 1, message: child.error });
        } else if (child.entries.length === 0) {
          rows.push({ type: "status", kind: "empty", depth: depth + 1 });
        } else {
          walk(child.entries, depth + 1);
          if (child.truncated) rows.push({ type: "status", kind: "truncated", depth: depth + 1 });
        }
      }
    };
    walk(root.entries, 0);
    if (root.truncated) rows.push({ type: "status", kind: "truncated", depth: 0 });
  }

  return (
    <div data-testid="sidebar-file-tree" className="flex min-w-0 flex-col gap-0.5 pb-1">
      {root === null || root.status === "loading" ? (
        <StatusRow testId="sidebar-file-tree-loading" depth={0} kind="loading" />
      ) : root.status === "error" ? (
        <StatusRow
          testId="sidebar-file-tree-error"
          depth={0}
          kind="error"
          message={root.error}
        />
      ) : root.entries.length === 0 ? (
        <StatusRow testId="sidebar-file-tree-empty" depth={0} kind="empty" />
      ) : (
        rows.map((row, index) =>
          row.type === "entry" ? (
            <EntryRow
              key={`${row.entry.kind}:${row.entry.path}`}
              entry={row.entry}
              depth={row.depth}
              index={index}
              /* 目录行只要子级状态存在即视作"展开"（loading/error 也算——行下有状态行作上下文） */
              expandedState={row.entry.kind === "dir" ? expanded[row.entry.path] !== undefined : undefined}
              childStatus={row.entry.kind === "dir" ? expanded[row.entry.path]?.status : undefined}
              onToggle={toggleDir}
            />
          ) : (
            <StatusRow
              key={`status:${index}`}
              testId={`sidebar-file-tree-child-${row.kind}`}
              depth={row.depth}
              kind={row.kind}
              message={row.message}
            />
          ),
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 行组件 */

const INDENT_BASE = 8;
const INDENT_STEP = 12;

/** 目录行：真实 button（可点展开/收起/重试）；文件行：纯展示 div（D1，杜绝哑交互） */
function EntryRow({
  entry,
  depth,
  index,
  expandedState,
  childStatus,
  onToggle,
}: {
  entry: DirEntryResult;
  depth: number;
  index: number;
  /** 仅目录行有意义：子级是否处于"展开"视觉态（loading/error 也算展开——行上有下文） */
  expandedState?: boolean;
  /** 仅目录行有意义：子级请求状态（错误行的行内警示） */
  childStatus?: "loading" | "ready" | "error";
  onToggle: (dirPath: string) => void;
}) {
  const isDir = entry.kind === "dir";
  const rowClass = cn(
    "flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 text-left",
    "font-mono text-xs",
  );
  const indentStyle = { paddingLeft: INDENT_BASE + depth * INDENT_STEP };

  if (!isDir) {
    return (
      <div
        data-testid={`sidebar-file-tree-entry-${index}`}
        data-kind="file"
        title={entry.path}
        className={cn(rowClass, "text-text-secondary")}
        style={indentStyle}
      >
        {/* 空档占位：文件没有 chevron，但图标列要与目录行对齐 */}
        <span className="w-3 shrink-0" aria-hidden="true" />
        <Icon icon={File} size={13} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid={`sidebar-file-tree-entry-${index}`}
      data-kind="dir"
      data-expanded={expandedState ? "true" : "false"}
      aria-expanded={expandedState}
      title={entry.path}
      onClick={() => onToggle(entry.path)}
      className={cn(
        rowClass,
        "text-text-secondary transition-colors duration-150 ease-out",
        "hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
        childStatus === "error" && "text-danger hover:text-danger",
      )}
      style={indentStyle}
    >
      <Icon
        icon={ChevronRight}
        size={12}
        className={cn(
          "shrink-0 text-text-tertiary transition-transform duration-150",
          expandedState && "rotate-90",
        )}
      />
      <Icon icon={Folder} size={13} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </button>
  );
}

/** 根级与子级共用的状态行：loading / error / empty / truncated（testid 由调用方给） */
function StatusRow({
  testId,
  depth,
  kind,
  message,
}: {
  testId: string;
  depth: number;
  kind: "loading" | "error" | "empty" | "truncated";
  message?: string;
}) {
  const text =
    kind === "loading"
      ? "正在读取…"
      : kind === "empty"
        ? "此目录下没有内容"
        : kind === "truncated"
          ? "仅显示前 500 项"
          : (message ?? "读取失败");
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 pr-2 text-xs",
        kind === "error" ? "text-danger" : "text-text-tertiary",
      )}
      style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
    >
      {kind === "loading" ? (
        <Icon icon={Loader2} size={12} className="shrink-0 animate-spin" />
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={kind === "error" ? text : undefined}>
        {text}
      </span>
    </div>
  );
}
