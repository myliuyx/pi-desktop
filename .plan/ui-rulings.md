# UI 定稿裁决清单（ui-rulings）

> 用途：`packages/ui` 终态的**裁决台账**。每条记录：裁决内容 → 依据（用户原话/背景）→ 落在哪些文件 →
> 探针锁定位置 → 防回退要点。接 Pi 真实数据、后续重构、或任何「顺手调一下布局」之前，先读本文档。
> 里程碑期（M0–M5）的裁决散见各 `progress-Mn.md` / `task-Mn.md`，本文只索引不复制；反直觉点集中在文末速查。

## 一、里程碑期裁决索引（M0–M5，2026-09-22 前定稿）

| 裁决 | 依据 | 锁定位置 | 详见 |
| --- | --- | --- | --- |
| Token 用量四展示值（input/output/total/contextWindow） | 设计稿第 5 轮定稿 | `mock/sessions.ts` INITIAL_TOKEN_USAGE | progress-M2 |
| 对比度口径：`--text-tertiary` 节点单独分组（辅助组门槛 ≥3） | M4 定稿 | 验收探针三类语义例外排除 | progress-M4 |
| 颜色字面量令牌展示值仅允许出现在 00 屏（计数 + 守卫断言） | M5 D2 用户裁决 | 00 屏探针守卫 | progress-M5 |
| 尺寸唯一来源 `lib/layout.ts`、颜色唯一来源 `styles/tokens.css` | 硬约束 G1–G8 | 全库 | README.md / design-tokens.md |

### 微调轮 R1–R6 裁决一览（2026-09-22，逐轮详录见工作日志）

| 轮次 | 裁决 | 落点 | 锁定 / 防回退 |
| --- | --- | --- | --- |
| R1 | Composer 工具条「模型 / 思考」改为**上拉菜单选择**（非循环切换）；MCP 暂不动（**2026-09-23 已裁决整体暂缓**，见 `archive/pi-survey-plan.md` S5「MCP 暂缓处置」） | 新原语 `primitives/ChipMenu.tsx` + `ComposerToolbar` 重写；真相源 `ui-store` 的 modelId/thinkingLevel | testid 兼容口径：定位 wrapper 持原 chip testid，按钮 `*-trigger` / 面板 `*-menu` |
| R2 | 菜单按供应商**分组**（组标题大写灰字 + 分隔线）；chip 箭头不裁切；思考档位带说明 | ChipMenu `groups` 形态 + Chip `trailing` 插槽；工具条溢出根治三层（`min-w-0` / `shrink-0` / 容器查询 `@min-[690px]`） | M2 2-16 口径 delta=0；TokenStats 不许被压扁——断言盯「不溢出」也盯「不被压扁」 |
| R3 | 思考菜单选项**单行**（主文案 + 说明同基线一行） | ChipMenu 选项层 `flex items-baseline` | 选项高 ~29px 单行 |
| R4 | **勾在行首（左）+ 中文说明右对齐** | ChipMenu 选项层勾列 invisible 占位 + `ml-auto` 说明；组标题 `pl-8` 对齐文字 | 量「文字在哪」必须 盒缘 + paddingLeft 或文本 Range，别拿盒缘对盒缘 |
| R5 | 历史会话条目**两行式**（标题 + 「相对时间 · N 条消息」）；标题栏按钮语义「收起两侧」→「**收起右侧**」 | `Sidebar` HistoryItem + `lib/format.ts` formatRelativeTime + `mock/sessions.ts` SESSION_SUMMARIES/SESSION_LIST_NOW；TitleBar testid `titlebar-toggle-both→titlebar-toggle-preview` + ui-store 删 toggleBothPanes | 按钮语义是公共 API——5 个验收脚本 13 处随规格同步；改语义先 grep 全部消费方 |
| R6 | 历史会话条目对齐**终值 = 整体靠左**（meta 右 → 整块右 → 靠左，三连改）；顺带修 cn() 吞类根因 | HistoryItem `text-left`；`lib/cn.ts` 新增 text-align 独立组 + cn-check 5 用例 | **对齐终值以用户最后一句为准**；新增 Tailwind 类目必须同步 cn() 分组表 + cn-check 用例 |

## 二、R7 会话内容列居中（2026-09-22）

- **裁决**：会话消息列（虚拟列表内层容器）在滚动容器内容盒内**水平居中**，列宽 = `MESSAGE_MAX_WIDTH`
  （720px）；左右侧栏四种折叠状态（双展开 → 仅收左 → 双收 → 仅收右 → 复位）自动重排，无需按状态补偿。
- **依据**：用户原话「内容我希望居中显示，注意左右两侧收起展开的状态」。
- **涉及文件**：
  - `MessageList.tsx` 内层虚拟容器：`maxWidth: MESSAGE_MAX_WIDTH` + `marginLeft/Right: auto`（块级流居中）
  - `lib/layout.ts`：`MESSAGE_MAX_WIDTH`
- **探针锁定**：`scripts/probe-r7.mjs` 四折叠状态循环断言 `msgCentered`（±8px 容差，覆盖 10px 全局
  滚动条导致的固有 5.0px 偏左）。
- **防回退**：居中**必须**用块级流 `maxWidth + margin:auto`；禁止在 flex-col 子项上加交叉轴 auto margin
  （禁用 stretch → 盒子退化 fit-content，MEMORY 教训 7，R8a 事故的直接根源）。

## 三、R8a 输入区还原全宽（2026-09-22）

- **裁决**：composer-area（输入区）**保持全宽**，不做居中——padding 24 + gap 原样。
- **依据**：用户原话「这里底部的输入框相关的还原成原来的样子」。背景：R7 首版把输入区也加了居中，
  flex 交叉轴 auto margin 禁用 stretch，composer-area 被挤成 ~180px 内容宽；用户截图反馈后整体回滚。
- **涉及文件**：`WorkspaceArea.tsx` composer-area 样式（已留防回退注释）。
- **探针锁定**：probe-r7 `areaFullWidth`（四状态皆断言）。
- **防回退**：WorkspaceArea.tsx 注释已警告；**消息列居中 + 输入区全宽是刻意的不对称**，不要「顺手统一」。

## 四、R8b 我方气泡贴右（2026-09-22）

- **裁决**：user 角色消息气泡**内容自适应宽度、贴右对齐**（不占满列宽），`maxWidth: MESSAGE_MAX_WIDTH`
  封顶；assistant 气泡保持 `width: 100%`。
- **依据**：用户原话「这个的对话我方不应该占满，参考截图我方说话靠右」。
- **涉及文件**：`MessageList.tsx` MessageItem 包装层按角色分流：

  ```tsx
  isUser ? { maxWidth: MESSAGE_MAX_WIDTH }
         : { maxWidth: MESSAGE_MAX_WIDTH, width: "100%" }
  ```

  外层虚拟行 `items-end` 已禁 stretch → user 盒自然 fit-content 贴右（实测 324/196px，rightGap=0）。
- **探针锁定**：probe-r7「我方气泡」块（userRows > 0、全部右对齐、部分不满宽）。
- **防回退**：别给 user 包装层补 `width:100%`；别把 assistant 也改窄——**对齐终值以本轮用户裁决为准**。

## 五、R9 发送图标光学居中（2026-09-22）

- **裁决**：发送按钮内 Send（纸飞机）图标加 `translate(-0.5px, +0.5px)` 光学补偿。
- **依据**：用户原话「小飞机好像没居中」。8x 像素取证：lucide v0.469 Send 字形**墨迹质心**偏右上
  (+1.05, −1.17)px @14px，而 flex 居中量的是 svg 盒（几何 Δ=0）——几何居中但视觉偏右上。
- **涉及文件**：
  - `lib/layout.ts`：`SEND_ICON_OPTICAL_SHIFT_X = -0.5` / `SEND_ICON_OPTICAL_SHIFT_Y = 0.5`
    （doc 注释含实测数据与半量原理）
  - `Composer.tsx`：图标外包一层 span 施加 transform
- **探针锁定**：probe-r7「R9 发送图标」块（DOMMatrixReadOnly 读 wrapper transform ≈ (−0.5, +0.5)；
  探针期望值须与 layout.ts 常量同步）。
- **防回退**：补偿取质心偏移的**半量**（全量会反转为包围盒失衡 ~2.1px）；常量**只用于 Send**，
  对称字形不套用；取证工具 `scripts/diag-send-icon.mjs` 留存可复跑。

## 六、R10 对比度例外接受（2026-09-22，微调轮收尾）

- **裁决**：`--text-tertiary` 浅色 2.93:1 **接受为已知例外**。
- **依据**：用户原话「2 接受已知例外」。该值跨 8 屏一致，只有改 `tokens.css` 定稿值才可解，
  而设计稿定稿值原型期不动。
- **涉及文件**：`tokens.css`（**不动**）；MEMORY.md 遗留项已标注「已接受」。
- **防回退**：后续对比度审计遇此项直接放行，不再当失败上报。

## 七、反直觉点速查（最容易改错的四处）

1. **输入区全宽但消息列居中**——刻意不对称（R7/R8a），别统一。
2. **svg 几何居中（Δ=0）但图标光学偏移 0.5px**——flex 居中量盒不量墨迹；补偿常量只对 Send 生效（R9）。
3. **我方/对方气泡宽度语义不同**——user fit-content 贴右、assistant 占满（R8b）；改对齐前先看角色分流代码。
4. **历史会话条目对齐经历过三连改**（meta 右 → 整块右 → 靠左），**终值整体靠左**（R6）——
   别翻到旧截图或旧讨论就当 bug 改回去；对齐类裁决终值以用户最后一句话为准。
