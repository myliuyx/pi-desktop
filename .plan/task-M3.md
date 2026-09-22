# M3 执行规格书 · 预览区与深色版

> 派发日期：2026-09-22
> 执行方：general-purpose agent（单人，M3 是单一内聚交付物，不拆并行）
> 配套：[development-plan.md](./development-plan.md) 第三节 M3 · [acceptance-criteria.md](./acceptance-criteria.md) M3 表 · [screens.md](./screens.md) 01b/02 节 · [progress-M2.md](./progress-M2.md)（教训）

---

## 〇、背景与范围

M0 / M1 / M2 已完成并通过验收（32 项断言 + 13 条 M1 回归全绿）。M3 是第四个里程碑：

| # | 任务 | 产出 | 计划工时 |
|---|---|---|---|
| 3.1 | `PreviewPane`：双 Tab（预览效果 / 预览源码） | `shell/PreviewPane.tsx` | 2h |
| 3.2 | 源码态：Shiki 高亮 + 行号 + 复制按钮 | 同上 + `mock/preview.ts` | 2.5h |
| 3.3 | 效果态：`iframe sandbox` 渲染生成的 HTML | 同上 | 2h |
| 3.4 | 02 深色版：全屏换肤走查，修复硬编码与不可读处 | 令牌与组件修正 | 3h |

**范围内**：以上 4 项 + 为此需要的 ui-store / layout.ts / App.tsx 小改动。
**范围外**：不新增任何 npm 依赖（shiki / lucide-react 已在依赖里，够用）；不动 Sidebar、TitleBar、
消息流、Composer；不做 M4 的三屏；不接 Pi；不改 `tokens.css` 的既有令牌值。

**完成判据**（development-plan.md 原文）：01b 屏 Tab 切换正常；源码态深浅模式下高亮都正确；
02 深色版**零 `dark:` 补丁**。

---

## 一、现状与集成点（动手前必读）

1. **占位的 `PreviewPane` 在 `src/components/shell/WorkspaceArea.tsx` 尾部**（约 67–112 行）。
   M3 要把它**搬到** `src/components/shell/PreviewPane.tsx` 并实现双 Tab。
   引用方两处：`components/shell/WorkbenchScreen.tsx`（`<PreviewPane />`）与
   `components/shell/index.ts`（export）。搬完这两处 import 要改。
2. **折叠回归是红线**。`scripts/m1-acceptance.mjs` 直接依赖预览区这些特征，一项都不能丢：
   - `data-testid="preview-pane"`、`data-collapsed` 属性
   - `width` 的 CSS transition（脚本读 `transitionProperty` / `transitionDuration` 并采中间帧）
   - 折叠后宽度严格为 0（`divider-l` 伪元素方案保留，别换回 border）
   - 宽度逻辑：`collapsed ? COLLAPSED_WIDTH : PREVIEW_PANE_WIDTH`（layout.ts 常量）
   - `overflow-hidden`、`min-h-0 min-w-0 shrink-0`、`aria-hidden` 同步
   搬完立刻跑 `npm run accept:m1`（见第五节回归），1-10 / 1-12 / 1-13 必须仍绿。
3. **ui-store**（`src/store/ui-store.ts`）：新增 `previewTab: "effect" | "code"`，
   默认 `"effect"`，localStorage 持久化（key 建议 `"preview-tab"`，仿照现有
   `readStoredFlag` / `persistFlag` 的写法），加 `setPreviewTab`。
   注意 `initTheme()` 里同步恢复该状态，保持"首帧前确定"的既有模式。
4. **App.tsx**：仿照 `?stress=` 的现有模式，加 `?preview=code`（及 `?preview=effect`）URL 参数：
   存在时调用 `setPreviewTab` 覆盖。这是 01b 屏的走查入口（验收 3-4「01b 屏默认激活源码 Tab」
   在原型里就表现为「带该参数进入时源码 Tab 激活」）。
5. **高亮**：复用 `src/lib/highlight.ts` 的 `highlightCode(code, lang)`。它已是
   双主题变量方案（`--shiki-light/dark` + `shiki.css` 桥接），源码态直接受益，**不要另起炉灶**。
   语言清单里已有 `html`。

---

## 二、任务拆解与实现要求

### 3.1 双 Tab（`shell/PreviewPane.tsx`）

- 新建 `src/components/primitives/Tabs.tsx`：headless 双 Tab。**不引入 Radix**——
  两个 `button` + `role="tablist"/"tab"` + `aria-selected` + 键盘左右切换即可。
- PreviewPane 结构：顶部 Tab 条 + 下方内容区（随 Tab 互斥渲染）。
  - testid：`preview-tab-effect` / `preview-tab-code`；激活态 `data-active="true"` + `aria-selected`。
  - Tab 条高度做成 layout.ts 常量（建议 `PREVIEW_TABBAR_HEIGHT = 44`，32 高控件 + 上下留白），
    内边距对齐设计稿语义（12 水平）。
- 折叠时整个 aside 照旧收 0 宽，Tab 内容随 overflow-hidden 裁掉——现有机制，无需特殊处理。

### 3.2 源码态

- 新建 `src/mock/preview.ts`：导出一段**自包含、纯静态**的示例「Agent 生成产物」HTML
  （内联 `<style>`，不写 `<script>`；内容像一个真实的小报告页，含中文标题/表格/列表，80~150 行），
  同时导出 `previewTitle`、`previewLanguage = "html"`。源码态与效果态共用这一份数据。
- 渲染：`highlightCode(previewHtml, "html")` → 容器 `dangerouslySetInnerHTML`。
  等宽字体（`font-mono`）、字号 12~13px、`overflow: auto`（横向长行可滚）。
- **行号**：与代码行对齐的 gutter 列。用 CSS counter 或逐行 span 均可，但**必须与高亮 HTML
  的行对齐**（同一步进、同样的 line-height）。容器加 `data-testid="preview-source"`，
  并把行数写到 `data-line-count`（验收脚本要读）。
- **复制按钮**：`data-testid="preview-copy"`，图标用 lucide（size 16，颜色走 `--icon-neutral`）。
  `navigator.clipboard.writeText`，失败回退 textarea + `document.execCommand("copy")`；
  点击后按钮文案/图标短暂变为「已复制」约 1.5s（headless 无剪贴板权限时也不能抛错，走回退与静默成功均可）。
- 样式只准用令牌类与 `shiki.css` 的 `--shiki-*` 桥接；需要在 `shiki.css`/`globals.css`
  补预览源码态的布局样式时，**不得出现 hex**。

### 3.3 效果态

- `<iframe data-testid="preview-iframe" sandbox="" srcDoc={previewHtml} title="预览效果" />`。
  `sandbox` 属性必须存在（验收 3-3）。完全沙箱（空值）即可——mock 是纯静态 HTML，不需要
  scripts / same-origin。
- iframe 占满 Tab 条以下剩余空间，`w-full h-full border-0`，背景由内容自定（独立文档，
  不随应用主题换肤，这是有意的——预览的是「生成物」本身）。
- Tab 切走时可以卸载 iframe；切回重新渲染（原型阶段不要求状态保持）。

### 3.4 02 深色版走查

- `data-theme="dark"` 下走查整个 workbench（含新 PreviewPane 双 Tab、源码态、行号、复制按钮），
  修复所有不可读/残留浅色硬编码处。
- **修复方式只有两种**：改令牌引用、改组件令牌类。禁止 `dark:` 变体、禁止组件 hex。
- 已知**不要动**的（有留档，非 M3 范围）：`text_tertiary` 深色 3.80:1、`warning_soft` 1.95:1、
  浅色 `success` 3.12:1 等是设计稿原值（见 `sync-verification-result.md`），不擅自改值。
- 检查 `shiki.css` 的 `--shiki-dark` 桥接在源码态同样生效（切深色时配色实时跟随、无需重渲染，
  与验收 2-4 同机制）。
- 顺手确认 00 屏 `/tokens` 体检卡深色下正常（应正常，M0 已过，只是回归确认）。

---

## 三、高危点（M1/M2 真实踩过的坑，必读）

1. **PreviewPane 搬家是本项目最高危的一步**。折叠行为是 M1 三条验收的地基，
   className/style 逐字保留后再增量修改；搬完先跑 accept:m1 再继续写新功能。
2. **`cn()` 分组陷阱**：`flex` 与 `flex-col` 同传 `cn()` 会被分组区分（`lib/cn.ts`），
   但不要在新增代码里引入它没覆盖的同前缀异方向组合；不确定就分开传。
3. **不要自己写 m3-acceptance.mjs**——验收脚本由主控（非实现方）编写，这是 M2 定下的规矩
   （M2 首版自写脚本有 7 处缺陷制造了 7 个假失败）。你只需把上面要求的 testid / data 属性暴露好。
4. **mock 里别出现 `</script>`**：srcDoc 内容保持纯静态，模板字符串嵌脚本既没必要也危险。
5. **别动这些**：`tokens.css` 现有 23 个双模式令牌的值（刚与设计稿对齐过，46 项实测一致）；
   `scripts/m1-*.mjs`、`m2-acceptance.mjs`、`cdp.mjs`（验收基线）；`lib/cn.ts`、`lib/layout.ts`
   既有常量的值（只允许**新增** M3 常量）。
6. **npm 依赖冻结**：不 install、不升级、不改 package.json 依赖段。M3 不需要新依赖。

---

## 四、明令禁止（违反即返工）

- `dark:` 变体（Tailwind 或 CSS 选择器）——验收 3-5 直接判死
- 组件 / 非 tokens.css 文件出现 `#hex`（G1；shiki.css 只能用 `--shiki-*` 变量桥接）
- 组件内硬编码尺寸数字（尺寸进 layout.ts 常量，9.2 工程约定）
- 引入新运行时依赖（Radix / AntD / router 等一律不要）
- 动 mock 类型结构（`mock/types.ts`）——M2 已按 Pi 事件冻结

---

## 五、自验最低要求（做完必须全跑，如实记录 exit code）

```bash
# 以下命令都在 packages/ui 下执行
npm run typecheck          # tsc --noEmit，必须 EXIT=0
npm run build              # 必须 EXIT=0，记录 modules 数与体积
npm run accept:m1          # M1 回归。先起 dev server：npm run dev -- --port 5180 --strictPort
npm run accept:m2          # M2 回归。M2_ORIGIN 默认 5182 —— 用另一台 dev server，
                           # 或 M2_ORIGIN=http://127.0.0.1:5180 node scripts/m2-acceptance.mjs 复用 5180
npm run check:cn           # cn() 回归 15 条
```

- 手工浏览器走查：双 Tab 切换、`?preview=code` 进入默认源码态、深浅切换下源码高亮跟随、
  复制按钮、深色全屏无白底黑字残留。浏览器用系统 Chrome（见第六节）。
- **如实报告未实测项**。M2 的铁律：留在盘上但没自验的代码 = 未验证资产。

---

## 六、环境注意事项（本机实测结论，别再踩）

- node 全路径：`"C:/Users/myliu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"`，
  **正斜杠 Windows 路径**，不要 `/c/...`（会被 Git Bash 改写）。
- Bash 工具缺 `ls` / `tail` / `dirname` 等，且 stderr 恒有两行噪音（不影响 exit code）；
  **别用管道**。PowerShell 的 stdout 可能不回传（只回 exit code）——重要输出写临时文件再 Read，
  用完 `node -e "require('fs').unlinkSync('...')"` 删（`rm` 不可用）。
- 包管理器是 **npm**（10.9.7，已锁定在 package.json）。
- 浏览器走查：`"C:\Program Files\Google\Chrome\Application\chrome.exe"`，headless + CDP 可用；
  **调试端口用 9341**（9333= m1 脚本、9337= m2 脚本、9334-9336 是 M2 历史占用，别撞）。
  残留僵尸 Chrome 会占端口，表现为"连上但无响应"，先用 `/json/version` 区分。
- PowerShell 里跑 node 脚本若出现 `RemoteException / NativeCommandError` 噪音，不影响 exit code。
- 工作目录：代码在 `F:\DevelopWork\WorkBuddyWork\Tiktok_auto\packages\ui`，
  本规格书与进度文档在 `F:\DevelopWork\WorkBuddyWork\Tiktok_auto\.plan\`。

---

## 七、交付要求

1. 代码文件（预计，允许合理增删）：
   - 新 `src/components/shell/PreviewPane.tsx`（从 WorkspaceArea.tsx 搬出并实现双 Tab）
   - 新 `src/components/primitives/Tabs.tsx`
   - 新 `src/mock/preview.ts`
   - 改 `src/components/shell/WorkspaceArea.tsx`（删占位 PreviewPane，WorkspaceArea 本体不动）
   - 改 `src/components/shell/WorkbenchScreen.tsx`、`src/components/shell/index.ts`（import）
   - 改 `src/store/ui-store.ts`（previewTab + 持久化）
   - 改 `src/App.tsx`（`?preview=` 参数）
   - 改 `src/lib/layout.ts`（新增 M3 常量段）
   - 按需改 `src/styles/shiki.css` / `globals.css`（仅令牌引用，无 hex）
2. 产出 **`.plan/progress-M3.md`**（仿 progress-M2.md 结构）：逐任务状态、
   自验实测证据（命令 + exit code + 关键数值）、偏离规格及理由、遗留项。
   **验收 3-1~3-8 的逐条结论留给主控复核定稿，你可以写"待主控复核"。**
3. 验收对照表（主控复核用，testid 契约）：

| 验收项 | 判定 | 依赖的 testid / 特征 |
|---|---|---|
| 3-1 双 Tab 存在且互斥 | 点击切换激活态 | `preview-tab-effect` / `preview-tab-code`，`data-active` + `aria-selected` |
| 3-2 源码态：高亮 + 行号 + 复制 | 三要素齐备 | `preview-source`、`data-line-count`、行号节点、`preview-copy` |
| 3-3 效果态 iframe 隔离 | `sandbox` 属性存在 | `preview-iframe` + `sandbox` |
| 3-4 01b 默认激活源码 | `?preview=code` 进入时源码 Tab 激活 | URL 参数 + `previewTab` 持久化 |
| 3-5 零 `dark:` 补丁 | 搜索命中 0 | — |
| 3-6 深色无白底黑字 | 走查 + 抽查计算背景色 | — |
| 3-7 深色代码块可读 | `--shiki-dark` 生效 | 源码态切深色配色跟随 |
| 3-8 G1~G8 | 与前里程碑同口径 | G1 hex / G2 dark: / G3 对比度等 |
