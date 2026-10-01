/**
 * 斜杠命令触发区间检测（与 Composer 的 computeAtState 同款手法，前缀换成 `/`）。
 * 光标处 token 以 `/` 开头、且 `/` 前是行首或空白 → 激活命令弹层。
 * 前扫到行首/空白本身保证了「前一个字符是空白」—— 路径 `a/b`、`path/to` 自然排除。
 */

export interface SlashTokenState {
  start: number;
  end: number;
  query: string;
}

export function computeSlashState(value: string, caret: number): SlashTokenState | null {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1] ?? "")) start--;
  const token = value.slice(start, caret);
  if (!token.startsWith("/")) return null;
  return { start, end: caret, query: token.slice(1) };
}