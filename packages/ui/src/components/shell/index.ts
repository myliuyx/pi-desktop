export { WindowShell } from "./WindowShell";
export type { WindowShellProps } from "./WindowShell";

export { TitleBar } from "./TitleBar";
export type { TitleBarProps, OsName } from "./TitleBar";

export { Sidebar } from "./Sidebar";
export type { SidebarProps } from "./Sidebar";

export { SidebarFooter } from "./SidebarFooter";
export type { SidebarFooterProps } from "./SidebarFooter";

export { WorkspaceArea } from "./WorkspaceArea";
export type { WorkspaceAreaProps } from "./WorkspaceArea";

export { PreviewPane } from "./PreviewPane";
export type { PreviewPaneProps } from "./PreviewPane";

// WorkbenchScreen 单独从 ./WorkbenchScreen 引入，不放这里 —— 它依赖本 index 之外的兄弟模块，
// 放进 barrel 会形成 index → WorkbenchScreen → index 的循环导入。
