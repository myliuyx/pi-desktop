/**
 * 流式模拟器 —— 纯前端原型用，不接任何 LLM。
 *
 * 为什么单独成文件：sendMessage 的「打字机」行为本质上是把一段文本按时间切片吐出，
 * 与 store 的副作用逻辑解耦后更好测、也好换（将来接真 Pi 事件流时只替换这里）。
 *
 * 总时长约束（验收 2-5 要求 ≤ 2 秒）：根据文本长度反推每帧步长，保证
 * 帧数 ≤ 2000 / tickMs，从而整段流式总时长可控。
 */

export interface StreamHandle {
  /** 立即中止（已产出的内容定格，不再继续） */
  abort: () => void;
}

export interface SimulateStreamOptions {
  /** 完整文本 */
  text: string;
  /** 每帧间隔（ms），通常取自 STREAM_TICK_MS */
  tickMs: number;
  /** 每帧产出部分文本时回调（partial 是已累积的前缀） */
  onChunk: (partial: string) => void;
  /** 全部产出完毕回调 */
  onDone: () => void;
}

/**
 * 启动一次模拟流式输出。
 * 步长 = ceil(len / 目标帧数)，目标帧数 = floor(2000 / tickMs)，保证总时长 ≤ 2s。
 */
export function simulateStream(opts: SimulateStreamOptions): StreamHandle {
  const total = opts.text.length;
  if (total === 0) {
    opts.onChunk("");
    opts.onDone();
    return { abort: () => {} };
  }
  const targetFrames = Math.max(1, Math.floor(2000 / opts.tickMs));
  const step = Math.max(1, Math.ceil(total / targetFrames));

  let cursor = 0;
  const timer = setInterval(() => {
    cursor = Math.min(total, cursor + step);
    opts.onChunk(opts.text.slice(0, cursor));
    if (cursor >= total) {
      clearInterval(timer);
      opts.onDone();
    }
  }, opts.tickMs);

  return { abort: () => clearInterval(timer) };
}
