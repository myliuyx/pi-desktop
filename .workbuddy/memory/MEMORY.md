# 项目长期记忆 · Tiktok_auto / packages/ui

> 桌面 Agent 跨平台设计系统（纯 UI 原型阶段）。本文件只放**跨会话有长期价值**的事实与惯例。
> 逐日细节见 `YYYY-MM-DD.md`；里程碑结论见 `.plan/archive/progress-M*.md`（已归档，日常不读）。
> **文档唯一入口：`.plan/README.md`** —— 索引 + 读法规则 + 活跃/参考/归档三层。改文档前先看它。

## 项目定位与边界

- **Ardot 画布 fileId**：`728255468414716`（设计稿为令牌的唯一权威来源）
- **当前阶段**：**纯 UI 原型已全部完成（M0–M5 定稿，2026-09-22）** —— 不接 Pi、不接 LLM、不做 Electron 壳
- **8 屏（全部落地）**：00 令牌 / 01 工作台（含源码态）/ 03 运行详情 / 04 技能与工具 / 05 设置 / 06 窗口壳（并排+单壳）
- **里程碑**：M0 8.5h → M1 12h → M2 20h → M3 9.5h → M4 8.5h → M5 11h，净工时 69.5h 全部完成
  （总盘 83.5h 含缓冲 14h）

## 技术栈（依赖已冻结，npm 10.9.7 锁定）

React 19 + TypeScript + Vite 6 + Tailwind CSS v4 + Zustand + lucide-react +
shiki + react-markdown + remark-gfm + @tanstack/react-virtual。**共 8 个依赖，不随意新增。**

## 硬约束（任何时候都不能破）

- **G1**：hex 只允许出现在 `styles/tokens.css`，其余一律用 CSS 变量
- **G2**：禁止 `dark:` 变体补丁，深浅切换只靠 `:root[data-theme="dark"]`
- **G3**：对比度分级 —— **正文 ≥4.5、辅助文字 ≥3**
- **G4**：图标固定 `#8A919E`，**不随主题变**（算对比度时必须排除 svg / aria-hidden 节点）
- **G5**：不用 Tailwind 内置调色板
- **G6**：任何组合下不得出现横向滚动
- **G7**：键盘可达
- **G8**：折叠必须有过渡
- **颜色唯一来源** `styles/tokens.css`；**尺寸/时长唯一来源** `lib/layout.ts`
  （禁止在 `style={{}}` 里写裸尺寸；`<=1px` 的发丝线除外）

## 命令口径（踩过坑，别改错）

- **typecheck 必须带 `-p`**：`tsc --noEmit -p tsconfig.app.json`。
  `tsconfig.json` 是 `files:[]` + references 结构，裸 `tsc --noEmit` **不检查任何文件、恒 EXIT=0（假绿）**。
- 验收命令：`accept:m1`（红线回归，**只能在默认 workbench 路由跑**）/ `accept:m2` / `accept:m3` /
  `accept:m4` / `accept:m5`，用 `M2_ORIGIN=` / `M3_ORIGIN=` / `M4_ORIGIN=` / `M5_ORIGIN=` 环境变量覆盖 origin。
  **跑 m2 必须显式 `M2_ORIGIN=http://127.0.0.1:5180`**（其默认 5182 是历史多实例惯例，其余里程碑默认 5180）。
- **CDP 端口分配**：m1=9333 / m2=9337 / m3=9341 / m4=9342 / **m5=9343**
- `check:cn`（scripts/cn-check.mjs，`--experimental-strip-types`）是 **cn() 工具回归**，与中文文案无关
  （20 项，含 flex/display/text-align 分组与真实 class 串）。

## 验收流程铁律

1. 主控写 `task-Mn.md` 规格书（含逐条 testid 契约表；历史规格书已归档至 `.plan/archive/`）
2. 派执行方实现；执行方产 progress 文档，**逐条标「待主控复核」，自己不下通过结论**
3. **验收脚本必须由非实现方（主控）编写** —— 这是 M2 定下的铁律
4. 主控独立复跑全部命令，**不采信执行方回报**，结论写入 `progress-Mn.md` 末章（该类文件现归档于 `.plan/archive/`）

## ★ 反复验证的教训（M2~M5 持续验证）

1. **失败的断言先怀疑断言本身。** M2 首轮 10 失败里 7 个是脚本缺陷；M4 首轮 4 失败全是探针缺陷；
   M5 主控自写脚本也踩了 5 处（见下）。但反面案例也存在（M5 5.10：Tabs 加 tabIndex 是真回归）——
   **先怀疑断言 ≠ 断言一定错**；溯源后「产品能不能变得更对」也要同时问。
2. **EXIT=0 ≠ 检查发生过**（裸 tsc 假绿）；**断言全绿 ≠ 验收完成**（M4 漏 `ctx.save()` 就没证据落盘）。
3. **给既有公共 API 加可选参不是向后兼容的改动** —— 优先新增独立方法。
4. **同源仅 hash 不同的导航不重载文档**；且 **hash 里的 `?query` 不在 `location.search`**（M5 5.9）——
   hash 路由必须按第一个 `?` 显式切分 path/query，屏内参数要订阅 `hashchange`（同屏改参不重挂载）。
5. **flex 双向陷阱（2026-09-22 工具条实踩）**：子项默认 `min-width:auto` 会「顶住不缩」把兄弟挤出容器；
   反过来**可收缩项也会被静默压扁**（TokenStats 被压 55px 无人发现——验收只查右缘对齐不查压缩）。
   断言要同时盯「不溢出」和「不被压扁」；超宽先量预算（禁 shrink 读自然宽度）再决策，
   工具条类「宽度不定、内容可降级」场景用容器查询（TW4 `@container` + `@min-[Npx]:`）分层显隐。
6. **cn() 分组表必须与所用工具类同步（2026-09-22 历史会话实踩）**：text-* 曾只有「字号|颜色」两组，
   `text-left` 落进颜色组被后写的颜色类吞掉 → `<button>` 回落 UA 的 text-align:center 静默居中
   （7 处失效、仅两行等宽布局才显形）。**给组件引入新的 Tailwind 工具类目时，先查 cn.ts 分组表、
   再补 cn-check 用例**；对齐/字号/颜色同前缀的工具类必须分组细分。
7. **flex 子项加交叉轴 margin:auto 会禁用 stretch（2026-09-22 会话区居中实踩）**：composer-area
   是 flex-col 子项，加 `marginLeft/Right:auto` 后整盒退化为 fit-content，输入框被挤成 ~180px。
   块级流里 `maxWidth + margin:auto` 居中没有此坑（MessageList 内层即此法）；flex 子项要水平居中
   必须显式 `width:100%`，且用户已裁决**输入区保持全宽、仅消息流居中**（probe-r7 锁定，别再改回去）。
8. **图标几何居中 ≠ 视觉居中（2026-09-22 发送按钮实踩）**：flex 居中量的是 svg 盒（Δ=0），
   但 lucide Send 字形**质心**偏右上（8x 像素实测 (+1.05,-1.17)px @14px），肉眼读作「没居中」。
   「看着没居中」先跑 `scripts/diag-send-icon.mjs` 分层取证（几何/像素），修法取质心偏移的
   **半量**反向 translate（全量会反转为包围盒失衡）；偏移常量入 layout.ts
   （SEND_ICON_OPTICAL_SHIFT_X/Y），只用于 Send，对称字形不套用。

## ★ M5 新增的脚本写作规则（主控验收脚本实踩 5 坑的沉淀）

- **探针在 `cdp.eval` 模板字符串里，正则反斜杠必须双写**（`\\s`、`\\(`）—— 模板字面量先吃一层转义，
  单写 `\s` 到浏览器里变成 `s`，正则静默失效（M5 实踩：rgba 排除失效排查两轮）。
  改完先用 node 本地复现「源码行 → 模板求值 → 正则」转义链测试，再上 CDP 重跑。
- **断言键以数字开头必须加引号**（`"00屏确实排除了…"`）—— 中文裸键合法，但 `00` 开头被解析为数字字面量 → SyntaxError。
- **对同一文件的多次 Edit 必须串行** —— 并行写同一文件会互相覆盖（工具报成功但改动丢失/半改状态）；
  编辑后 grep 残留复查再运行。
- **验收脚本按屏给 `ready` 选择器**（00 令牌屏是独立体检页，不渲染 `window-shell`）。
- **对比度探针排除三类语义例外**：svg/aria-hidden（G4）、`--text-tertiary` 继承节点单独分组（M4 口径）、
  **颜色字面量令牌展示值**（`#hex`/`rgba()/rgb()/hsla()`，仅允许出现在 00 屏，必须计数 + 守卫断言）。

## 对比度测量口径（M4 定稿 + M5 D2 裁决扩展）

按**计算后文字颜色**分层，不是按 class 名：
- 排除 `svg` / `svg *` / `aria-hidden="true"` 节点（G4 图标是刻意固定的非文字色）
- 读 `--text-tertiary` 转 rgb 作为「辅助色」基准分组
- 正文组门槛 ≥4.5、辅助组门槛 ≥3
- **M5 D2**：颜色字面量令牌展示值（`#hex`/`rgba()/rgb()/hsla()`）从正文分类排除，但**计数 +
  守卫断言只允许出现在 00 屏**（00 屏色板 Swatch 的 label 就是令牌原始值，刻意渲染在对侧主题固定底色上）
- M5 定稿：七屏深色正文最低 **4.90**（01/00/05）、辅助最低 3.17，全部达标
- 已知例外：`--text-tertiary` 浅色 2.93:1（跨 8 屏一致，改令牌定稿值才可解，设计稿定稿值不在原型期改）
  —— **2026-09-22 用户裁决接受为已知例外**，后续对比度审计遇此直接放行，不再当失败上报

## Pi 接入 POC（2026-09-22 通过，架构风险已销账）

- **调研文档第七节的「唯一高风险项」已证伪**：Electron 44.4.3（内置 Node 24.21.0 / ABI 149）主进程里
  `pi-coding-agent` 可 import（~887ms）、`@earendil-works/pi-tui` 与 `photon-node` 均可加载、
  真实会话跑通（模型回 `pong`）。**Electron 壳 + Pi 内核方案不再有已知颠覆性风险。**
- 完整记录：`.plan/poc-pi-2026-09-22.md`；回归资产：`pi/_poc/`（`models.json` / `smoke.ts` /
  `electron-probe/`，密钥在 `pi/_poc/.env.local`，pi/ 整体 gitignore 未入库）。
- **模型接入**：火山方舟 `https://ark.cn-beijing.volces.com/api/coding/v3` 是
  **openai-completions** 端点（Anthropic Messages 端点才是不带 `/v3` 的 `/api/coding`）；
  `models.json` 用 `"apiKey": "$ARK_API_KEY"` 插值，兼容端点要关
  `compat.supportsDeveloperRole/supportsReasoningEffort`；SDK 走
  `ModelRuntime.create({modelsPath})` → `setRuntimeApiKey()` → `getModel()`
  （pi-ai 顶层 `getModel()` 已 deprecated）。
- **接 Pi 时仍未验的两项**：① asar 打包（native `.node` 在 asar 内 dlopen 才是真风险，缓解 = asar unpack）；
  ② 本次用源码 monorepo（workspace 软链），换 npm 发布包后需重跑探针。

## 版本管理（2026-09-22 起）

- 根目录**已 `git init`**，首提交 `175a208`（126 文件 / 29609 行），收官态原型全量入库。
- `.gitignore` 忽略：`node_modules/` `dist/` `*.tsbuildinfo` `_chk*.txt` `.workbuddy/cache/` **`pi/`**。
  `pi/` 是上游 `earendil-works/pi` 的本地 clone（无自带 .git、无本地改动），**刻意不入库**，
  需还原用 `git clone https://github.com/earendil-works/pi pi`；将来要改 pi 源码时必须改这条规则。
- 本地 git 身份是**占位值**（`myliu` / `myliu@localhost`，仅 local 级、未设 global）——
  推送远端前需改成真实身份。
- **无远端仓库**，目前只有本地提交。

## 环境踩坑（Windows / 本机）

- **Bash 工具的 `rm` / `ls` / `dirname` / `tail` / `head` 经常 exit 127**（shim 缺失）→ 改用 node 脚本做文件操作
- **PowerShell 的 stdout 常不回传**（只给 exit code）→ 把结果**用 node 直接写文件**再 Read
  （经 PS 管道写中文会乱码，且 `*>` 生成 UTF-16 导致 Read 报 binary；
  node 侧检测 BOM `0xFF 0xFE` 再按 utf16le 解码即可）
- `cmd.exe` 在 PowerShell 工具里被安全策略拦截；`npm.ps1` 被执行策略拦截 → 用 **`npm.cmd`**；
  bash shim 里连 `npm` 裸命令也 127（dirname 缺失连累）—— **最稳是绕过 npm，
  直接 node 二进制调 scripts/*.mjs**（`check:cn` 要带 `--experimental-strip-types`）
- 长命令用 `run_in_background=true`，避免超时被 SIGTERM（那不是构建失败）
- CDP 用系统 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`），
  **不装 puppeteer/playwright**（Chromium 从 Google CDN 下载超时）
- **`vite build` 与已启动 dev server 并存会显著变慢**（曾卡 transforming >25min）；
  **陈旧 `tsconfig.*.tsbuildinfo` 也会让 build 长卡** —— 两个都删掉后 17 秒完成。
  遇「构建卡住」先清环境状态，别急着怀疑代码。

## 遗留项（原型收官后仍开放，均非阻断）

- ~~`--text-tertiary` 浅色 2.93:1~~ —— **已结**：2026-09-22 用户裁决接受为已知例外（不再视为待决项）
- ~~设计稿待回写差异~~ —— **已结**（2026-09-22 晚）：R7–R9 四项已回写画布（元信息两行式文案 /
  720 居中列 / 我方气泡贴右；标题栏收起控件核对通过），执行单 `.plan/diffs/diff-writeback-R7-R9-2026-09-22.md`；
  已知残留：画布会话标题等 mock 文案与实现不同源（内容层差异，未回写）。
  配套台账：`.plan/ui-rulings.md`（布局裁决）、`.plan/pi-integration-points.md`（接 Pi 替换点）
- 06 屏缩略窗口（scale 0.42）文字不可读 / 不可交互 —— 单壳模式 `#/shells?os=` 提供全尺寸替代
- 主包 520.03 kB / gzip 159.59 kB —— 若需压缩可对 03~06 屏做 React.lazy
- `chat-store` 在 DEV 下挂 `window.__chatStore` 供验收脚本驱动；接 Pi 时改回真实 UI 驱动
- 证据文件保留：`_m1-evidence.json` / `_m2-evidence.json` / `_m3-evidence.json` /
  `_m3-walk-evidence.json` / `_m4-evidence.json` / `_m5-evidence.json`（执行方自查）/
  `_m5-acceptance-evidence.json`（主控验收）/ `_probe-r7-evidence.json`（R7 居中+输入区全宽
  +我方气泡贴右三裁决，探针 scripts/probe-r7.mjs 四折叠状态 7 断言，含 R9 发送图标光学偏移）（其余临时文件跑完即清）
