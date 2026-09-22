import { useEffect, useState } from "react";

/**
 * 侦测系统是否开启「减少动态效果」。
 *
 * 为什么要侦测而不是只用 CSS 的 `motion-reduce:` 变体：
 * Tailwind 的 `motion-reduce:transition-none` 生成的是
 * `@media (prefers-reduced-motion: reduce) { transition-property: none }`，
 * 它会把过渡**整个取消**。本项目验收项 1-10 / G8 要求折叠「有过渡、非瞬间跳变」，
 * 二者直接冲突。
 *
 * 正确的调和方式是「缩短时长」而不是「取消过渡」，而时长是内联 style 里算出来的，
 * CSS 变体改不到，所以需要 JS 侧知道这个偏好。
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function readPreference(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(readPreference);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);
    // addEventListener 在旧 Safari 上不存在，沿用 store 里同样的可选链写法
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  return prefersReduced;
}
