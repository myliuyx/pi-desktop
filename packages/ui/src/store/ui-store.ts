import { create } from "zustand";
import {
  DEFAULT_ENABLED_TOOLS,
  type ToolName,
} from "@/mock/skills";
import {
  DEFAULT_SESSION_SWITCHES,
  DEFAULT_WORKING_DIR,
  type SessionSwitchField,
} from "@/mock/settings";
import type { ThinkingLevel } from "@/mock/types";
import {
  COMPOSER_MODELS,
  COMPOSER_THINKING_LEVELS,
  INITIAL_MODEL_INDEX,
  INITIAL_THINKING_INDEX,
} from "@/mock/composer";
import {
  INITIAL_MODEL_PROVIDERS,
  type ModelProviderConfig,
} from "@/mock/model-config";
import {
  pushRecentDir,
  readRecentDirs,
  writeRecentDirs,
} from "@/lib/recent-dirs";

export type Theme = "light" | "dark";
export type ThemeSource = "user" | "system";
/** 预览区激活的 Tab（M3）：效果态 / 源码态 */
export type PreviewTab = "effect" | "code";

const THEME_STORAGE_KEY = "theme";
const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";
const PREVIEW_STORAGE_KEY = "preview-collapsed";
const PREVIEW_TAB_STORAGE_KEY = "preview-tab";
/** 04 屏工具开关：按工具名逐个存 key，避免整块 JSON 的解析失败面 */
const TOOL_STORAGE_PREFIX = "tool-enabled:";
/** 05 屏会话开关：同样逐个存 key */
const SESSION_SWITCH_STORAGE_PREFIX = "setting:";
/** 05 屏工作目录 */
const WORKING_DIR_STORAGE_KEY = "working-dir";

function readStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

/** 折叠状态存 "0" / "1"：与主题同理，缺省即展开 */
function readStoredFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(key) === "1";
}

/** 预览 Tab 存字面值：与 readStoredTheme 同理，非法值一律视为缺省 */
function readStoredPreviewTab(): PreviewTab | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(PREVIEW_TAB_STORAGE_KEY);
  return stored === "effect" || stored === "code" ? stored : null;
}

/**
 * 布尔开关的读取（M4）：与 `readStoredFlag` 的 "0"/"1" 编码一致，
 * 但**缺省值可指定** —— 工具开关与设置开关的默认是 true，不能沿用「缺省即 false」。
 *
 * 为什么复用同一套编码而不是另立 JSON：单键单值最不容易坏，
 * 解析失败面为零（JSON 一旦写坏，整块设置会一起回落默认，连锁影响大）。
 */
function readStoredSwitch(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return fallback;
}

/** 04 屏工具开关的持久化 key */
function toolStorageKey(name: ToolName): string {
  return `${TOOL_STORAGE_PREFIX}${name}`;
}

/** 05 屏会话开关的持久化 key */
function sessionSwitchStorageKey(field: SessionSwitchField): string {
  return `${SESSION_SWITCH_STORAGE_PREFIX}${field}`;
}

/** 一次性读出全部工具开关状态（store 初始化与 initTheme 共用） */
function readEnabledTools(): Record<ToolName, boolean> {
  const result = {} as Record<ToolName, boolean>;
  for (const name of Object.keys(DEFAULT_ENABLED_TOOLS) as ToolName[]) {
    result[name] = readStoredSwitch(toolStorageKey(name), DEFAULT_ENABLED_TOOLS[name]);
  }
  return result;
}

/** 一次性读出全部会话开关状态 */
function readSessionSwitches(): Record<SessionSwitchField, boolean> {
  const result = {} as Record<SessionSwitchField, boolean>;
  for (const field of Object.keys(DEFAULT_SESSION_SWITCHES) as SessionSwitchField[]) {
    result[field] = readStoredSwitch(sessionSwitchStorageKey(field), DEFAULT_SESSION_SWITCHES[field]);
  }
  return result;
}

/** 工作目录：空串视为缺省（清空 localStorage 后应回落默认路径） */
function readStoredWorkingDir(): string {
  if (typeof window === "undefined") return DEFAULT_WORKING_DIR;
  const stored = window.localStorage.getItem(WORKING_DIR_STORAGE_KEY);
  return stored && stored.trim().length > 0 ? stored : DEFAULT_WORKING_DIR;
}

function readSystemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

interface UiState {
  theme: Theme;
  /** user = 用户显式选择（持久化）；system = 跟随系统（不持久化） */
  themeSource: ThemeSource;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /**
   * 同步系统主题（**无参签名保持不变**）：仅在 `themeSource === "system"` 时生效。
   *
   * ⚠️ 为什么不能给它加 `force` 可选参数：`TokensScreen`（M0 产物）里有一处
   * `onClick={syncSystemTheme}` 直接把本函数当事件处理器传。加参数后
   * `(force?: boolean) => void` 与 `MouseEventHandler` 不兼容，**改这个签名等于
   * 要改 00 屏**，而 M4 的范围明令不动 00 屏。见下方 `useSystemTheme`。
   */
  syncSystemTheme: () => void;
  /**
   * 「切回跟随系统」（M4 新增，与 syncSystemTheme 并存而不是替换）：
   * 清掉 user 标记与持久化值，无条件按系统偏好重新应用。
   *
   * 为什么需要它：05 屏外观分组有三段。用户先选了深色（themeSource 变 "user"），
   * 再点「跟随系统」时，`syncSystemTheme()` 会因 source==="user" 直接 return ——
   * 表现为**点了没反应**。新增一个语义明确的方法比给既有方法加参数安全：
   * 不改签名就不会波及 00 屏那处 onClick。
   */
  useSystemTheme: () => void;

  /** 左侧栏折叠（验收 1-9 / 1-11）。折叠用宽度过渡实现，不走 display:none */
  sidebarCollapsed: boolean;
  /** 右侧预览区折叠 */
  previewCollapsed: boolean;
  toggleSidebar: () => void;
  togglePreview: () => void;

  /** 预览区激活 Tab（验收 3-1 / 3-4）。localStorage 持久化，?preview= 参数可覆盖 */
  previewTab: PreviewTab;
  setPreviewTab: (tab: PreviewTab) => void;

  /* -------------------------------------------------------------------------
   * 设置弹窗（第一批，D1）
   *
   * 设置从「05 屏路由」改为「全局 Dialog」，任意屏都能弹出。
   * `settingsOpen` 是唯一的开放真相，侧边栏底部按钮 / 标题栏按钮都只调
   * `setSettingsOpen(true)`（R5 教训：按钮语义是公共 API，改语义先 grep 消费方）。
   * ------------------------------------------------------------------------- */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  /* -------------------------------------------------------------------------
   * 模型管理（第一批 mock，D2）
   *
   * 弹窗里编辑的是「草稿」，只有点「保存」才提交到这里（`saveModelProviders`），
   * 「取消」丢弃（草稿在 SettingsDialog 内本地持有，关闭即回落本 store 的提交值）。
   * 第一批不接 core，初始值来自 `mock/model-config.ts`；类型也只活在那个文件，
   * 不污染 M2 冻结契约 `mock/types.ts`。
   * ------------------------------------------------------------------------- */
  modelProviders: ModelProviderConfig[];
  saveModelProviders: (providers: ModelProviderConfig[]) => void;

  /* -------------------------------------------------------------------------
   * M4 · 04 屏工具开关（验收 4-3）
   *
   * 为什么进 store 而不是组件内 useState：开关的语义是「这个能力全局是否可用」，
   * 别的屏（如 03 屏的回放、将来接 Pi 时的工具装配）也要读同一个真相。
   * 进 store 就必须同时做 localStorage 持久化 —— 否则刷新后开关回到默认，
   * 而 UI 又声称它是"设置项"，属于自相矛盾（见 task-M4.md 4.2 ②）。
   * ------------------------------------------------------------------------- */
  enabledTools: Record<ToolName, boolean>;
  toggleTool: (name: ToolName) => void;

  /* -------------------------------------------------------------------------
   * M4 · 05 屏设置字段（验收 4-5 / 4-6）
   * ------------------------------------------------------------------------- */

  /** 当前模型 id（对齐 Pi 的 AgentOptions.model），取值来自 COMPOSER_MODELS */
  modelId: string;
  setModelId: (id: string) => void;

  /** 思考强度档位（对齐 Pi 的 set_thinking_level），取值来自 COMPOSER_THINKING_LEVELS */
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;

  /** 会话开关（对齐 Pi 的 SettingsManager.autoCompact / autoRetry） */
  sessionSwitches: Record<SessionSwitchField, boolean>;
  toggleSessionSwitch: (field: SessionSwitchField) => void;

  /** 工作目录（对齐 Pi 的 AgentOptions.cwd） */
  workingDir: string;
  /**
   * 记录/切换偏好工作目录。
   *
   * 语义（2026-09-24 扩）：写 `working-dir` → 把 `dir` **推到 `recentDirs` 头部**
   * （去重、截 `MAX_RECENT_DIRS`）→ 写 `recent-dirs` → `set`。
   *
   * ⚠️ 它**只表达偏好**：live 形态下侧栏显示的是 core 的真实 cwd（只读，见 chat-store 的
   * `liveCwd`），这里的改动只保证「下次用这个目录启动 core」，**不会热切当前会话目录**。
   */
  setWorkingDir: (dir: string) => void;

  /**
   * 最近使用过的工作目录（最新在前，最多 `MAX_RECENT_DIRS` 条）。
   * 读取全程兜底回落空数组（见 `lib/recent-dirs.ts`）—— 一份坏 JSON 不能带崩 store 初始化。
   */
  recentDirs: string[];
}

function persistFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value ? "1" : "0");
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStoredTheme() ?? readSystemTheme(),
  themeSource: readStoredTheme() ? "user" : "system",

  setTheme: (theme) => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    set({ theme, themeSource: "user" });
  },

  toggleTheme: () => {
    get().setTheme(get().theme === "dark" ? "light" : "dark");
  },

  syncSystemTheme: () => {
    if (get().themeSource === "user") return;
    const theme = readSystemTheme();
    applyTheme(theme);
    set({ theme });
  },

  /**
   * 切回「跟随系统」。与 syncSystemTheme 的区别只有一条：**不因 user 标记而提前返回**，
   * 并顺带清掉持久化值（清掉才算真的「不再用用户选择」）。
   */
  useSystemTheme: () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
    const theme = readSystemTheme();
    applyTheme(theme);
    set({ theme, themeSource: "system" });
  },

  sidebarCollapsed: readStoredFlag(SIDEBAR_STORAGE_KEY),
  previewCollapsed: readStoredFlag(PREVIEW_STORAGE_KEY),

  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed;
    persistFlag(SIDEBAR_STORAGE_KEY, sidebarCollapsed);
    set({ sidebarCollapsed });
  },

  togglePreview: () => {
    const previewCollapsed = !get().previewCollapsed;
    persistFlag(PREVIEW_STORAGE_KEY, previewCollapsed);
    set({ previewCollapsed });
  },

  previewTab: readStoredPreviewTab() ?? "effect",

  setPreviewTab: (tab) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PREVIEW_TAB_STORAGE_KEY, tab);
    }
    set({ previewTab: tab });
  },

  /* --------------------------------------------------- 设置弹窗 / 模型配置 */
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  modelProviders: INITIAL_MODEL_PROVIDERS,
  saveModelProviders: (providers) => set({ modelProviders: providers }),

  /* ---------------------------------------------------------------- M4 段 */

  enabledTools: readEnabledTools(),

  toggleTool: (name) => {
    const enabled = !get().enabledTools[name];
    persistFlag(toolStorageKey(name), enabled);
    set((state) => ({ enabledTools: { ...state.enabledTools, [name]: enabled } }));
  },

  modelId: COMPOSER_MODELS[INITIAL_MODEL_INDEX].id,

  setModelId: (id) => set({ modelId: id }),

  thinkingLevel: COMPOSER_THINKING_LEVELS[INITIAL_THINKING_INDEX],

  setThinkingLevel: (level) => set({ thinkingLevel: level }),

  sessionSwitches: readSessionSwitches(),

  toggleSessionSwitch: (field) => {
    const value = !get().sessionSwitches[field];
    persistFlag(sessionSwitchStorageKey(field), value);
    set((state) => ({ sessionSwitches: { ...state.sessionSwitches, [field]: value } }));
  },

  workingDir: readStoredWorkingDir(),

  setWorkingDir: (dir) => {
    const recentDirs = pushRecentDir(get().recentDirs, dir);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(WORKING_DIR_STORAGE_KEY, dir);
      } catch {
        /* 配额/隐私模式等：写失败不能带崩内存态（否则本次选择连带 recentDirs 一起丢） */
      }
    }
    writeRecentDirs(recentDirs);
    set({ workingDir: dir, recentDirs });
  },

  recentDirs: readRecentDirs(),
}));

let initialized = false;

/**
 * 必须在 React 渲染前调用：
 * 1. localStorage 有值 → 用它
 * 2. 否则跟随 prefers-color-scheme
 * 3. 写入 <html data-theme>
 *
 * 折叠状态、预览 Tab、工具开关与设置字段在此一并读入（store 初始化时已读过一次，
 * 这里只是保持"首帧前确定"的写法一致）。
 */
export function initTheme(): void {
  if (initialized) return;
  initialized = true;

  const stored = readStoredTheme();
  const theme = stored ?? readSystemTheme();
  applyTheme(theme);
  useUiStore.setState({
    theme,
    themeSource: stored ? "user" : "system",
    sidebarCollapsed: readStoredFlag(SIDEBAR_STORAGE_KEY),
    previewCollapsed: readStoredFlag(PREVIEW_STORAGE_KEY),
    previewTab: readStoredPreviewTab() ?? "effect",
    // M4：工具开关 / 设置字段同样在首帧前确定，避免"先渲染默认值再跳变"
    enabledTools: readEnabledTools(),
    sessionSwitches: readSessionSwitches(),
    workingDir: readStoredWorkingDir(),
    // 最近目录同属「首帧前确定」：否则侧栏首帧会先画空菜单再跳出入选项
    recentDirs: readRecentDirs(),
  });

  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => useUiStore.getState().syncSystemTheme());
}
