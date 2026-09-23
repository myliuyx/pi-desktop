/**
 * 设置弹窗验收探针（probe:settings）—— 设置改版第一批（task-settings-models.md §四 判据草案）。
 *
 * 写作方：主控（非实现方）—— 流程铁律。覆盖口径（2026-09-23 定稿）：
 * - D1 双入口：侧边栏底部「设置」「模型」两半都打开设置弹窗；
 *   三路关闭（✕ / Esc / 取消）。
 * - D4 默认 Tab：每次打开都落在「模型」Tab。
 * - D3 修订：常规 Tab 四组 = 思考强度 → 会话 → 外观 → 工作目录（模型组已删，
 *   且 UI 上不得再出现 AgentOptions.model 字段名）。
 * - 模型 Tab：默认选中首个模型 → ModelForm 字段齐全；点齿轮 → ProviderForm 字段齐全
 *   （API key 掩码）。
 * - 草稿态：改字段 → 取消 → 回滚；改字段 → 保存 → store 生效。
 * - D5 高度恒定：删光全部 Provider（草稿态）后弹窗高度不变。
 * - 钉底：「+ 添加 Provider」固定在左栏底部，列表滚动不影响。
 * - G6 无横向滚动、G7 焦点陷阱（Shift+Tab 不逃出弹窗）。
 *
 * 运行前置：packages/ui 起 dev server（默认 :5180）。CDP 端口 9345（m1/m2/m3/m4/m5 =
 * 9333/9337/9341/9342/9343，错开）。
 */
import { withBrowser, sleep } from "./cdp.mjs";

const HELPERS = `
window.__S = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  rect: (el) => { const r = el.getBoundingClientRect(); return { left:+r.left.toFixed(2), right:+r.right.toFixed(2), top:+r.top.toFixed(2), bottom:+r.bottom.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2) }; },
};
true;
`;

/** 弹窗面板 = [role="dialog"]（遮罩层）的最后一个元素子节点（前一个是遮罩 div） */
const PANEL = `window.__S.q('[role="dialog"]').lastElementChild`;
/** 弹窗是否处于打开态（打开时遮罩 opacity-1 且无 inert） */
const OPEN_CHECK = `(() => {
  const d = window.__S.q('[role="dialog"]');
  return !!d && !d.hasAttribute('inert') && getComputedStyle(d).opacity === '1';
})()`;

async function openByFooter(cdp, testId) {
  await cdp.eval(`(() => { window.__S.q('[data-testid="${testId}"]').click(); return true; })()`);
  await sleep(450); // DIALOG_TRANSITION_MS=200 + 余量
}

async function closeBy(cdp, way) {
  if (way === "esc") {
    // cdp.mjs 的 pressKey 不带修饰键；Esc 直接派发即可
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  } else {
    await cdp.eval(`(() => { window.__S.q('[data-testid="settings-${way}"]').click(); return true; })()`);
  }
  await sleep(450);
}

let failures = 0;

await withBrowser({ port: 9345, evidencePath: "_settings-evidence.json" }, async (ctx) => {
  const { cdp } = ctx;

  await ctx.open("/");
  await cdp.eval(HELPERS);

  /* ================================================== P1 双入口 + 三路关闭 + D4 */
  await openByFooter(cdp, "sidebar-footer-settings");
  {
    const r = await cdp.eval(`(() => ({
      open: ${OPEN_CHECK},
      defaultTabModels: window.__S.q('[data-testid="settings-tab-models"]').getAttribute('aria-selected') === 'true',
      panelVisible: ${PANEL}.getBoundingClientRect().height > 100,
    }))()`);
    ctx.record("P1a_设置按钮打开", r);
    failures += ctx.assert("P1a 「设置」按钮打开弹窗，默认落在「模型」Tab（D4）", {
      弹窗打开: r.open === true,
      默认模型Tab: r.defaultTabModels === true,
      面板有实际高度: r.panelVisible === true,
    }) ? 0 : 1;
  }
  await closeBy(cdp, "dialog-close");

  await openByFooter(cdp, "sidebar-footer-model");
  {
    const r = await cdp.eval(`(() => ({ open: ${OPEN_CHECK}, tabModels: window.__S.q('[data-testid="settings-tab-models"]').getAttribute('aria-selected') === 'true' }))()`);
    ctx.record("P1b_模型按钮打开", r);
    failures += ctx.assert("P1b 「模型」按钮也打开弹窗且落在「模型」Tab（D1 双入口）", {
      弹窗打开: r.open === true,
      默认模型Tab: r.tabModels === true,
    }) ? 0 : 1;
  }
  await closeBy(cdp, "esc");

  await openByFooter(cdp, "sidebar-footer-settings");
  {
    // 先切到常规再取消，验证重开后回落「模型」Tab + 取消能关
    await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-general"]').click(); return true; })()`);
    await sleep(250);
    await closeBy(cdp, "cancel");
    const closed = await cdp.eval(OPEN_CHECK);
    await openByFooter(cdp, "sidebar-footer-settings");
    const r = await cdp.eval(`(() => ({ open: ${OPEN_CHECK}, tabModels: window.__S.q('[data-testid="settings-tab-models"]').getAttribute('aria-selected') === 'true' }))()`);
    ctx.record("P1c_取消关闭重开回落", { closedByCancel: !closed, ...r });
    failures += ctx.assert("P1c 「取消」可关闭；重开后默认仍落在「模型」Tab", {
      取消已关闭: closed === false,
      重开默认模型Tab: r.tabModels === true,
    }) ? 0 : 1;
  }

  /* ================================================== P2 常规 Tab 四组顺序（D3 修订） */
  await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-general"]').click(); return true; })()`);
  await sleep(300);
  {
    const r = await cdp.eval(`(() => {
      const groups = window.__S.qa('[data-testid="settings-group"]').map(g => g.dataset.group);
      return {
        groups,
        orderCorrect: JSON.stringify(groups) === JSON.stringify(['thinking','session','appearance','working-dir']),
        modelGroupGone: !groups.includes('model'),
        thinkingOptions: window.__S.qa('[data-testid="settings-thinking-option"]').length,
        sessionSwitches: window.__S.qa('[data-testid="settings-switch"]').length,
        themeOptions: window.__S.qa('[data-testid="settings-theme-option"]').length,
        workingDirVisible: !!window.__S.q('[data-testid="settings-working-dir"]'),
      };
    })()`);
    ctx.record("P2_常规Tab四组", r);
    failures += ctx.assert("P2 常规 Tab：思考强度/会话/外观/工作目录四组且顺序正确，无模型组", {
      四组顺序正确: r.orderCorrect === true,
      模型组已删除: r.modelGroupGone === true,
      思考档位存在: r.thinkingOptions > 0,
      会话开关两个: r.sessionSwitches === 2,
      主题三段存在: r.themeOptions === 3,
      工作目录在: r.workingDirVisible === true,
    }) ? 0 : 1;
  }

  /* ================================================== P3 Pi 字段名（4-6 迁移口径） */
  {
    const r = await cdp.eval(`(() => {
      const t = window.__S.q('[data-testid="settings-general-tab"]').innerText;
      return {
        thinking: /set_thinking_level/.test(t),
        autoCompact: /SettingsManager\\.autoCompact/.test(t),
        autoRetry: /SettingsManager\\.autoRetry/.test(t),
        cwd: /AgentOptions\\.cwd/.test(t),
        modelFieldNameGone: !/AgentOptions\\.model/.test(t),
      };
    })()`);
    ctx.record("P3_Pi字段对齐", r);
    failures += ctx.assert("P3 常规 Tab 可读到 Pi 字段名（模型字段名随模型组一并移除）", {
      thinking对齐: r.thinking === true,
      autoCompact对齐: r.autoCompact === true,
      autoRetry对齐: r.autoRetry === true,
      cwd对齐: r.cwd === true,
      旧模型字段名未回流: r.modelFieldNameGone === true,
    }) ? 0 : 1;
  }

  /* ================================================== P4 模型 Tab：默认选中首个模型 → ModelForm */
  await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-models"]').click(); return true; })()`);
  await sleep(300);
  {
    const r = await cdp.eval(`(() => {
      const q = (s) => window.__S.q('[data-testid="' + s + '"]');
      return {
        modelRowExists: window.__S.qa('[data-testid="model-row"]').length > 0,
        modelId: !!q('model-id'), modelName: !!q('model-name'),
        capReasoning: !!q('model-cap-reasoning'), capImage: !!q('model-cap-image'),
        contextWindow: !!q('model-context-window'), maxTokens: !!q('model-max-tokens'),
        prices: ['model-price-input','model-price-output','model-price-cache-read','model-price-cache-write'].every(s => !!q(s)),
        advancedToggle: !!q('model-advanced-toggle'), testBtn: !!q('model-test'), removeBtn: !!q('model-remove'),
      };
    })()`);
    ctx.record("P4_模型表单字段", r);
    failures += ctx.assert("P4 模型 Tab 默认选中首个模型，ModelForm 字段齐全", {
      模型行存在: r.modelRowExists === true,
      ID与Name: r.modelId && r.modelName,
      能力两项: r.capReasoning && r.capImage,
      规格两项: r.contextWindow && r.maxTokens,
      价格四列: r.prices === true,
      高级设置与操作: r.advancedToggle && r.testBtn && r.removeBtn,
    }) ? 0 : 1;
  }

  /* ================================================== P5 Provider 表单（齿轮入口，API key 掩码） */
  await cdp.eval(`(() => { window.__S.qa('[data-testid="provider-gear"]')[0].click(); return true; })()`);
  await sleep(300);
  {
    const r = await cdp.eval(`(() => {
      const q = (s) => window.__S.q('[data-testid="' + s + '"]');
      const key = q('provider-api-key');
      return {
        name: !!q('provider-name'), baseUrl: !!q('provider-base-url'),
        apiKeyType: key ? key.type : null,
        apiType: !!q('provider-api-type'), importBtn: !!q('provider-import'),
        enabled: !!q('provider-enabled'), deleteBtn: !!q('provider-delete'),
      };
    })()`);
    ctx.record("P5_Provider表单字段", r);
    failures += ctx.assert("P5 齿轮进入 Provider 表单，API key 为掩码输入", {
      名称与BaseURL: r.name && r.baseUrl,
      APIkey是password: r.apiKeyType === "password",
      API类型与导入: r.apiType && r.importBtn,
      启用与删除: r.enabled && r.deleteBtn,
    }) ? 0 : 1;
  }

  /* ================================================== P6 草稿态（取消回滚 / 保存生效 / 复原） */
  {
    const original = await cdp.eval(`(() => {
      const spans = window.__S.qa('[data-testid="provider-header"]')[0].querySelectorAll('span');
      return spans[1].textContent;
    })()`);
    // —— 取消路径：往 provider-name 写一个草稿值（React 受控输入需走原生 setter）
    await cdp.eval(`(() => {
      const el = window.__S.q('[data-testid="provider-name"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify("草稿名-不应生效")});
      el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    await closeBy(cdp, "cancel");
    await openByFooter(cdp, "sidebar-footer-settings");
    await sleep(250);
    const afterCancel = await cdp.eval(`(() => {
      const spans = window.__S.qa('[data-testid="provider-header"]')[0].querySelectorAll('span');
      return spans[1].textContent;
    })()`);
    ctx.record("P6a_取消回滚", { original, afterCancel });
    failures += ctx.assert("P6a 改字段后「取消」：草稿丢弃，store 不被污染", {
      名称回滚: afterCancel === original,
    }) ? 0 : 1;

    // —— 保存路径
    await cdp.eval(`(() => { window.__S.qa('[data-testid="provider-gear"]')[0].click(); return true; })()`);
    await sleep(250);
    await cdp.eval(`(() => {
      const el = window.__S.q('[data-testid="provider-name"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify("AliYun-已保存")});
      el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    await closeBy(cdp, "save");
    await openByFooter(cdp, "sidebar-footer-settings");
    await sleep(250);
    const afterSave = await cdp.eval(`(() => {
      const spans = window.__S.qa('[data-testid="provider-header"]')[0].querySelectorAll('span');
      return spans[1].textContent;
    })()`);
    ctx.record("P6b_保存生效", { afterSave });
    failures += ctx.assert("P6b 改字段后「保存」：store 更新（弹窗内可见）", {
      名称已保存: afterSave === "AliYun-已保存",
    }) ? 0 : 1;

    // —— 复原（保存原名，避免污染后续断言的可读性）
    await cdp.eval(`(() => { window.__S.qa('[data-testid="provider-gear"]')[0].click(); return true; })()`);
    await sleep(250);
    await cdp.eval(`(() => {
      const el = window.__S.q('[data-testid="provider-name"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(original)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    await closeBy(cdp, "save");
  }

  /* ================================================== P7 D5 高度恒定（删光 Provider） */
  {
    const hBefore = await cdp.eval(`window.__S.rect(${PANEL}).height`);
    // 逐个删除：齿轮 → 删除 → 确认（两步确认），直到没有 provider-header
    for (let i = 0; i < 12; i++) {
      const has = await cdp.eval(`window.__S.qa('[data-testid="provider-header"]').length`);
      if (!has) break;
      await cdp.eval(`(() => { window.__S.qa('[data-testid="provider-gear"]')[0].click(); return true; })()`);
      await sleep(200);
      await cdp.eval(`(() => { window.__S.q('[data-testid="provider-delete"]').click(); return true; })()`);
      await sleep(150);
      await cdp.eval(`(() => { const b = window.__S.q('[data-testid="provider-delete-confirm"]'); if (b) b.click(); return true; })()`);
      await sleep(250);
    }
    const remaining = await cdp.eval(`window.__S.qa('[data-testid="provider-header"]').length`);
    const emptyState = await cdp.eval(`!!window.__S.q('[data-testid="model-form-pane"]')`);
    const hAfter = await cdp.eval(`window.__S.rect(${PANEL}).height`);
    ctx.record("P7_删光Provider后高度", { hBefore, hAfter, remaining, emptyState });
    failures += ctx.assert("P7 删光全部 Provider 后弹窗高度恒定（D5，不塌缩）", {
      已全部删除: remaining === 0,
      空态在: emptyState === true,
      高度不变: Math.abs(hAfter - hBefore) <= 1,
    }) ? 0 : 1;
    // 取消丢弃删除草稿，恢复 mock 数据（内存 store 每次刷新本就会重置，这里保持本页内一致）
    await closeBy(cdp, "cancel");
    await openByFooter(cdp, "sidebar-footer-settings");
    await sleep(250);
  }

  /* ================================================== P8 「+ 添加 Provider」钉底 */
  {
    const r = await cdp.eval(`(() => {
      const tree = window.__S.q('[data-testid="model-provider-tree"]');
      const btn = window.__S.q('[data-testid="add-provider"]');
      const treeRect = window.__S.rect(tree);
      const btnRect = window.__S.rect(btn);
      // 滚动列表到最底，按钮必须纹丝不动
      const list = tree.firstElementChild;
      list.scrollTop = list.scrollHeight;
      return { treeBottom: treeRect.bottom, btnBottom: btnRect.bottom, scrollTopSet: list.scrollTop };
    })()`);
    await sleep(250);
    const r2 = await cdp.eval(`(() => {
      const tree = window.__S.q('[data-testid="model-provider-tree"]');
      const btn = window.__S.q('[data-testid="add-provider"]');
      return { treeBottom: window.__S.rect(tree).bottom, btnTopAfterScroll: window.__S.rect(btn).top, btnBottomAfterScroll: window.__S.rect(btn).bottom };
    })()`);
    ctx.record("P8_钉底", { ...r, ...r2 });
    failures += ctx.assert("P8 「+ 添加 Provider」固定在左栏底部，不随列表滚动", {
      按钮贴栏底: r.treeBottom - r.btnBottom >= 0 && r.treeBottom - r.btnBottom <= 12,
      列表滚动后仍在栏底: Math.abs(r2.btnBottomAfterScroll - r.btnBottom) <= 1,
    }) ? 0 : 1;
  }

  /* ================================================== P9 G6 无横向滚动 + P10 G7 焦点陷阱 */
  {
    const r = await cdp.eval(`(() => {
      const noH = (el) => !el || el.scrollWidth <= el.clientWidth + 1;
      return {
        tree: noH(window.__S.q('[data-testid="model-provider-tree"]')),
        formPane: noH(window.__S.q('[data-testid="model-form-pane"]')),
        generalTab: noH(window.__S.q('[data-testid="settings-general-tab"]')),
      };
    })()`);
    ctx.record("P9_无横向滚动", r);
    failures += ctx.assert("P9 弹窗内容区无横向滚动（G6）", {
      Provider树: r.tree === true,
      表单区: r.formPane === true,
      常规Tab: r.generalTab === true,
    }) ? 0 : 1;

    // 焦点陷阱：聚焦面板第一个可聚焦元素 → Shift+Tab 必须留在面板内
    const trap = await cdp.eval(`(() => {
      const panel = ${PANEL};
      const focusables = [...panel.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')];
      focusables[0].focus();
      return { first: document.activeElement.dataset.testid || document.activeElement.tagName };
    })()`);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8, // CDP 位掩码：Shift = 8（Alt=1/Ctrl=2/Meta=4）
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await sleep(150);
    const inside = await cdp.eval(`(() => {
      const panel = ${PANEL};
      return panel.contains(document.activeElement);
    })()`);
    ctx.record("P10_焦点陷阱", { ...trap, afterShiftTabInside: inside });
    failures += ctx.assert("P10 Shift+Tab 在面板首个元素上不逃出弹窗（G7 焦点陷阱）", {
      焦点仍在面板内: inside === true,
    }) ? 0 : 1;
  }

  await cdp.screenshot("_settings-probe.png");
});

// 汇总退出码（非 0 = 有断言失败）
if (failures > 0) {
  console.error(`\\n== probe:settings 有 ${failures} 组断言未通过 ==`);
  process.exit(1);
}
console.log("\\n== probe:settings 全部通过 ==");
