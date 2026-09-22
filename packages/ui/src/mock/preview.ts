/**
 * 预览区 mock —— 一段「Agent 生成的产物」HTML。
 *
 * 约束（task-M3.md 3.2）：
 * - 自包含、纯静态：内联 <style>，**不写 <script>**（srcDoc 沙箱不需要，模板字符串里
 *   嵌脚本标签既没必要也危险，M2 教训：mock 里别出现 script 闭合标签）；
 * - 内容像一个真实的小报告页：含中文标题 / 表格 / 列表，80~150 行；
 * - 源码态与效果态共用这一份数据（效果态 srcDoc 渲染它，源码态高亮它）；
 * - 独立文档不随应用主题换肤 —— 预览的是「生成物」本身，这是有意的。
 *
 * 为什么颜色全用 rgb() 而不写 #hex：这份 HTML 是独立文档，不参与应用换肤、
 * 用不了 tokens.css 的令牌；同时 G1 的检查模式是全局搜索 #hex 字面量
 * （范围含 src/ 下全部 .ts 文件），mock 里的样式值用 rgb() 记法即可两全 ——
 * 视觉不变，也不产生「应用组件硬编码色值」的误报。
 */

export const previewTitle = "Atlas Agent · Pi 工具链接入调研报告";

export const previewLanguage = "html";

export const previewHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Atlas Agent · Pi 工具链接入调研报告</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
      background: rgb(246, 247, 249); color: rgb(31, 35, 41);
      line-height: 1.7; padding: 32px 40px;
    }
    .page { max-width: 720px; margin: 0 auto; }
    header {
      border-bottom: 2px solid rgb(53, 99, 232);
      padding-bottom: 16px; margin-bottom: 24px;
    }
    h1 { font-size: 22px; letter-spacing: 0.5px; }
    .meta {
      margin-top: 8px; font-size: 12px; color: rgb(107, 114, 128);
      display: flex; gap: 16px;
    }
    .badge {
      display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
      background: rgb(225, 245, 238); color: rgb(15, 122, 88);
    }
    h2 {
      font-size: 16px; margin: 24px 0 12px; padding-left: 10px;
      border-left: 4px solid rgb(53, 99, 232);
    }
    p { margin-bottom: 10px; }
    ul, ol { padding-left: 22px; margin-bottom: 10px; }
    li { margin-bottom: 6px; }
    table {
      width: 100%; border-collapse: collapse; margin: 12px 0 16px;
      background: rgb(255, 255, 255); font-size: 13px;
    }
    caption {
      caption-side: top; text-align: left; font-size: 12px;
      color: rgb(107, 114, 128); padding-bottom: 6px;
    }
    th, td { border: 1px solid rgb(224, 227, 232); padding: 8px 12px; text-align: left; }
    th { background: rgb(238, 242, 254); color: rgb(39, 74, 158); font-weight: 600; }
    tr:nth-child(even) td { background: rgb(250, 251, 252); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .pass { color: rgb(15, 122, 88); }
    .warn { color: rgb(143, 91, 14); }
    footer {
      margin-top: 32px; padding-top: 12px; font-size: 12px; color: rgb(138, 145, 158);
      border-top: 1px solid rgb(224, 227, 232);
    }
    code {
      font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px;
      background: rgb(238, 240, 243); padding: 1px 5px; border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>Pi 工具链接入调研报告</h1>
      <div class="meta">
        <span>项目：Atlas Agent</span>
        <span>撰写：Pi 调研小组</span>
        <span>状态：<span class="badge">可进入评审</span></span>
      </div>
    </header>

    <h2>一、背景</h2>
    <p>
      当前原型仅以 mock 数据驱动界面，执行链路尚未接通。本报告评估把
      <code>Pi Agent Core</code> 作为统一工具链接入的可行性，重点核对
      事件模型、进程管理与设置持久化三块的对接成本。
    </p>

    <h2>二、核心结论</h2>
    <ul>
      <li>Pi 的事件流（<code>message_update</code> / <code>tool_execution_*</code>）可一层映射到现有 UI Block。</li>
      <li>工具白名单（<code>read / bash / edit / write</code>）与「技能与工具」屏字段一致。</li>
      <li>设置面板字段与 <code>SettingsManager</code> 对齐，接入前不需要额外适配层。</li>
      <li>风险集中在进程生命周期：崩溃恢复与多会话并发尚无现成方案。</li>
    </ul>

    <h2>三、对接指标测算</h2>
    <table>
      <caption>表 1 · 按模块估算的对接工作量与风险</caption>
      <thead>
        <tr>
          <th>模块</th>
          <th>对接方式</th>
          <th class="num">预估工时</th>
          <th>风险</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>事件流映射</td>
          <td>事件 → Block 一层转换</td>
          <td class="num">8h</td>
          <td class="pass">低</td>
        </tr>
        <tr>
          <td>进程管理</td>
          <td>常驻子进程 + stdio</td>
          <td class="num">16h</td>
          <td class="warn">中</td>
        </tr>
        <tr>
          <td>设置持久化</td>
          <td>对齐 SettingsManager</td>
          <td class="num">4h</td>
          <td class="pass">低</td>
        </tr>
        <tr>
          <td>崩溃恢复</td>
          <td>需自行设计</td>
          <td class="num">12h</td>
          <td class="warn">中</td>
        </tr>
      </tbody>
    </table>

    <h2>四、下一步建议</h2>
    <ol>
      <li>先接「事件流映射」打通端到端演示，其余模块随后并行。</li>
      <li>为进程管理补一份心跳与重启策略的设计稿。</li>
      <li>把本报告的指标表并入里程碑排期，作为 M6 的输入。</li>
    </ol>

    <footer>
      本文档由 Agent 自动生成 · 2026-09-22 · 仅供内部评审
    </footer>
  </div>
</body>
</html>
`;
