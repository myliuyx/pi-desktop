# 设计令牌体系

> 本文件定义颜色的**唯一来源**。所有组件不得硬编码颜色值（图标描边的固定中性色除外，见第 5 节）。

---

## 一、为什么这样做

设计稿在 Figma 里用两个变量集管理外观：

- `Theme`（setId `3:2`，Light `3:1` / Dark `3:3`）
- `Radius`（setId `3:26`，mode `3:25`）

深色稿的做法是：**复制浅色根 frame，再在根 frame 上施加 `variableModes` 一次性换肤**，而不是维护第二套样式。

代码里对应同一套心智模型：

- 定义一套**语义令牌**（CSS 变量）
- 深色模式只覆盖 `:root[data-theme="dark"]` 下的变量值
- 组件永远只引用语义令牌，不关心当前是深是浅

好处：设计稿改令牌，代码只改一处；深浅切换只是换一个属性。

---

## 二、命名规则

沿用设计稿的变量名，保证一一对齐：

```
bg_*        背景
text_*      文字
border_*    描边
accent*     强调色
radius_*    圆角
```

**字间距说明**：Figma 里是 `bg_app`，CSS 里写作 `--bg-app`。Tailwind 映射后 class 为 `bg-bg-app` —— 前缀重复，但换来与 Figma 变量名的严格对应。设计稿改变量名时能立刻定位，值得。

---

## 三、令牌定义

### 3.1 浅色（默认）

> ⚠️ 以下为**建议初值**，需对照 Figma `Theme` 变量集 Light 模式校正实际色值。命名与结构是正确的。

```css
:root {
  /* 背景 */
  --bg-app:        #FFFFFF;   /* 页面底 */
  --bg-surface:    #FCFCFD;   /* 面板、卡片 */
  --bg-subtle:     #F5F6F8;   /* 芯片、分段控件底、侧边栏条带 */
  --bg-elevated:   #FFFFFF;   /* 浮层、下拉 */
  --bg-hover:      rgba(0, 0, 0, 0.045);
  --bg-active:     rgba(0, 0, 0, 0.075);

  /* 文字 */
  --text-primary:   #1A1D21;
  --text-secondary: #61656B;
  --text-tertiary:  #8A919E;
  --text-inverse:   #FFFFFF;

  /* 描边 */
  --border-subtle:  #E8EAED;
  --border-default: #D8DBDF;
  --border-strong:  #B9BDC3;

  /* 强调色 */
  --accent:       #3563E8;   /* 白字对比度 5.12:1 */
  --accent-hover: #2A55CF;
  --accent-soft:  #EEF2FE;   /* accent 在其上 4.58:1 */
  --accent-fg:    #FFFFFF;   /* 强调色上的文字 */

  /* 语义色（作为文字放在各自 soft 底上须 >= 4.5:1，见第 9 节） */
  --success:      #0F7A58;   /* on --success-soft = 4.69:1 */
  --success-soft: #E1F5EE;
  --warning:      #8F5B0E;   /* on --warning-soft = 4.99:1 */
  --warning-soft: #FAEEDA;
  --danger:       #C0392B;   /* on --danger-soft = 4.72:1；白字在其上 5.44:1 */
  --danger-soft:  #FCEBEB;
  --info:         #1A6BBD;   /* on --info-soft = 4.72:1 */
  --info-soft:    #E6F1FB;

  /* 圆角 */
  --radius-sm:  4px;
  --radius-md:  6px;
  --radius-lg:  8px;
  --radius-xl:  12px;
  --radius-full: 9999px;

  /* 字体 */
  --font-sans: "Inter", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Consolas, monospace;

  /* 字号 */
  --text-xs:  11px;
  --text-sm:  12px;
  --text-base: 13px;
  --text-md:  14px;
  --text-lg:  16px;
  --text-xl:  20px;

  /* 阴影（桌面应用克制使用） */
  --shadow-sm: 0 1px 2px rgba(16, 20, 26, 0.06);
  --shadow-md: 0 4px 12px rgba(16, 20, 26, 0.10);
  --shadow-lg: 0 12px 32px rgba(16, 20, 26, 0.14);
}
```

### 3.2 深色

```css
:root[data-theme="dark"] {
  --bg-app:        #16181C;
  --bg-surface:    #1C1F24;
  --bg-subtle:     #24272D;
  --bg-elevated:   #23262C;
  --bg-hover:      rgba(255, 255, 255, 0.06);
  --bg-active:     rgba(255, 255, 255, 0.10);

  --text-primary:   #E8EAED;
  --text-secondary: #9AA0A8;
  --text-tertiary:  #6E747C;
  --text-inverse:   #16181C;

  --border-subtle:  #2A2E35;
  --border-default: #343941;
  --border-strong:  #454B54;

  --accent:       #6B93FF;   /* 深色下需提亮 */
  --accent-hover: #85A6FF;
  --accent-soft:  #1E2A47;
  --accent-fg:    #16181C;   /* 深色下 accent 已提亮为浅蓝，白字仅 2.90:1，故反用深色前景（6.13:1） */

  --success:      #5DCAA5;
  --success-soft: #14352B;
  --warning:      #EF9F27;
  --warning-soft: #3A2A11;
  --danger:       #F09595;
  --danger-soft:  #3D1F1F;
  --info:         #85B7EB;
  --info-soft:    #16293D;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.30);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.40);
  --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.50);
}
```

> 圆角、字号、字体在深浅模式下不变，不重复定义。

---

## 四、Tailwind v4 映射

在 `globals.css` 中用 `@theme inline` 桥接 —— 这样 Tailwind 生成的 utility 引用的是 CSS 变量，换肤时自动跟随，无需重新生成 class。

```css
@import "tailwindcss";

@theme inline {
  /* 颜色 */
  --color-bg-app:        var(--bg-app);
  --color-bg-surface:    var(--bg-surface);
  --color-bg-subtle:     var(--bg-subtle);
  --color-bg-elevated:   var(--bg-elevated);
  --color-bg-hover:      var(--bg-hover);
  --color-bg-active:     var(--bg-active);

  --color-text-primary:   var(--text-primary);
  --color-text-secondary: var(--text-secondary);
  --color-text-tertiary:  var(--text-tertiary);
  --color-text-inverse:   var(--text-inverse);

  --color-border-subtle:  var(--border-subtle);
  --color-border-default: var(--border-default);
  --color-border-strong:  var(--border-strong);

  --color-accent:       var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-soft:  var(--accent-soft);
  --color-accent-fg:    var(--accent-fg);

  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger:  var(--danger);
  --color-info:    var(--info);

  /* 圆角、字号、字体 */
  --radius-sm:   var(--radius-sm);
  --radius-md:   var(--radius-md);
  --radius-lg:   var(--radius-lg);
  --radius-xl:   var(--radius-xl);
  --radius-full: var(--radius-full);

  --text-xs:   var(--text-xs);
  --text-sm:   var(--text-sm);
  --text-base: var(--text-base);
  --text-md:   var(--text-md);
  --text-lg:   var(--text-lg);
  --text-xl:   var(--text-xl);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
}
```

使用示例：

```tsx
<div className="bg-bg-app text-text-primary">
  <button className="bg-accent text-accent-fg rounded-md">发送</button>
  <div className="bg-bg-subtle border border-border-subtle rounded-lg">芯片</div>
</div>
```

---

## 五、图标色的例外规则

**图标一律使用固定中性色 `#8A919E`，不跟随主题令牌。**

这是设计稿第 7 轮修订时确定下来的：侧边栏底部的「模型 / 设置」按钮用固定灰而非令牌色，原因是深浅两种背景下都要保证可见。

对应到代码：

```css
:root { --icon-neutral: #8A919E; }
```

这个值**不在深色块中覆盖**。图标组件内部强制使用该色。

---

## 六、深浅切换实现

```tsx
// store/ui-store.ts
type Theme = "light" | "dark";

// 应用时
document.documentElement.dataset.theme = theme;
```

初始主题读取顺序：

1. `localStorage.getItem("theme")`
2. 若为空，取 `window.matchMedia("(prefers-color-scheme: dark)").matches`
3. 写入 `<html data-theme="...">`

**注意**：主题属性必须设在 `<html>`（`:root`）上，因为令牌定义在 `:root[data-theme="dark"]`。

---

## 七、使用规范

1. **禁止**在组件里写 `#hex`、`rgb()`、Tailwind 内置色（如 `bg-gray-100`、`text-black`）。
2. 需要新颜色时，先在 `tokens.css` 加语义令牌，再在 `@theme inline` 映射，最后使用。
3. 图标描边用 `--icon-neutral`，不受第 1 条约束。
4. 透明遮罩用 `color-mix()` 或 `rgb(from var(--accent) r g b / 20%)`，不要新造半透明令牌。
5. 阴影只在浮层（下拉、弹窗、Popover）使用，常规卡片用描边区分层次。

---

## 八、核对清单

开工前需与设计稿逐项对齐：

- [x] `Theme` 变量集 Light / Dark 的全部色值（尤其 `--accent` 系列）——**2026-09-22 01:00 已实测核对并同步**
> ✅ **2026-09-22 核对结果**：用 `fetch_variables` 实测读取设计稿 `Theme` 集，
> 确认设计稿当时停留在**代码对比度压暗之前**那一版（Light `accent` `#5C5CD7` / Dark `#7D7DF0`），
> 与代码现值相差一整轮，并**缺失 `info` / `info_soft`**。判定「真需要同步」，已全量回写。
> 逐项比对见 [`sync-verification-result.md`](./sync-verification-result.md)。
> 此前的"状态未知"疑点见 [`sync-check-report.md`](./sync-check-report.md)（该报告结论已由本次核对收敛）。
- [ ] `Radius` 变量集各档数值
- [ ] 字号阶梯（设计稿实际使用的字号与行高）
- [x] 三栏尺寸：侧边栏 264 / 预览区默认 480 / 最小窗口宽度 —— **2026-09-21 定稿按 1440 开工**，已落为 `src/lib/layout.ts` 常量
- [ ] 间距基准（4px 栅格还是 8px）

> **尺寸不走令牌，走常量。** 颜色有深浅两套值，必须用 CSS 变量才能换肤；尺寸只有一个值，
> 放 `src/lib/layout.ts` 即可，用不着的间接层只会增加查找成本。

