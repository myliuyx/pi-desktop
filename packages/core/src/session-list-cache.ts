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
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 块读大小（1MB）：足够吞掉绝大多数行，避免频繁 read 系统调用 */
const READ_BLOCK = 1 << 20;

/**
 * `readFirstUserText` 专用的块读大小（64KB）。
 *
 * 该函数只需首条 user 消息的文本，而首条 user 几乎总在文件最前面。
 * 用 1MB 块每次都要 alloc+解码 1MB（13 条无名会话实测 ~54ms，把清单热态顶到 61–80ms），
 * 改 64KB 后常规只读 64KB；首条 user 很靠后时仍按原渐进循环继续读下一块到 EOF，
 * 语义完全不变。
 */
const FIRST_USER_BLOCK = 1 << 16;

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
 * 判据：常见键序（行首 `{"type":"message",` 等）走**零 parse 快路径**；
 * 以 `{"` 开头但未命中快路径前缀的行做**一次** `parseJson` 再按真实 `type` 分派，
 * 因此**对 JSON 键序不敏感**（`type` 不在行首也能正确计数/取名/读 header）。
 * 可靠性已在 40 个真实会话文件的 2527 条 message 上实测：与真实 parse 出的 type
 * 匹配 / 不匹配 = 0；且真实 Pi 文件所有行均以 `{"type":` 开头（无前导空格）。
 * 真实数据里 message 行占绝大多数，新增 parse 只落在少数非 message / 键序变体行上
 * —— 「不逐行 parse」的性能意图不变。
 */
export function scanSessionFileLight(filePath: string): LightScan | null {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(READ_BLOCK);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  const state = {
    header: null as Record<string, unknown> | null,
    name: null as string | null,
    messageCount: 0,
    hasFirstUser: false,
    lastActivity: 0,
  };

  /**
   * 以下三个 apply* 是「分派后的逻辑」：快路径命中 `{"type":…,` 时零 parse 直达；
   * 键序变体（type 不在行首）先 parse 一次再按真实 type 调到这里。真实 Pi 文件
   * message 行占绝大多数且 type 在首位，新增 parse 只作用于少数非 message /
   * 非常见键序行 —— 「不逐行 parse」的性能意图不变。
   */
  const applyHeader = (e: Record<string, unknown> | null): void => {
    if (!state.header && e) state.header = e;
  };
  const applyMessage = (line: string, parsed: Record<string, unknown> | null): void => {
    state.messageCount++;
    /*
     * role=user 判定（诱饵安全）：快路径先看字面 `"role":"user"` 线索再 parse 确认
     * （toolResult 的工具输出里真实存在该字面串）；兜底路径已 parse，直接看
     * message.role —— 两者都不会把嵌套/诱饵的 role=user 误判为真 user。
     */
    if (!state.hasFirstUser) {
      const e = parsed ?? (line.includes('"role":"user"') ? parseJson(line) : null);
      if (e && (e.message as { role?: unknown } | undefined)?.role === "user") state.hasFirstUser = true;
    }
    // timestamp：兜底路径用 parse 后的字段；快路径用行首窗口正则（免 parse）
    let ts: unknown = parsed?.timestamp;
    if (typeof ts !== "string") {
      const m = /"timestamp":"([^"]+)"/.exec(line.slice(0, 300));
      ts = m ? m[1] : undefined;
    }
    if (typeof ts === "string") {
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t > state.lastActivity) state.lastActivity = t;
    }
  };
  const applySessionInfo = (e: Record<string, unknown> | null): void => {
    if (!e) return;
    const raw = e.name;
    state.name = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  };

  const processLine = (line: string): void => {
    if (!line) return;
    if (line.startsWith('{"type":"session",')) {
      applyHeader(parseJson(line));
    } else if (line.startsWith('{"type":"message",')) {
      applyMessage(line, null);
    } else if (line.startsWith('{"type":"session_info",')) {
      applySessionInfo(parseJson(line));
    } else if (line.startsWith('{"')) {
      // 键序变体：type 不在行首。整行只 parse 一次，再按真实 type 分派。
      const e = parseJson(line);
      if (!e) return;
      if (e.type === "session") applyHeader(e);
      else if (e.type === "message") applyMessage(line, e);
      else if (e.type === "session_info") applySessionInfo(e);
    }
  };

  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      // StringDecoder 会缓冲跨块边界的不完整多字节序列，下一次 write 自动补全
      const chunk = carry + decoder.write(buf.subarray(0, read));
      const lines = chunk.split("\n");
      // 最后一段可能是被块切断的半行，留到下一轮拼接
      carry = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    // 文件末尾未以 \n 终结的最后一行（连同 StringDecoder 缓冲的残余字节）
    const tail = carry + decoder.end();
    if (tail) processLine(tail);
  } finally {
    fs.closeSync(fd);
  }

  const header = state.header;
  if (!header || typeof header.id !== "string") return null;
  const st = fs.statSync(filePath);
  const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  const modified = state.lastActivity > 0 ? state.lastActivity : Number.isFinite(headerTime) ? headerTime : st.mtimeMs;
  return {
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name: state.name,
    messageCount: state.messageCount,
    created: typeof header.timestamp === "string" ? header.timestamp : new Date(st.mtimeMs).toISOString(),
    modified,
    hasFirstUser: state.hasFirstUser,
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
  const buf = Buffer.allocUnsafe(FIRST_USER_BLOCK);
  const decoder = new StringDecoder("utf8");
  let carry = "";

  /** 取一条 message entry 的 user 文本；判 role 与取 content 的单一口径 */
  const textOfMessage = (e: Record<string, unknown> | null): string | null => {
    const message = e?.message as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") return null;
    const text = extractText(message.content).trim();
    return text || null;
  };
  const textOfLine = (line: string): string | null => {
    if (line.startsWith('{"type":"message",')) {
      if (!line.includes('"role":"user"')) return null;
      return textOfMessage(parseJson(line));
    }
    // 键序变体：type 不在行首 —— 解析一次后再判 type=message
    if (line.startsWith('{"')) {
      const e = parseJson(line);
      if (e?.type !== "message") return null;
      return textOfMessage(e);
    }
    return null;
  };

  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      const chunk = carry + decoder.write(buf.subarray(0, read));
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const text = textOfLine(line);
        if (text) return text;
      }
    }
    // 文件末尾未以 \n 终结的最后一行（连同 StringDecoder 缓冲的残余字节）
    const tail = carry + decoder.end();
    return tail ? textOfLine(tail) : null;
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------------------------------------------------------------------
 * 索引层
 * ------------------------------------------------------------------------- */

export const INDEX_VERSION = 1;
export const INDEX_FILENAME = "session-index.json";
/** 写盘 debounce（spec §3.7）：连续对话每轮都触发 refreshSessions，不能每次都写 5MB */
const SAVE_DEBOUNCE_MS = 2000;

/** 索引里的会话元数据（不含 firstMessage —— 见文件头「体积」取舍） */
export interface CacheInfo {
  id: string;
  cwd: string;
  name: string | null;
  messageCount: number;
  created: string;
  modified: number;
  hasFirstUser: boolean;
}
export interface CacheEntry {
  fp: { size: number; mtimeMs: number };
  info: CacheInfo;
}
export interface CacheListing {
  entries: Array<{ path: string; info: CacheInfo }>;
  stats: { files: number; hits: number; misses: number; fromDisk: boolean };
}

/**
 * 从 `sessionDir` 反推目录结构。
 *
 * `sessionDir` = `<agentDir>/sessions/<encoded-cwd>`，故：
 * - `sessionsRoot` = dirname(sessionDir)
 * - `agentDir`     = dirname(sessionsRoot) = dirname(dirname(sessionDir))
 *
 * **不用 `getSessionsDir()`** —— 它没有从 pi 包导出（实测 undefined）；
 * `getAgentDir()` 可用，作为无 sessionDir 时的回落。
 * 注意切 cwd 时 `sessionDir` 变的是末段，`agentDir` 不变 ⇒ 索引文件位置稳定。
 */
export function resolvePaths(sessionDir?: string): { sessionsRoot: string; agentDir: string } {
  if (sessionDir) {
    const sessionsRoot = path.dirname(sessionDir);
    return { sessionsRoot, agentDir: path.dirname(sessionsRoot) };
  }
  const agentDir = getAgentDir();
  return { sessionsRoot: path.join(agentDir, "sessions"), agentDir };
}

export function indexFilePath(sessionDir?: string): string {
  return path.join(resolvePaths(sessionDir).agentDir, INDEX_FILENAME);
}

/** 内部刷新统计（定义在 `declare global` 之前，避免类型引用顺序问题） */
interface RefreshResult {
  files: number;
  hits: number;
  misses: number;
  changed: boolean;
}

/** 进程内热层（跨请求复用）；globalThis 挂载以便测试重置 */
declare global {
  var __piDesktopSessionIndex: Map<string, CacheEntry> | undefined;
  var __piDesktopSessionIndexLoaded: boolean | undefined;
  var __piDesktopSessionIndexInflight: Map<string, Promise<RefreshResult>> | undefined;
}

function getIndex(): Map<string, CacheEntry> {
  if (!globalThis.__piDesktopSessionIndex) globalThis.__piDesktopSessionIndex = new Map();
  return globalThis.__piDesktopSessionIndex;
}

/** 测试缝：清空内存态（保留落盘文件）。同时清模块级写盘节流，避免旧 timer 把已被替换的旧 Map 写到磁盘。 */
export function resetIndexCacheForTests(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saveDirty = false;
  globalThis.__piDesktopSessionIndex = undefined;
  globalThis.__piDesktopSessionIndexLoaded = undefined;
  globalThis.__piDesktopSessionIndexInflight = undefined;
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<CacheEntry>;
  return (
    !!e.fp &&
    typeof e.fp.size === "number" &&
    typeof e.fp.mtimeMs === "number" &&
    !!e.info &&
    typeof e.info.id === "string" &&
    typeof e.info.cwd === "string" &&
    (e.info.name === null || typeof e.info.name === "string") &&
    typeof e.info.messageCount === "number" &&
    typeof e.info.created === "string" &&
    typeof e.info.modified === "number" &&
    typeof e.info.hasFirstUser === "boolean"
  );
}

/**
 * 读落盘索引（每进程只读一次）。
 * 坏文件 / 版本不符 / 条目形状不对 → **静默丢弃并冷重建**（缓存永远不能变成错误来源）。
 */
function loadIndex(sessionDir?: string): Map<string, CacheEntry> {
  const index = getIndex();
  if (globalThis.__piDesktopSessionIndexLoaded) return index;
  globalThis.__piDesktopSessionIndexLoaded = true;
  const file = indexFilePath(sessionDir);
  if (!fs.existsSync(file)) return index;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; entries?: unknown };
    if (parsed.version !== INDEX_VERSION || !parsed.entries || typeof parsed.entries !== "object") return index;
    for (const [k, v] of Object.entries(parsed.entries as Record<string, unknown>)) {
      if (isCacheEntry(v)) index.set(k, v);
    }
  } catch {
    /* 冷重建 */
  }
  return index;
}

/** 原子写：同目录临时文件 + rename（避免半截文件），权限 0600 */
function saveIndex(sessionDir: string | undefined, index: Map<string, CacheEntry>): void {
  const target = indexFilePath(sessionDir);
  const entries: Record<string, CacheEntry> = {};
  for (const [k, v] of index) entries[k] = v;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, entries }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    /* 落盘失败不影响本次返回（内存层仍是权威） */
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------------------------
 * 写盘节流（spec §3.7）
 * ------------------------------------------------------------------------- */

let saveTimer: NodeJS.Timeout | null = null;
let saveDirty = false;

/**
 * 延迟合并写（debounce）：一次变更排一次写，2s 内的连续变更合并成一次。
 *
 * 为什么必须节流：每轮对话结束都会 `refreshSessions()` → 本次索引必有一条 miss
 * （活动会话刚被 append）→ 若每次都写，5MB 索引的全量写本身成为新瓶颈。
 *
 * `unref()` 让定时器不阻止进程退出 —— 最坏丢最后一次更新，下次请求按 `stat`
 * 失配重扫即可，**正确性不受影响**（Pi 的会话文件才是唯一真源）。
 * Map 是按引用捕获的，定时器触发时写的是最新内容。
 */
function scheduleSave(sessionDir: string | undefined, index: Map<string, CacheEntry>): void {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!saveDirty) return;
    saveDirty = false;
    saveIndex(sessionDir, index);
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/** 测试缝：跳过 debounce 立即落盘（生产路径不需要它） */
export function flushIndexSaveForTests(sessionDir: string | undefined): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveDirty = false;
  saveIndex(sessionDir, getIndex());
}

/** 列 sessionsRoot 下所有 *.jsonl（一层子目录 = 一个编码后的 cwd） */
async function enumerateSessionFiles(sessionsRoot: string): Promise<string[]> {
  const out: string[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(sessionsRoot, d.name);
    try {
      for (const f of await fs.promises.readdir(dirPath)) {
        if (f.endsWith(".jsonl")) out.push(path.join(dirPath, f));
      }
    } catch {
      /* 不可读的项目目录：与 Pi 同语义，按不存在跳过 */
    }
  }
  return out;
}

/**
 * 扫描 + 更新索引（同一 `sessionsRoot` 的并发调用共享一次扫描）。
 * 数据落在共享的 index Map 上，返回值是统计与「是否有变更」。
 */
function refreshIndex(sessionDir: string | undefined): Promise<RefreshResult> {
  const { sessionsRoot } = resolvePaths(sessionDir);
  const inflight = (globalThis.__piDesktopSessionIndexInflight ??= new Map());
  const existing = inflight.get(sessionsRoot);
  if (existing) return existing;

  const task = (async (): Promise<RefreshResult> => {
    const fileList = await enumerateSessionFiles(sessionsRoot);
    const index = loadIndex(sessionDir);
    const present = new Set(fileList);
    let changed = false;
    // 清理已消失的文件（stale）
    for (const known of [...index.keys()]) {
      if (!present.has(known)) {
        index.delete(known);
        changed = true;
      }
    }
    let hits = 0;
    let misses = 0;
    await Promise.all(
      fileList.map(async (filePath) => {
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(filePath);
        } catch {
          index.delete(filePath);
          changed = true;
          return;
        }
        const fp = { size: st.size, mtimeMs: st.mtimeMs };
        const cached = index.get(filePath);
        if (cached && cached.fp.size === fp.size && cached.fp.mtimeMs === fp.mtimeMs) {
          hits++;
          return;
        }
        let light: LightScan | null;
        try {
          light = scanSessionFileLight(filePath);
        } catch {
          /* 扫描失败（stat 后被删/chmod、EIO 等）：与相邻 stat 失败同风格降级，
           * 缓存绝不能成为错误来源 */
          index.delete(filePath);
          changed = true;
          misses++;
          return;
        }
        if (!light) {
          index.delete(filePath);
          changed = true;
          return;
        }
        misses++;
        index.set(filePath, { fp, info: { ...light } });
        changed = true;
      }),
    );
    return { files: fileList.length, hits, misses, changed };
  })().finally(() => inflight.delete(sessionsRoot));

  inflight.set(sessionsRoot, task);
  return task;
}

/** 从内存索引筛出当前 ref 的条目（`all=true` 不过滤 cwd），按 modified 降序 */
function selectEntries(sessionDir: string | undefined, cwd: string, all: boolean): Array<{ path: string; info: CacheInfo }> {
  const index = loadIndex(sessionDir);
  const resolved = path.resolve(cwd);
  const out: Array<{ path: string; info: CacheInfo }> = [];
  for (const [filePath, entry] of index) {
    if (!all) {
      const ecwd = entry.info.cwd;
      if (!ecwd || path.resolve(ecwd) !== resolved) continue;
    }
    out.push({ path: filePath, info: entry.info });
  }
  out.sort((a, b) => b.info.modified - a.info.modified);
  return out;
}

/**
 * 会话清单（缓存版）—— `sessions.ts` 的 `listSessions()` 唯一入口。
 *
 * 与 Pi 的 `SessionManager.list(cwd, sessionDir)` 语义对齐：
 * - `all=false`（默认）只含 `info.cwd` 匹配 `cwd` 的会话；
 * - `all=true` 不过滤（跨项目目录）。
 * 两者共用同一份索引与同一次扫描。
 */
export async function listSessionsCached(
  ref: { cwd: string; sessionDir?: string },
  options: { all?: boolean } = {},
): Promise<CacheListing> {
  // fromDisk：本次调用前热层尚未加载、且落盘索引存在 ⇒ 首拉命中的是冷底
  const fromDisk = globalThis.__piDesktopSessionIndexLoaded !== true && fs.existsSync(indexFilePath(ref.sessionDir));
  const stats = await refreshIndex(ref.sessionDir);
  const entries = selectEntries(ref.sessionDir, ref.cwd, options.all === true);
  if (stats.changed) scheduleSave(ref.sessionDir, getIndex());
  return {
    entries,
    stats: { files: stats.files, hits: stats.hits, misses: stats.misses, fromDisk },
  };
}