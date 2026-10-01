/**
 * Pi Workbench 预加载脚本 —— 无边框窗口的窗口控制通道。
 *
 * 背景：主进程改 `frame: false` 后原生标题栏（最小化/最大化/关闭）消失，
 * 由 UI 自绘标题栏（packages/ui 的 TitleBar）承担。渲染层不能直接操作
 * BrowserWindow，全部经这里暴露的方法走 IPC。
 *
 * sandbox: true 下可用：contextBridge 与 ipcRenderer 属于 sandbox preload
 * 的可用子集，无需关闭沙箱。
 */

import { contextBridge, ipcRenderer } from "electron";

/** 窗口控制 API 的形状（UI 侧同构声明在 packages/ui/src/vite-env.d.ts） */
export interface PiWorkbenchApi {
	minimize(): void;
	toggleMaximize(): void;
	close(): void;
	isMaximized(): Promise<boolean>;
	/** 订阅最大化状态变化；返回取消订阅函数 */
	onMaximizeChange(listener: (maximized: boolean) => void): () => void;
}

contextBridge.exposeInMainWorld("piWorkbench", {
	minimize: () => ipcRenderer.send("window:minimize"),
	toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
	close: () => ipcRenderer.send("window:close"),
	isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
	onMaximizeChange: (listener: (maximized: boolean) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
		ipcRenderer.on("window:maximize-change", handler);
		return () => {
			ipcRenderer.removeListener("window:maximize-change", handler);
		};
	},
} satisfies PiWorkbenchApi);
