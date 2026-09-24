/**
 * 契约镜像齐平检查 —— `npm run check:contract`（纯文本解析，不需要浏览器、不需要 core）。
 *
 * 背景（2026-09-24 review）：`packages/core/src/contract.ts` 是**权威契约源**，
 * 而「设置页 Provider/模型」这一组类型在 `packages/ui/src/mock/provider-contract.ts`
 * 有一份**手抄镜像**（UI 侧另有 `mock/types.ts` re-export 事件/展示面契约，不走镜像）。
 * 手抄的代价是「改了源、忘了镜像」—— 上一批加 `ProviderModelsRequest/Result` 与
 * `providerLabel` 时就同时要改 4 个地方，全靠人记得。本探针把这条纪律变成可执行的断言。
 *
 * 判据（双向）：
 *   1. 镜像里每个 `export interface` 都必须在 core 契约里**存在**（改了名就得同步）；
 *   2. 同名类型在两边的**字段名集合必须完全一致**（core 缺 = 忘抄；mirror 多 = 抄了不存在的）；
 *   3. 解析必须「无遗留行」—— 每个类型体内、缩进为 1 层的非注释行都必须能被解析成一个字段。
 *      这条是**防止解析器悄悄失灵**（新写法解析不了却报全绿，正是本项目的头号教训）。
 *
 * ⚠️ 刻意**不做**的事：不比较字段的**类型签名与可选性**（`name?: string` vs `name: string`）。
 * 文本比较类型是自找假红（空格、联合顺序、注释都会变），而真正的风险是「字段有没有」——
 * 可选性由两侧各自的注释与 `tsc` 兜（core 与 UI 都编译不过时自然会暴露）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
/* 两个路径可用命令行参数覆盖（自查探针本身是否真的会红时用得上：拿临时副本跑） */
const CORE_FILE = path.resolve(
  process.argv[2] ?? path.join(repoRoot, "packages", "core", "src", "contract.ts"),
);
const MIRROR_FILE = path.resolve(
  process.argv[3] ?? path.join(repoRoot, "packages", "ui", "src", "mock", "provider-contract.ts"),
);

/* ---------------------------------------------------------------------------
 * 解析：提取 `export interface X { ... }` 的**一级字段名**
 * ------------------------------------------------------------------------- */

const isCommentLine = (t) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
const FIELD_RE = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/;

/**
 * 返回 `Map<类型名, { fields: string[], lineNo: number, leftover: string[] }>`。
 *
 * 逐行推进 `{}` 深度：**声明行之后、深度恰为 1 的行**才是字段行；
 * 注释行整行跳过（含块注释的每一行，它们都以 `*` 开头），
 * 于是 JSDoc 里的中文括号/花括号不会干扰深度计数。
 */
function extractInterfaces(source) {
  const lines = source.split(/\r?\n/);
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const decl = /^export\s+interface\s+([A-Za-z_$][\w$]*)\s*\{/.exec(lines[i]);
    if (!decl) continue;

    const name = decl[1];
    const fields = [];
    const leftover = [];
    let depth = 0;
    let closed = false;

    for (let j = i; j < lines.length; j++) {
      const raw = lines[j];
      const t = raw.trim();
      if (isCommentLine(t)) continue;
      // 空行不参与深度与字段判断（接口体内常见空行分隔）
      if (!t) continue;

      const depthBefore = depth;
      for (const ch of raw) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }

      if (j > i && depthBefore === 1) {
        // 纯闭合行（`}` / `};`）是类型体结束标记，不是「解析不了的字段」
        if (/^[}\s;]*$/.test(t)) {
          /* 跳过：下一行的 depth 判断会退出循环 */
        } else {
          const m = FIELD_RE.exec(t);
          if (m) fields.push(m[1]);
          else leftover.push(`L${j + 1}: ${t}`);
        }
      }
      if (depth === 0) {
        closed = true;
        break;
      }
    }
    found.set(name, { fields, leftover, lineNo: i + 1, closed });
  }
  return found;
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  ✗ ${msg}`);
};

for (const f of [CORE_FILE, MIRROR_FILE]) {
  if (!fs.existsSync(f)) {
    console.error(`未找到契约文件：${f}`);
    process.exit(1);
  }
}

const core = extractInterfaces(fs.readFileSync(CORE_FILE, "utf8"));
const mirror = extractInterfaces(fs.readFileSync(MIRROR_FILE, "utf8"));

console.log(`权威源：${path.relative(repoRoot, CORE_FILE)}（解析出 ${core.size} 个 interface）`);
console.log(`镜像文件：${path.relative(repoRoot, MIRROR_FILE)}（解析出 ${mirror.size} 个 interface）\n`);

// 解析器失灵守卫：镜像文件解析不出任何类型 ⇒ 后面的全绿毫无意义
if (mirror.size === 0) {
  console.error("✗ 镜像文件里没解析出任何 interface —— 解析器失效或文件结构变了，拒绝给出结论");
  process.exit(1);
}

for (const [name, m] of mirror) {
  // ③ 解析遗留（防止「新写法解析不了」被当成通过）
  if (!m.closed) fail(`${name}：接口体没解析到闭合（L${m.lineNo} 起），文件结构可能变了`);
  if (m.leftover.length > 0) {
    fail(`${name}：有 ${m.leftover.length} 行无法解析成字段 ——\n      ${m.leftover.join("\n      ")}`);
  }

  // ① 镜像类型必须在 core 里存在
  const c = core.get(name);
  if (!c) {
    fail(`${name}：core 契约里不存在同名 interface（改名了？请同步 ${path.relative(repoRoot, CORE_FILE)}）`);
    continue;
  }

  // ② 双向差集必须为空
  const coreSet = new Set(c.fields);
  const mirrorSet = new Set(m.fields);
  const missingInCore = m.fields.filter((f) => !coreSet.has(f));
  const extraInMirror = c.fields.filter((f) => !mirrorSet.has(f));
  const dupes = m.fields.filter((f, idx) => m.fields.indexOf(f) !== idx);

  if (dupes.length > 0) fail(`${name}：镜像里有重复字段 [${[...new Set(dupes)].join(", ")}]`);
  if (missingInCore.length > 0) {
    fail(`${name}：镜像有而 core 没有 [${missingInCore.join(", ")}]（core 侧忘加？）`);
  }
  if (extraInMirror.length > 0) {
    fail(`${name}：core 有而镜像没有 [${extraInMirror.join(", ")}]（镜像忘同步 —— 多数情况就是这里）`);
  }
  if (missingInCore.length === 0 && extraInMirror.length === 0 && dupes.length === 0) {
    console.log(`  ✓ ${name}：${m.fields.length} 个字段两侧一致`);
  }
}

if (failed > 0) {
  console.error(`\n契约镜像不一致 ${failed} 项 —— 请把 ${path.relative(repoRoot, MIRROR_FILE)}`);
  console.error(`与 ${path.relative(repoRoot, CORE_FILE)} 对齐（core 是权威源）。`);
  process.exit(1);
}
console.log(`\n契约镜像齐平：${mirror.size} 个类型全部一致`);
