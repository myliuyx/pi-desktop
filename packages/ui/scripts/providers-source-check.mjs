/**
 * Provider 保存来源闸回归 —— `check:providers-source`（CR-084）。
 *
 * 背景：live 读 `/providers` 失败时 SettingsDialog 回落到演示数据作草稿，但「保存」无来源闸，
 * 一点保存就把演示 Provider 全量 PUT 覆盖真实 models.json（真实 Provider/key 被抹 + 演示 string
 * compat 直接触发 CR-029）。修复 = `providersSource(live|fallback)` + 读失败禁存 + 重新读取重试。
 *
 * 本脚本是**离线确定性**回归（`node --experimental-strip-types` 直导，同 format-check.mjs，
 * 无浏览器、无出网）：
 *   R1 live 成功（source=live）→ 可保存、无重试；
 *   R2 live 失败（source=fallback）→ 禁存 + 提供重试（CR-084 核心；先红态此条不过）；
 *   R3 来源标记不随 PUT payload 外发（只活在 UI store，不进 wire）。
 * 用法：npm run check:providers-source；失败非 0 退出。
 */
import { resolveProvidersSaveState } from "../src/screens/settings/providers-save-state.ts";
import { buildPutRequest } from "../src/mock/provider-convert.ts";
import { INITIAL_MODEL_PROVIDERS } from "../src/mock/model-config.ts";

const fails = [];
let passed = 0;
const check = (label, ok, detail) => {
  if (ok) passed++;
  else fails.push(label);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* R1：live 成功 → 可保存、无重试 */
{
  const s = resolveProvidersSaveState("live", true);
  check("[live] 读取成功 → 可保存", s.canSave === true, s);
  check("[live] 读取成功 → 无需重新读取重试入口", s.canRetry === false, s);
}

/* R2：live 失败回落演示数据 → 禁存 + 重试（CR-084 核心，先红态此条不过） */
{
  const s = resolveProvidersSaveState("fallback", true);
  check("[fallback] 读取失败 → 禁止保存（不覆盖真实 models.json）", s.canSave === false, s);
  check("[fallback] 读取失败 → 提供「重新读取」重试", s.canRetry === true, s);
  check("[fallback] 禁止保存时给出原因文案", typeof s.reason === "string" && s.reason.length > 0, s.reason);
}

/* R3：来源标记不进 PUT payload（只活在 UI store）。用真实演示数据构造 PUT，断言顶层只 providers、
 *     且任一 Provider 条目都不携带来源标记（将来若有人把 source/providersSource/readFailed
 *     透传进 wire，此条红）。 */
{
  const put = buildPutRequest(INITIAL_MODEL_PROVIDERS);
  const top = Object.keys(put);
  check("[wire] PUT payload 顶层只有 providers（无来源标记）", top.length === 1 && top[0] === "providers", top);
  const markers = ["source", "providersSource", "readFailed"];
  const leaked = put.providers.some((p) => markers.some((k) => k in p));
  check("[wire] 任一 Provider 条目都不携带来源标记", leaked === false, put.providers.map((p) => Object.keys(p)));
}

if (fails.length > 0) {
  console.error(`\nproviders-source 断言失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`providers-source 断言全部通过：${passed} 项`);
