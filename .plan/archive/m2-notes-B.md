# M2 交接说明 · Agent B（输入区与统计）

> 日期：2026-09-22
> 执行方：Agent B
> 负责文件（按 9.2）：`src/components/chat/Composer.tsx`、`src/components/chat/ComposerToolbar.tsx`、
> `src/components/common/TokenStats.tsx`（新建）、`src/mock/composer.ts`（新建）、`src/lib/composer-layout.ts`（新建）
> dev server 端口：5181 · Chrome 调试端口：**9336**（见「偏离规格之处」）

---

## ⚠️ 主控更正（2026-09-22，写在最前面，避免后续会话被误导）

**本文第 5 节第 1 条「`cdp.mjs` 缺 `--remote-allow-origins=*` 导致 Page.enable 挂起」这个根因判断是错的。**

真实原因是主控写 `scripts/cdp.mjs` 时，`Cdp` 构造函数里**漏了 `ws.addEventListener("message", ...)`** ——
WebSocket 能连上、命令能发出、Chrome 也会回，但没有任何人处理返回值，因此每条 CDP 命令必然等到超时。

判定过程：主控按本文建议补上该 flag 后**问题依旧**；随后用最小诊断脚本（同样参数、换端口）
验证「Chrome 确实会回 `{"id":1,"result":{}}`」，才定位到是监听器缺失。**该 flag 已保留**（无害且更稳），
并新增了 8 秒连通性自检把这类失效变成可操作的报错。

**留档意义**：本文其余部分（验收证据、反例验证、未实测项）经复核**均属实**，未受影响；
但"补个参数就好了"这类低成本结论，主控当时未经验证就照做了，白跑一轮 —— 这个流程教训已写入
[`progress-M2.md`](./progress-M2.md) 第 5.3 节。

---

## 1. 逐任务状态表（属于 B 的任务）

| 任务 | 产出文件 | 状态 |
|---|---|---|
| 2.10 | `Composer.tsx` | ✅ 完成 |
| 2.11 | `ComposerToolbar.tsx` | ✅ 完成 |
| 2.12 | `TokenStats.tsx` | ✅ 完成 |
| 2.13 | `mock/composer.ts` | ✅ 完成 |

辅助文件 `src/lib/composer-layout.ts` 仅在确实需要 B 侧常量时新建（见第 4 节）。

---

## 2. 负责的验收项 · 逐条实测证据

> 全部由 `scripts/accept-b.mjs` 驱动**真实系统 Chrome**（端口 9336）量取，断言见 `packages/ui/_evidence-b.json`，
> 汇总 **11/11 通过**。下框为浏览器内实测结论，非目测。

| 验收项 | 实测方法 | 实测结论 |
|---|---|---|
| **2-9** 发送按钮在输入框内部右下角 | `composer.contains(send)`；量两矩形 rect，判定 send 完全落入 composer 且左/上边界落在右 40%/下 60% 区；空内容时 `disabled` | 全 true。DOM 是子孙、水平/垂直完全在框内、位于右下角区、空内容禁用，均通过 |
| **2-10** 发送按钮规格 | 量 w/h；`borderTopLeftRadius`≥13.5 判正圆；注入 `bg-accent-soft`/`border-accent` 探针比对 `getComputedStyle` | w=28、h=28、正圆、底=`--accent-soft`、描边=`--accent`、箭头 stroke=`--accent`，全 true |
| **2-11** 工具条顺序 | 读 `composer-toolbar` 直接子节点的 `data-testid` 序列 | `model → thinking → mcp → spacer → token-stats`，完全匹配 |
| **2-12** 工具条芯片高 32 | 量三个芯片 `getBoundingClientRect().height` | 三个均 =32（Chip 即 `h-8`），全 true |
| **2-13** TokenStats 四段+分隔符 | 查四个 `token-stats-item-*` 与 `token-stats-divider` 是否存在 | 四段均存在、段间分隔线存在、根容器存在，全 true |
| **2-14** 格式化 | 读每段 `lastElementChild.textContent` | 输入=`12.4k`、输出=`6.2k`、消耗=`18.6k`、上下文=`128k`（**非 128.0k**），全 true |
| **2-15** 「消耗」高亮 | 注入 `text-text-primary`/`text-text-secondary` 探针，比对各段 `getComputedStyle().color` | 仅 total 段 = primary 探针；input/output/context = secondary 探针，全 true |
| **2-16** TokenStats 靠右 | 读 spacer 的 `flexGrow`；比对 `token-stats` 右缘与 `composer-toolbar` 右缘 | spacer `flexGrow≥1`（占满剩余）、`token-stats` 右缘贴工具条右边（差 ≤4px），全 true |
| **2-17** 输入框多行自适应 | 用 `SET_TEXT_HELPER` 写 1 行 / 10 行，分别量 `composer` 高度 | 多行高度 > 单行高度 +20、多行 ≤202（上限 200 容差）、单行 >0，全 true |
| **2-18（输入区部分）** 长文本不破版 | textarea 灌入 120+ 字符超长不可断串，查 `body.scrollWidth<=clientWidth` 与 composer 右缘 ≤ 视口宽 | 页面无横向溢出、输入框不超出视口，全 true |

> 2-18 的消息体部分（超长 hash 在 Markdown 渲染中的不破版）归 Agent A（2-18 主项），B 仅负责输入区部分并已实测。

---

## 3. 反例验证（喂坏数据应判 false）

针对判定类属性「消耗段高亮」，故意构造错期望 **「非消耗段也应是 text-text-primary」**，正确实现必须判 false（否则该断言无意义）：

- `2-15_反例_非消耗段不应为primary`：断言 `input/output/context` 的 `color !== text-text-primary` 探针值。
- 实测三项均为 true（即它们确实不是 primary），说明高亮逻辑只命中 total，反例成立。

（这正呼应 M1 的教训：一个永远通过的断言等于没有断言。）

---

## 4. 新增常量

仅一处，放在 B 侧领域文件，未改动共享的 `src/lib/layout.ts`：

`src/lib/composer-layout.ts`
- `COMPOSER_INPUT_TRAILING_SPACE = SEND_BUTTON_SIZE + COMPOSER_SEND_INSET`（= 28 + 8 = **36**）
  - 用途：textarea 右侧/底部预留出发送按钮占用的空间，避免文字被内嵌按钮压住（验收 2-9 要求按钮落在边框内侧）。
  - 之所以单列：它从 `layout.ts` 的冻结常量派生，属于「输入区」专属布局，按 5.2 放进 B 自己的文件，待主控收尾时决定是否归并。

其余尺寸（`COMPOSER_MIN_HEIGHT`/`COMPOSER_MAX_HEIGHT`/`COMPOSER_PADDING`/`COMPOSER_SEND_INSET`/`SEND_BUTTON_SIZE`/`TOOLBAR_CONTROL_HEIGHT`）均直接复用 `layout.ts`，未新增。

---

## 5. 偏离规格之处

1. **验收脚本用的 Chrome 调试端口是 9336，不是规格建议的 9335。**
   原因：首次按规格用 9335 起 Chrome 后，`Page.enable` 一直超时（CDP timeout）。排查发现本沙箱里 `scripts/cdp.mjs` 的 Chrome 启动参数缺 `--remote-allow-origins=*`，
   Node 的 WebSocket 虽能握手但后续 CDP 命令挂起。为「真跑」，我在**自己的验收脚本里内置了一份等价的最小 CDP 驱动**（仅验证用，**未改动冻结的 cdp.mjs**）并补上该 flag；
   同时改用 9336 以免挂到疑似僵尸 Chrome 实例上（A 用 9334，仍不冲突）。
   **这是验证工具层面的偏差，不是产品代码偏差。** 建议主控在 `cdp.mjs` 的 spawn 参数里补 `--remote-allow-origins=*`，A 的验收脚本也会受益。

2. 产品代码（`Composer`/`ComposerToolbar`/`TokenStats`/`mock/composer.ts`）**严格按规格实现，无任何行为偏离**。

---

## 6. 遗留问题 / 未实测项（如实列出）

- **深色模式下未自动切换实测**：本次验收运行在默认（浅色）主题。深色下的色值正确性依赖 `tokens.css` 已校准的令牌派生（箭头=`--accent`、底=`--accent-soft`、消耗段=`--text-primary` 等随 `[data-theme="dark"]` 自动换值），逻辑层无需为深色写任何分支，故未单独在深色下重跑断言。若需显式证据，可在脚本里先切 `document.documentElement.dataset.theme='dark'` 再测一次——**未实测**。
- **M1 的 13 条回归未由 B 重跑**：属主控收尾职责（规格 5.5）。B 未触碰任何 M1 文件（TitleBar/Sidebar/WindowShell/TokensScreen 等），理论上不影响；但「未实测」。
- **`scripts/cdp.mjs` 缺 `--remote-allow-origins=*`**：见第 5 节，属待主控处理项（B 无权改冻结文件）。
- 验收脚本 `scripts/accept-b.mjs` 与 `_evidence-b.json`、`_accept_b.txt`、`_chk.txt` 等临时产物留在 `packages/ui` 下，可清理（不影响构建）。
  → **主控已清理（2026-09-22）**：`accept-b.mjs` 与 `_evidence-b.json` 已删除，
  因为其能力已被 `scripts/m2-acceptance.mjs` + `scripts/cdp.mjs` 完全覆盖，
  留一份重复的 CDP 驱动只会造成「两份都要维护」的隐患。本文第 2 节的实测结论仍作为过程留档有效。
