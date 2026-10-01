/// <reference types="vite/client" />

/**
 * 桌面壳（Electron preload，packages/desktop/src/preload.ts）暴露的窗口控制 API。
 *
 * 无边框窗口（frame:false）的最小化 / 最大化 / 关闭唯一出入口。
 * web / mock 形态下不存在（undefined）—— TitleBar 的窗口控件退化为装饰件，
 * 点击无操作，DOM 与几何与改造前一致。
 */
interface Window {
  piWorkbench?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(listener: (maximized: boolean) => void): () => void;
  };
}
