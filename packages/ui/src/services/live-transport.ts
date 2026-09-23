/**
 * live 传输层单例 —— `?live=1` 形态下**全应用共用一个** `HttpAgentTransport`。
 *
 * 为什么必须共享（不是重复创建那么简单）：`HttpAgentTransport` 内部持有一条 SSE 连接，
 * 多实例 = 多条 SSE 连接 = 每个事件被 reducer 应用多次（消息重复、`streaming` 状态打架）。
 * C4/C5 之后除了 `chat-store`，还有 04 屏（`/resources`）与 05 屏（`/models`）要用 transport，
 * 所以把「谁创建实例」这件事收口到这里。
 *
 * mock 形态（默认）恒返回 `null` —— 调用方据此走 mock 分支，**默认行为零变化**。
 */

import { getLiveConfig, isLiveEnabled } from "@/lib/feature-flags";
import { HttpAgentTransport, type AgentTransport } from "./agent-transport";

let instance: AgentTransport | null = null;

/** 取 live 传输层；非 live 形态或非浏览器环境返回 null */
export function getLiveTransport(): AgentTransport | null {
  if (typeof window === "undefined" || !isLiveEnabled()) return null;
  if (!instance) instance = new HttpAgentTransport(getLiveConfig());
  return instance;
}
