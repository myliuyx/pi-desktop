# 工程踩坑台账（engineering-pitfalls）

> **什么时候读**：写/改验收脚本时、改布局与 CN 工具类时、从上游类型推断字段形状时。
> **为什么独立成文**（2026-09-23）：这些条目原先挤在 `.workbuddy/memory/MEMORY.md` 里，
> 而 MEMORY.md 是**每次会话自动注入**的、有体积上限（超限会被截断）。
> 按本文档索引的纪律「同一结论只放一处 —— 需要多处引用时只放指针，不放副本」，
> 把它们移到这里；MEMORY.md 只留一行指针。
>
> ⚠️ **本台账只增不改**：每条都是踩过的真实缺陷，修法已写在条目里。
> 若要修订某条，**保留原条目并追加「修订」注**，不要直接覆盖（否则下一个人不知道曾经踩过）。

---

## 一、反复验证的教训

### 1. 失败的断言先怀疑断言本身 —— 但 ≠ 断言一定错

M2 首轮 10 个失败里 **7 个是脚本缺陷**；M4 首轮 4 个失败**全是探针缺陷**。
但反面案例同样存在：**M5 5.10 的 Tabs 加 `tabIndex` 是真回归**。
→ 溯源后仍要问一句「**产品能不能变得更对**」，别止步于「断言写错了」。

### 2. `EXIT=0` ≠ 检查发生过；断言全绿 ≠ 验收完成

- `tsc --noEmit` 裸跑（不带 `-p`）因 `tsconfig.json` 是 `files:[]` + references 结构，
  **不检查任何文件、恒 EXIT=0** → 假绿。
- M4 曾出现「断言全绿但**没有证据落盘**」——漏了 `ctx.save()`。
- **对策**：断言「检查确实发生过」（如 `--listFiles` 数一遍文件数），并检查证据文件真的生成。

### 3. 给既有公共 API 加可选参**不是**向后兼容的改动

优先**新增独立方法**。典型：`resolveApproval` 要新增「取消」语义时，
不要塞进 `choice` 的保留值，而是新增 `cancelApproval`。

### 4. hash 路由的两个坑

- **仅 hash 不同的同源导航不会重载文档** —— 依赖「页面加载时执行一次」的初始化逻辑不会重跑。
- **hash 里的 `?query` 不在 `location.search`** —— 必须按第一个 `?` 显式切分 path / query；
  同屏改参要订阅 `hashchange`（不会重挂载）。见 `App.tsx` 的 `readHashParts()`。

### 5. flex 双向陷阱

子项默认 `min-width:auto` 会「顶住不缩」把兄弟挤出容器；
**反向**地，**可收缩项也会被静默压扁**（`TokenStats` 曾被压 55px 无人发现）。
→ 断言必须**同时**盯「不溢出」与「不被压扁」。
→ 「宽度不定、内容可降级」的工具条类场景，用容器查询（TW4 `@container` + `@min-[Npx]:`）分层显隐。
→ 相关 skill：`flexbox-collapse-zerowidth`。

### 6. `cn()` 分组表必须与所用工具类同步

`text-left` 曾落进「颜色」分组被后写的颜色类吞掉 → `<button>` 回落 UA 的 `text-align:center`
**静默居中**（7 处失效，只有两行等宽布局才显形）。
→ **引入新的 Tailwind 工具类目前，先查 `cn.ts` 的分组表，再补 `cn-check` 用例。**

### 7. flex 子项加交叉轴 `margin:auto` 会禁用 stretch

`composer-area` 加 `marginLeft/Right:auto` 后退化为 fit-content，输入框被挤到 ~180px。
→ flex 子项水平居中**必须显式 `width:100%`**（块级流里 `maxWidth + margin:auto` 没这个坑）。
→ 用户已裁决：**输入区保持全宽、仅消息流居中**（`probe-r7` 锁定，别改回去）。

### 8. 图标几何居中 ≠ 视觉居中

flex 居中量的是 svg **盒**（Δ=0），但 lucide Send 的**字形质心**偏右上（8× 像素实测
`(+1.05, -1.17)px @14px`），肉眼读作「没居中」。
→ 修法取质心偏移的**半量**反向 translate（**全量会反转为包围盒失衡**）；
   常量 `SEND_ICON_OPTICAL_SHIFT_X/Y` 入 `lib/layout.ts`，**只用于 Send**，对称字形不套用。

### 9. ★ 内部类型的形状 ≠ 事件里的形状 —— 中间隔着一层打包

（2026-09-23 core 骨架 spike 实踩。）

拿 `core/bash-executor.ts` 的 `BashResult`（**内部类型**）去推断 `tool_execution_end` 的字段形状，
结果 **`exitCode` 与 `output` 两处取值路径全错**：事件里 `result` 是
`{content:[{type:"text",text}], details:{}}` —— **根本没有 `exitCode`**，输出在 `result.content[*].text`。

→ **凡是要断言「事件里有什么」，只能读真实 dump 或事件类型定义（`extensions/types.ts` 那类），
不许读内部实现类型。**
→ 与 #1 同族但**方向相反**：#1 是「断言写错了」，这条是「**推断的输入源不对**」。

---

## 二、验收脚本写作规则（主控实踩）

### 1. 探针在 `cdp.eval` 模板字符串里，正则反斜杠必须双写

`\\s`、`\\(` —— 模板字面量会先吃一层转义，**单写 `\s` 到浏览器里变成 `s`，正则静默失效**
（M5 实踩：rgba 排除失效排查了两轮）。
→ 改完先用 node 本地复现「源码行 → 模板求值 → 正则」的转义链测试，再上 CDP 重跑。

### 2. 断言键以数字开头必须加引号

`{ "00屏确实排除了…": true }` —— 中文裸键合法，但 `00` 开头会被解析为数字字面量 → `SyntaxError`。

### 3. 对同一文件的多次 Edit 必须串行

**并行写同一文件会互相覆盖**（工具报成功但改动丢失/半改状态）。
→ 编辑后 **grep 复查残留**再运行。

### 4. 验收脚本按屏给 `ready` 选择器

00 令牌屏是**独立体检页**，不渲染 `window-shell` —— 用默认选择器会超时。

### 5. ★ UI 断言取样必须限定到目标屏的容器

用 `[data-testid="skills-screen"]` 这类**屏级容器**取样，
**不要用 `document.body.innerText` 整页取样** —— 会被 Sidebar（会话标题里就有一条
「整理 MCP 服务器配置」）与 TitleBar 污染，产生**假失败**。
（2026-09-23 `probe-mcp-gate` 实踩，按教训 #1 溯源后确认是探针缺陷。）

### 6. 长命令必须后台跑

前台超时会把进程 SIGTERM 掉、**拿不到产出**（长构建、spike、验收套件都会中招）。
→ 用 `run_in_background`；spike 类脚本内部再加一道硬超时兜底。
→ 注意：**超时 SIGTERM ≠ 构建失败**，别据此判断代码有问题。

### 7. 期望值一律从 fixture 现读

`check:adapter` 回放 `scripts/fixtures/pi-events-*.jsonl` 时，
**模型每次尝试的路径数不固定** → 把数字写死必然误报。

---

## 三、相关

- `.plan/acceptance-criteria.md` —— 验收标准总纲与逐项口径
- `.plan/ui-rulings.md` —— 布局与交互的**防回退台账**（R1–R10）
- `.plan/survey/S3-tool-approval.md` §八 —— 教训 #9 的完整案例
- skill `flexbox-collapse-zerowidth` / `design-token-contrast-audit` —— 与本文档有部分重叠
