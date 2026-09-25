/**
 * 布局尺寸常量 —— 唯一的数值来源。
 *
 * 为什么单独抽一个文件：这些值全部来自设计稿，且**设计稿还会改**。
 * 硬编码在各组件里会导致"改一处漏三处"，集中在这里则只需改一行。
 * 同理，颜色走 tokens.css，尺寸走 layout.ts。
 *
 * 与 Figma 的对应关系见 .plan/screens.md 第一节「尺寸」表。
 */

/** 设计画布宽度（2026-09-21 定稿：按 1440 开工） */
export const DESIGN_WIDTH = 1440;

/** 窗口默认高度 */
export const DESIGN_HEIGHT = 900;

/** 标题栏高度 */
export const TITLE_BAR_HEIGHT = 36;

/** 侧边栏宽度 */
export const SIDEBAR_WIDTH = 264;

/** 侧边栏内容区水平内边距（底部条带需穿出这层 padding 才能通底） */
export const SIDEBAR_PADDING = 12;

/** 侧边栏内容区纵向间距 */
export const SIDEBAR_GAP = 10;

/** 历史会话区与工作目录区按 2:1 分配内容区剩余高度 */
export const SIDEBAR_HISTORY_SECTION_FLEX_GROW = 2;
export const SIDEBAR_WORKING_DIRECTORY_SECTION_FLEX_GROW = 1;

/** 两个可滚动分区从 0 基础高度开始分配剩余空间，列表变多时只触发内部滚动 */
export const SIDEBAR_SECTION_FLEX_BASIS = "0%";

/** 侧边栏底部条带高度（模型 / 设置 分段控件） */
export const SIDEBAR_FOOTER_HEIGHT = 36;

/** 右侧预览区默认宽度 */
export const PREVIEW_PANE_WIDTH = 480;

/** 折叠动画时长（ms）—— 验收项 1-10 要求约 180ms */
export const COLLAPSE_DURATION = 180;

/**
 * 系统开启「减少动态效果」时的折叠时长（ms）。
 *
 * 为什么不直接写 `motion-reduce:transition-none`：那会生成
 * `@media (prefers-reduced-motion: reduce) { transition-property: none }`，
 * 把过渡**整个干掉**，折叠退化成瞬间跳变 —— 直接违反验收 1-10 / G8。
 *
 * 但也不能因此就不做 reduced-motion 适配：开启该偏好的用户是真实存在的
 * （headless Chrome 默认即为 reduce，本机实测就是这种情况）。
 *
 * 正确做法是**降低时长而非取消过渡**。
 *
 * 取值为什么不是 1ms：1ms 在 60fps 下不到一帧，rAF 采样只能看到首尾两个值
 * （实测中间帧数 = 0），等价于瞬间跳变，1-10 仍然挂 —— 只是把「取消过渡」
 * 换成了「快到看不见」，并没有真正满足要求。
 *
 * 取值为什么从 90ms 上调到 120ms（M5 裁决）：
 * M2 记录过「中间帧实测 4→3 帧」，而 1-10 的门槛正是「中间帧 ≥3」，
 * 90ms 属于**踩线通过**、毫无余量 —— rAF 采样抖动一次就会掉到 2 帧而假性回归。
 * 120ms 在 60fps 下约可采到 7~8 个中间帧，给采样抖动留出真实余量；
 * 同时 120 仍显著小于正常的 180ms（减幅 1/3），reduced-motion 的用户偏好依旧被尊重。
 * 两个目标（1-10 的「非瞬间跳变」、用户偏好）同时达成，且不再踩线。
 * 改完已按要求重跑 `npm run accept:m1` 验证 1-10（见 progress-M5.md 第四节）。
 */
export const COLLAPSE_DURATION_REDUCED = 120;

/** 工具条控件高度（芯片、分段控件） */
export const TOOLBAR_CONTROL_HEIGHT = 32;

/** 标题栏图标按钮尺寸 */
export const TITLE_BAR_BUTTON_SIZE = 28;

/** Composer 发送按钮尺寸（第 6 轮定稿：28×28 正圆） */
export const SEND_BUTTON_SIZE = 28;

/**
 * 发送按钮图标的光学偏移（第 9 轮裁决，2026-09-22）。
 *
 * lucide v0.469 的 Send 字形「墨迹包围盒」近乎完美居中，但**三角形体的质心**
 * 偏右上 —— 8x 像素实测质心 (+1.05, -1.17)px（14px 渲染下），几何上 svg 盒与按钮
 * 完全同心（Δ=0），肉眼却读作「没居中」（右上重、左下空）。
 * 修法取质心偏移的**半量**反向 translate：全量补偿会把包围盒反转为可见失衡
 * （左右留白差 ~2.1px），半量把质心残差与包围盒偏移同时压到 0.7px 以内。
 * ⚠️ 只用于 Send；Square / ArrowUp 等中心对称字形不偏移，不得套用。
 * 取证工具：scripts/diag-send-icon.mjs（几何 + 8x 像素双层测量）。
 */
export const SEND_ICON_OPTICAL_SHIFT_X = -0.5;
export const SEND_ICON_OPTICAL_SHIFT_Y = 0.5;

/**
 * 折叠后保留的宽度。
 * 不用 display:none —— 验收项 1-10 要求过渡过程中不出现布局跳变，
 * 保留 0 宽容器 + overflow:hidden 能让宽度过渡连续。
 */
export const COLLAPSED_WIDTH = 0;

/* ---------------------------------------------------------------------------
 * M2 · 会话工作台
 *
 * ★ 归属说明：Composer 与工具条挂在**内容区（WorkspaceArea）内部**，
 *   不是横跨整个窗口底部。判定依据：
 *   ① M1 的 WorkspaceArea 注释已写明「M2 才填消息流 / Composer / 工具条」；
 *   ② 验收 1-3 已锁定「侧边栏底部条带的底边与**窗口底**重合」（offsetBottom = 0），
 *      若 Composer 横跨窗口底部，条带就会被顶上移，1-3 立刻失效。
 *   ⚠️ `.plan/screens.md` 第一节的 ASCII 草图把 Composer 画成了横跨全宽，那张图是
 *   当初的粗略示意、**与上面两条冲突**，以本节说明为准（该图已同步修正）。
 * ------------------------------------------------------------------------- */

/** 消息流内容区四边内边距 */
export const MESSAGE_LIST_PADDING = 24;

/** 相邻消息之间的纵向间距 */
export const MESSAGE_GAP = 20;

/** 消息内容最大宽度（避免超宽屏下一行过长） */
export const MESSAGE_MAX_WIDTH = 720;

/**
 * 新建会话页（NewSessionHero）建议卡区的最大宽度。
 * 取值对照参照图的两卡总宽（≈656px，task-new-session-page.md §4.1）：
 * 比消息列（720）略窄，居中后视觉更聚焦。
 */
export const NEW_SESSION_COLUMN_WIDTH = 656;

/** Composer 输入框最小高度（单行态） */
export const COMPOSER_MIN_HEIGHT = 44;

/** Composer 输入框最大高度，超出后输入框内部滚动（验收 2-17） */
export const COMPOSER_MAX_HEIGHT = 200;

/** Composer 输入框内边距 */
export const COMPOSER_PADDING = 12;

/** 发送按钮距输入框右/下边缘的内缩距离（验收 2-9：必须在边框内侧） */
export const COMPOSER_SEND_INSET = 8;

/** Composer 与工具条之间的间距 */
export const COMPOSER_TOOLBAR_GAP = 8;

/** 代码块最大高度，超出后块内滚动 */
export const CODE_BLOCK_MAX_HEIGHT = 360;

/** 终端输出默认展示的最大行数，超出即截断（验收 2-7） */
export const TERMINAL_MAX_LINES = 12;

/** 距底部多少 px 以内视为「贴底」，用于自动滚底判定（验收 2-5） */
export const AUTO_SCROLL_THRESHOLD = 32;

/** 流式模拟的打字间隔（ms） */
export const STREAM_TICK_MS = 24;

/* ---------------------------------------------------------------------------
 * M3 · 预览区（双 Tab / 源码态 / 效果态）
 * ------------------------------------------------------------------------- */

/** 预览区 Tab 条高度（32 高控件 + 上下留白） */
export const PREVIEW_TABBAR_HEIGHT = 44;

/** 预览区 Tab 条水平内边距（对齐设计稿 12 的水平语义） */
export const PREVIEW_TABBAR_PADDING_X = 12;

/** 复制按钮进入「已复制」态后回落到默认态的时长（ms） */
export const PREVIEW_COPY_RESET_MS = 1500;

/* ---------------------------------------------------------------------------
 * M4 · 其余三屏（03 运行详情 / 04 技能与工具 / 05 设置）
 *
 * ★ 归属说明：这三屏是**独立可访问的路由**，但视觉上保持与工作台一致的应用外观 ——
 *   各自渲染 `<WindowShell>` + `<Sidebar>`（footer 传 `SidebarFooter` 以保持条带通底）
 *   + 自己的内容区，**不渲染 `PreviewPane`**。理由：
 *   ① 三屏是「应用的三个功能页」，保留侧边栏才有应用感（00 屏是体检页，性质不同，保持原样）；
 *   ② 复用 WindowShell 才能让 06 屏的 `os` prop 将来覆盖它们；
 *   ③ 与预览无关，占 480px 只会挤压内容。
 *   ⚠️ 折叠行为仍由 store 驱动，因此折叠回归（1-10 / 1-12 / 1-13）覆盖到这三屏，
 *      内容区容器必须带 `min-w-0`（验收 4-7）。
 * ------------------------------------------------------------------------- */

/** 三屏内容区的四边内边距（与消息流同一边距语义，视觉上接得住） */
export const SCREEN_PADDING = 24;

/** 三屏页面头的高度（标题 + 汇总行 + 返回值按钮所在的一整条） */
export const SCREEN_HEADER_HEIGHT = 64;

/** 三屏正文分区间距（纵向分组之间的留白） */
export const SCREEN_SECTION_GAP = 24;

/** 三屏正文中每个分区内部的行间距 */
export const SCREEN_ROW_GAP = 10;

/** 时间轴轨道宽度（节点圆点 + 连接线所在的左列） */
export const TIMELINE_RAIL_WIDTH = 28;

/** 时间轴节点圆点直径 */
export const TIMELINE_DOT_SIZE = 10;

/** 运行详情步骤卡内「摘要」区的最大高度，超出后容器内滚动（防长输出撑破容器） */
export const RUN_STEP_SUMMARY_MAX_HEIGHT = 88;

/** 运行详情展开区的最大高度，超出后容器内滚动（长输出的落点） */
export const RUN_STEP_DETAIL_MAX_HEIGHT = 420;

/** 设置页字段标签列的宽度（窄屏下该列会换行，不设固定总宽） */
export const SETTINGS_LABEL_WIDTH = 148;

/**
 * 设置分组标题行的最小高度。
 *
 * 为什么要显式给最小高度：分组标题行是 `flex-wrap` 的（窄屏下说明文字会换行），
 * 不锁最小高度时，**未换行的分组标题行比换行的矮**，导致五个分组的标题基线参差、
 * 视觉上像是"排版没对齐"。20 = text-sm 的行高（14 × 1.43 ≈ 20）。
 */
export const SETTINGS_GROUP_HEADER_MIN_HEIGHT = 20;

/** 开关控件宽 / 高（原生 role="switch" 按钮的视觉尺寸） */
export const SWITCH_WIDTH = 36;
export const SWITCH_HEIGHT = 20;
/** 开关滑块直径（与高度的差值是留给内边距的余量） */
export const SWITCH_KNOB_SIZE = 16;
/** 开关滑块距边缘的内缩（(高 - 滑块) / 2 = 2） */
export const SWITCH_KNOB_INSET = 2;

/* ---------------------------------------------------------------------------
 * M5 · 窗口壳与走查
 *
 * ★ 06 屏的呈现方式（主控决策，见 task-M5.md 1.3）：
 *   三端并排 = 三个「缩略窗口」纵向堆叠在一个可滚动的屏里。
 *   缩略窗口的**内层尺寸恒为 DESIGN_WIDTH × DESIGN_HEIGHT**（1440 × 900），
 *   只用 `transform: scale()` 缩小视觉大小 —— 这样三端之间的内容区坐标系是同一个，
 *   「首个元素坐标完全一致」（验收 5-2）才有意义。
 *   ★ `offsetLeft / offsetTop` **不受 transform 影响**，所以坐标探针必须放在
 *     缩放容器内层；`getBoundingClientRect()` 会被 scale 污染，绝不能用它验坐标。
 * ------------------------------------------------------------------------- */

/**
 * 06 屏缩略窗口的缩放比。
 *
 * 取值依据：06 屏可视宽度 = 窗口宽（1440）- 侧边栏（264）- 内容区左右内边距（2 × 24）
 * = 1128；缩略窗口要留出卡片边框与纵向滚动条余量，按 0.42 缩放后宽 = 604.8，
 * 稳妥落在 1128 之内。取 0.42 而不是撑满，是为了让三张卡片纵向堆叠时
 * 单卡高度（900 × 0.42 = 378）也落在合理范围，一屏能看到约两张。
 */
export const SHELL_PREVIEW_SCALE = 0.42;

/** 06 屏缩略窗口卡片的圆角（与 radius-lg 同档，但独立常量便于走查调整） */
export const SHELL_PREVIEW_RADIUS = 12;

/** 06 屏缩略窗口的标签区高度 */
export const SHELL_PREVIEW_LABEL_HEIGHT = 28;

/** 06 屏缩略窗口卡片的纵向堆叠间距 */
export const SHELL_PREVIEW_GAP = 24;

/** 06 屏缩略窗口卡片的边框宽度（1px 发丝线，配合半径与令牌边框色） */
export const SHELL_PREVIEW_BORDER_WIDTH = 1;

/**
 * 06 屏模式提示条高度。
 * 提示条带 `data-mode`（grid / single），让验收脚本知道当前处于哪种模式。
 */
export const SHELLS_MODE_HINT_HEIGHT = 28;

/* ---------------------------------------------------------------------------
 * 设置弹窗（第一批：全局 Dialog，D1）
 *
 * ★ 尺寸唯一来源：以下常量全部进本文件，组件用 `style={{}}` 引用，
 *   禁止在组件里写裸数值（≤1px 发丝线除外）。弹窗宽度、头部/底部条高度、
 *   内边距、左栏宽度等都从设计稿折算后集中在这里。
 * ------------------------------------------------------------------------- */

/** 设置弹窗宽度（设计稿中弹窗约 880，留足左右两栏） */
export const SETTINGS_DIALOG_WIDTH = 880;

/**
 * 弹窗整体高度（px，配合 MAX_HEIGHT_VH 做视口钳制）。
 * ★ 必须恒定、不随内容塌缩：模型 Tab 删光全部 Provider 后内容区为空，
 *   若高度由内容撑开，弹窗会缩成一条（2026-09-23 用户实踩）。
 */
export const SETTINGS_DIALOG_HEIGHT = 640;

/** 弹窗头部高度（Tab 条 + ✕ 按钮所在的一整条） */
export const SETTINGS_DIALOG_HEADER_HEIGHT = 48;

/** 弹窗底部条高度（取消 / 保存 所在的一整条） */
export const SETTINGS_DIALOG_FOOTER_HEIGHT = 56;

/** 弹窗内部统一内边距（内容区四边） */
export const SETTINGS_DIALOG_PADDING = 20;

/** 弹窗内模型 Tab 的左栏（Provider 树）宽度 */
export const SETTINGS_DIALOG_LEFT_WIDTH = 280;

/** 模型 Tab 左右两栏之间的间距 */
export const SETTINGS_DIALOG_SPLIT_GAP = 16;

/** 模型表单里标签列的基准宽度（窄屏下会换行，不设固定总宽） */
export const MODEL_FORM_LABEL_WIDTH = 132;

/** 折叠 / 弹窗过渡时长（ms）—— 与 COLLAPSE_DURATION 同源，验收要求有过渡非瞬间跳变 */
export const DIALOG_TRANSITION_MS = 200;

/** 弹窗展开时的最大高度（视口占比，留边距；用 vh 表达，非颜色） */
export const SETTINGS_DIALOG_MAX_HEIGHT_VH = 90;

/* ---------------------------------------------------------------------------
 * 工作目录上弹菜单（侧边栏 + 设置页共用同一个浮层组件）
 *
 * ★ 这个浮层是**项目里第一个 portal**：触发条位于
 *   `sidebar-working-directory-content`（`overflow-y-auto`）内部，且外层
 *   `sidebar-working-directory-section`（`:270`）与 `aside`（`:181`）**也都是
 *   `overflow-hidden`** —— 原地 `absolute bottom-full`（ChipMenu 的写法）会被逐层裁掉，
 *   而且被裁时 `getBoundingClientRect()` 照样返回正常数值（"看起来有值"≠"看得见"）。
 *   所以必须 `createPortal(panel, document.body)` + `position: fixed`。
 * ------------------------------------------------------------------------- */

/** 面板最小宽度（触发条较窄时也要放得下路径与「下次启动 / 运行中」角标） */
export const WORKING_DIR_MENU_MIN_WIDTH = 240;

/** 面板与触发条之间的间距 */
export const WORKING_DIR_MENU_GAP = 6;

/**
 * 浮层统一 z 轴高度。
 *
 * 既有梯子：10 站内 / 20 ChipMenu / 50 Dialog + NoticeStack。
 * 取 60 的**唯一原因**是设置页场景：那里面板要盖住 `Dialog`（z-50，见
 * `primitives/Dialog.tsx:108`），否则「更改」弹出的面板会被 backdrop 与弹窗本体压住。
 */
export const POPOVER_Z = 60;

/**
 * 面板淡入时长（ms）。
 * reduced-motion 下取**半量**（与 `Dialog` 同款口径），**绝不取消过渡** ——
 * `motion-reduce:transition-none` 会生成 `transition-property: none`，
 * 把过渡整个干掉（G8 老坑，headless Chrome 默认即 reduce）。
 */
export const WORKING_DIR_MENU_FADE_MS = 120;
