/**
 * 斜杠命令 —— 内置命令注册表 + 清单组装（斜杠命令批次，2026-10-01）。
 *
 * 为什么独立成文件：这是「以后接更多命令」的唯一扩展点。加一条 builtin 只需往
 * BUILTIN_SLASH_COMMANDS 加一个对象（name/description/run），UI 通过
 * GET /slash-commands 自动出现，UI 零改动。
 *
 * 设计纪律：
 * - **不 import pi**（BuiltinCommandHost 是极窄的结构化接口）⇒ 纯逻辑可不起 core、
 *   不装模型就单测（scripts/slash-commands-check.mjs）。
 * - 与 pi 语义对齐：扩展命令名与 builtin 同名时，菜单里剔除扩展项（照抄
 *   pi interactive-mode.ts:703-727 的冲突过滤）。
 */

import type { SlashCommandItem, SlashCommandScope, SlashCommandsPayload } from "./contract.ts";

/** 内置命令的执行宿主（由 session.ts 用真实 AgentSession 适配，隔离 pi 类型） */
export interface BuiltinCommandHost {
  reload(): Promise<void>;
  compact(instructions?: string): Promise<void>;
}

export interface BuiltinSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  run(host: BuiltinCommandHost, args: string): Promise<void>;
}

const reloadCommand: BuiltinSlashCommand = {
  name: "reload",
  description: "重新加载扩展、技能、提示词和工具",
  async run(host) {
    await host.reload();
  },
};

const compactCommand: BuiltinSlashCommand = {
  name: "compact",
  description: "压缩上下文，可选附加说明",
  argumentHint: "<instructions>",
  async run(host, args) {
    await host.compact(args.trim() ? args.trim() : undefined);
  },
};

/** 加一条命令 = 往这里加一个对象（UI 自动出现，无需改 UI） */
export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [reloadCommand, compactCommand];

/**
 * 把输入文本匹配到 builtin；未命中返回 null。
 * 只认「首 token 与注册名精确相等」——`/reloading`、`reload`、`/unknown` 都不匹配。
 */
export function matchBuiltinCommand(text: string): { command: BuiltinSlashCommand; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const name = space === -1 ? body : body.slice(0, space);
  const args = space === -1 ? "" : body.slice(space + 1);
  const command = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}

/** sourceInfo（pi 的 scope/origin）→ 菜单来源标签；temporary / 缺失 → undefined */
export function scopeOfSource(
  sourceInfo: { scope?: string; origin?: string } | undefined,
): SlashCommandScope | undefined {
  if (!sourceInfo) return undefined;
  if (sourceInfo.origin === "package") return "package";
  if (sourceInfo.scope === "user" || sourceInfo.scope === "project") return sourceInfo.scope;
  return undefined;
}

/**
 * 菜单项不可执行原因（UI 作为 tooltip）；null = 可执行。
 * 与执行护栏口径**不同**：菜单里流式中的 `/compact` 也置灰（spec §6.5 要求提示会先停生成），
 * 但手打执行时 `/compact` 在流式中是允许的（见 builtinExecutionError）。
 */
export function builtinMenuUnavailableReason(
  name: string,
  a: { isStreaming: boolean; isCompacting: boolean },
): string | null {
  if (a.isCompacting) return "会话正在压缩，请稍候";
  if (a.isStreaming) {
    if (name === "reload") return "会话正在生成回复，请先停止再重新加载会话";
    if (name === "compact") return "会先停止当前生成";
  }
  return null;
}

/**
 * 执行护栏（手打命令也走这里）：返回不可执行原因；null = 可执行。
 * `/reload` 流式/压缩中禁止；`/compact` 仅压缩中禁止（流式中内部先 abort，pi 既定语义）。
 */
export function builtinExecutionError(
  name: string,
  a: { isStreaming: boolean; isCompacting: boolean },
): string | null {
  if (name === "compact") return a.isCompacting ? "会话正在压缩，请稍候" : null;
  if (name === "reload") {
    if (a.isStreaming) return "会话正在生成回复，请先停止再重新加载会话";
    if (a.isCompacting) return "会话正在压缩，请稍候再重新加载";
  }
  return null;
}

/** 纯数据输入（不依赖 pi）：由 session 层从公开 getter 采集后传入 */
export interface SlashCommandSourceInput {
  isStreaming: boolean;
  isCompacting: boolean;
  skillsEnabled: boolean;
  extensionCommands: { name: string; description: string; scope?: SlashCommandScope }[];
  skills: { name: string; description: string; scope?: SlashCommandScope }[];
}

/** 纯函数：组装 SlashCommandsPayload（内置 → 扩展 → 技能；空组自然为空） */
export function buildSlashCommandsPayload(input: SlashCommandSourceInput): SlashCommandsPayload {
  const builtinAvailable = !input.isStreaming && !input.isCompacting;
  const commands: SlashCommandItem[] = [];

  const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
  for (const c of BUILTIN_SLASH_COMMANDS) {
    const reason = builtinMenuUnavailableReason(c.name, input);
    commands.push({
      name: c.name,
      description: c.description,
      source: "builtin",
      available: reason === null,
      ...(reason ? { unavailableReason: reason } : {}),
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    });
  }

  for (const c of input.extensionCommands) {
    // 与 pi 一致：同名扩展不进菜单（builtin 优先）
    if (builtinNames.has(c.name)) continue;
    commands.push({
      name: c.name,
      description: c.description,
      source: "extension",
      available: true,
      ...(c.scope ? { scope: c.scope } : {}),
    });
  }

  if (input.skillsEnabled) {
    for (const s of input.skills) {
      commands.push({
        name: s.name,
        description: s.description,
        source: "skill",
        available: true,
        ...(s.scope ? { scope: s.scope } : {}),
      });
    }
  }

  return { commands, builtinAvailable };
}