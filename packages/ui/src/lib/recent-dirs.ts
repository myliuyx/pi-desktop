/**
 * 「最近目录」本地记录（localStorage 单键 `recent-dirs`）。
 *
 * ## 为什么读取必须全程兜底
 *
 * 项目既有约定是「单键单值最不容易坏，JSON 一旦写坏整块设置会一起回落默认」
 * （见 `store/ui-store.ts:58-64` 的注释）。数组天然需要 JSON，属对该约定的**例外** ——
 * 于是把风险关在这一个文件里：`readRecentDirs()` 任意一步不满足即**回落空数组、绝不抛**。
 * 一份坏 JSON 不能带崩整个 store 初始化（那会让侧栏、主题、开关一起回落）。
 *
 * ## 上限为什么放这里而不是 layout.ts
 *
 * `layout.ts` 是**尺寸/时长**的唯一来源（几何常量）；`MAX_RECENT_DIRS` 与
 * `MAX_PATH_TAIL_CHARS` 是业务口径（留几条、省略留几个字符），不是几何。
 */

export const RECENT_DIRS_STORAGE_KEY = "recent-dirs";

/** 最近目录最多保留几条（去重后） */
export const MAX_RECENT_DIRS = 5;

/** 左侧省略时保留的末尾字符数（超出才截） */
export const MAX_PATH_TAIL_CHARS = 32;

/**
 * 读出最近目录清单。
 *
 * 依次校验：`JSON.parse` 可解析 → `Array.isArray` → 逐项 `typeof === "string"` →
 * `trim()` 非空 → 去重 → 截断 `MAX_RECENT_DIRS`。
 * **任一步不满足即回落**（坏项跳过而不是整份丢弃，坏到根上就是空数组）。
 */
export function readRecentDirs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_DIRS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const dir = item.trim();
      if (!dir || out.includes(dir)) continue;
      out.push(dir);
      if (out.length >= MAX_RECENT_DIRS) break;
    }
    return out;
  } catch {
    // 非法 JSON（如 "{oops"）在这里收口：不抛、不报警，回落空数组
    return [];
  }
}

/** 写入最近目录清单（同样截断到上限；写失败不影响内存态） */
export function writeRecentDirs(dirs: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_DIRS_STORAGE_KEY,
      JSON.stringify(dirs.slice(0, MAX_RECENT_DIRS)),
    );
  } catch {
    /* 配额/隐私模式等：静默保留内存态即可 */
  }
}

/** 把 `dir` 推到头部（去重 + 截断），返回新数组；不改原数组（store 需要新引用触发渲染） */
export function pushRecentDir(dirs: readonly string[], dir: string): string[] {
  const value = dir.trim();
  if (!value) return [...dirs];
  return [value, ...dirs.filter((item) => item !== value)].slice(0, MAX_RECENT_DIRS);
}

/**
 * 左侧省略：超出 `MAX_PATH_TAIL_CHARS` 时保留**末尾 N 字符**、前缀补 `…`。
 *
 * 为什么不用 CSS：`text-overflow: ellipsis` 只支持右侧；而老的
 * `direction: rtl` 技巧会触发**双向文本算法**，把前导 `~` `/` 的重排顺序搞乱
 * （`~/a/b` 可能显示成 `/a/b~`），在路径这种全是标点的串上尤其明显。
 * 改用 JS 截尾后规则完全确定、可断言（验收 C16）。
 *
 * 用 `[...value]` 而不是 `slice`：按**码点**计数，避免把代理对（emoji 等）劈成两半。
 */
export function truncatePathTail(value: string): string {
  const chars = [...value];
  if (chars.length <= MAX_PATH_TAIL_CHARS) return value;
  return `…${chars.slice(chars.length - MAX_PATH_TAIL_CHARS).join("")}`;
}
