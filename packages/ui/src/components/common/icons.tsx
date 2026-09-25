import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowUp,
  Bell,
  Blocks,
  Bot,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  Code,
  Code2,
  Copy,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  Gauge,
  History,
  Layers,
  Loader2,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Package,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";

export type { LucideIcon };

/** 图标统一尺寸（设计稿 16 viewBox，Lucide 传 size 即可） */
export const ICON_SIZE = 16;

/** 图标固定中性色，不随主题变化（G4） */
export const ICON_COLOR_CLASS = "text-icon-neutral";

export interface IconProps {
  icon: LucideIcon;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ icon: Component, size = ICON_SIZE, className, strokeWidth = 1.75 }: IconProps) {
  return (
    <Component
      size={size}
      strokeWidth={strokeWidth}
      className={cn(ICON_COLOR_CLASS, "shrink-0", className)}
      aria-hidden="true"
    />
  );
}

/** 00 屏图标清单：本项目目前用到的全部图标 */
export const ICON_INVENTORY: Array<{ name: string; icon: LucideIcon }> = [
  { name: "Plus", icon: Plus },
  { name: "Search", icon: Search },
  { name: "History", icon: History },
  { name: "FolderOpen", icon: FolderOpen },
  { name: "PanelLeftClose", icon: PanelLeftClose },
  { name: "PanelRightClose", icon: PanelRightClose },
  { name: "Settings", icon: Settings },
  { name: "Sun", icon: Sun },
  { name: "Moon", icon: Moon },
  { name: "Send", icon: Send },
  { name: "ArrowUp", icon: ArrowUp },
  // M4 新增：三屏页面头的返回入口（原本只有 TokensScreen 直接 import，未进清单）
  { name: "ArrowLeft", icon: ArrowLeft },
  { name: "Terminal", icon: Terminal },
  { name: "Code", icon: Code },
  { name: "FileText", icon: FileText },
  { name: "Check", icon: Check },
  { name: "X", icon: X },
  { name: "ChevronDown", icon: ChevronDown },
  { name: "ChevronRight", icon: ChevronRight },
  { name: "Loader2", icon: Loader2 },
  { name: "TriangleAlert", icon: TriangleAlert },
  { name: "Trash2", icon: Trash2 },
  { name: "Copy", icon: Copy },
  { name: "Pencil", icon: Pencil },
  { name: "Play", icon: Play },
  { name: "RefreshCw", icon: RefreshCw },
  { name: "Clock", icon: Clock },
  { name: "Cpu", icon: Cpu },
  { name: "Database", icon: Database },
  { name: "Gauge", icon: Gauge },
  { name: "Layers", icon: Layers },
  { name: "Package", icon: Package },
  { name: "Blocks", icon: Blocks },
  { name: "Wrench", icon: Wrench },
  { name: "Sparkles", icon: Sparkles },
  { name: "Zap", icon: Zap },
  { name: "Bot", icon: Bot },
  { name: "MessageSquare", icon: MessageSquare },
  { name: "Bookmark", icon: Bookmark },
  { name: "Bell", icon: Bell },
  { name: "MoreHorizontal", icon: MoreHorizontal },
  // 新建会话页（task-new-session-page.md）：三张建议卡的图标
  { name: "Code2", icon: Code2 },
  { name: "CircleCheck", icon: CircleCheck },
  { name: "PenLine", icon: PenLine },
];
