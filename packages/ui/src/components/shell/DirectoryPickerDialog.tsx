import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, Folder, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Button, Dialog, IconButton } from "@/components/primitives";
import { DIR_PICKER_HEIGHT, DIR_PICKER_WIDTH, POPOVER_Z } from "@/lib/layout";
import { getLiveTransport } from "@/services/live-transport";
import type { DirListResult } from "@/services/agent-transport";

/**
 * 目录选择弹窗（dir-picker 批次，task-dir-picker.md §4.3）——「自定义路径…」的数据源。
 *
 * ## 两种模式（D2，诚实于形态）
 *
 * - **browse**（live）：core 出 `GET /fs/list` 只读列子目录，UI 浏览 + 确认；
 *   打开时 `listDirs(null)`，**起始目录由 core 决定**（D6：当前 cwd，UI 不猜）。
 * - **manual**（mock）：mock 没有 core 列不了目录，退化为纯手输路径 ——
 *   不假装有列表（「看着能点」是本项目明令避免的陷阱，同 dir-menu 批次哑按钮先例）。
 *
 * ## 选择语义（D8，零新增）
 *
 * 确认 = 选**当前解析路径**（browse）或手输路径（manual），回调给调用方走既有
 * `chooseDir`（live 热切换 / mock 写偏好）——信任门、409、最近目录全部复用既有链路。
 *
 * ## 失败语义（诚实原则）
 *
 * 转到失败（core 400/403）时**错误文案原样透出**（switchCwd 同款手法，transport 层负责），
 * 且 **current/entries 保持原值** —— 输入的路径没打开，确认仍作用于还开着的目录。
 * 绝不把失败伪装成「空目录」（`dir-picker-empty` 与 `dir-picker-error` 是两个互斥事实）。
 *
 * ## 竞态
 *
 * 快速连点 / 转到时用序号守卫：仅**最后一次**请求的结果落状态，晚到的旧响应直接丢弃 ——
 * 「加载中禁点」挡不住已发出的旧响应，序号守卫才是完整闭合。
 */

export interface DirectoryPickerDialogProps {
  /** 受控开关（Dialog 关闭态 inert + 透明常驻 DOM，本组件不卸载） */
  open: boolean;
  /** 关闭回调（Esc / 点击遮罩 / 取消） */
  onClose: () => void;
  /** 确认回调：browse = 当前解析路径；manual = 手输路径（trim 后） */
  onConfirm: (path: string) => void;
  /** browse = live（core 浏览）；manual = mock（纯手输，D2） */
  mode: "browse" | "manual";
}

/** 与 screens/settings/form-fields 的 INPUT_CLASS 同款（不跨层 import，复制即文档） */
const DIR_INPUT_CLASS =
  "w-full min-w-0 h-8 rounded-md border border-border-default bg-bg-surface px-2 font-mono text-xs text-text-primary " +
  "placeholder:text-text-tertiary transition-colors duration-150 ease-out " +
  "hover:border-border-strong focus:border-accent focus:outline-none";

const ENTRY_CLASS = cn(
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left",
  "transition-colors duration-150 hover:bg-bg-hover focus:bg-bg-hover",
  "disabled:opacity-50",
);

const DRIVE_CHIP_CLASS = cn(
  "rounded-md border border-border-default bg-bg-surface px-2.5 py-1 font-mono text-xs text-text-secondary",
  "transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary",
  "disabled:opacity-50",
);

export function DirectoryPickerDialog({ open, onClose, onConfirm, mode }: DirectoryPickerDialogProps) {
  const [input, setInput] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirListResult["entries"]>([]);
  const [drives, setDrives] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 竞态守卫：只认最后一次发出的请求 */
  const seqRef = useRef(0);

  const navigate = useCallback(async (target: string | null) => {
    const transport = getLiveTransport();
    if (!transport) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await transport.listDirs(target);
      if (seq !== seqRef.current) return;
      setCurrent(r.path);
      setParent(r.parent);
      setEntries(r.entries);
      setDrives(r.drives);
      setTruncated(r.truncated);
      // 归一化后的绝对路径回显：用户当场看到自己输入被解析成了什么
      setInput(r.path);
    } catch (e) {
      if (seq !== seqRef.current) return;
      // current/entries 保持原值：输入的路径没打开，确认仍作用于还开着的目录
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  /* 打开即重置：browse 直连 core 起始目录（D6）；manual 清空上次输入 */
  useEffect(() => {
    if (!open) return;
    if (mode === "browse") {
      void navigate(null);
    } else {
      setInput("");
    }
  }, [open, mode, navigate]);

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // IME 合成中的回车是选字，不是「转到」（中文输入法打路径的高频误触点）
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!loading && input.trim().length > 0) void navigate(input);
    }
  }

  const manualPath = input.trim();
  const confirmPath = mode === "browse" ? current : manualPath.length > 0 ? manualPath : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="选择目录"
      width={DIR_PICKER_WIDTH}
      height={DIR_PICKER_HEIGHT}
      zIndex={POPOVER_Z}
      testId="dir-picker"
      header={
        <div className="flex h-12 shrink-0 items-center border-b border-border-subtle px-5">
          <h2 className="text-sm font-semibold text-text-primary">选择目录</h2>
        </div>
      }
      footer={
        <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5">
          <Button variant="secondary" size="sm" data-testid="dir-picker-cancel" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="dir-picker-confirm"
            disabled={!confirmPath || loading}
            onClick={() => confirmPath && onConfirm(confirmPath)}
          >
            选择此文件夹
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        {/* 工具行：上一级 / 路径输入 / 转到（manual 模式同样可用——手输就是这个模式的全部） */}
        <div className="flex shrink-0 items-center gap-2">
          <IconButton
            icon={ArrowUp}
            label="上一级"
            testId="dir-picker-parent"
            disabled={mode !== "browse" || !parent || loading}
            onClick={() => parent && void navigate(parent)}
          />
          <input
            data-testid="dir-picker-input"
            className={DIR_INPUT_CLASS}
            value={input}
            placeholder="输入目录路径，或从下方列表选择"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <Button
            variant="secondary"
            size="sm"
            data-testid="dir-picker-go"
            disabled={loading || input.trim().length === 0}
            onClick={() => void navigate(input)}
          >
            转到
          </Button>
        </div>

        {mode === "manual" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <p
              data-testid="dir-picker-manual-hint"
              className="px-6 text-center text-sm text-text-tertiary"
            >
              当前形态未连接 core，无法浏览目录；输入完整路径后确认。
            </p>
          </div>
        ) : loading ? (
          <div
            data-testid="dir-picker-loading"
            className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-text-tertiary"
          >
            <Icon icon={Loader2} size={14} className="animate-spin" />
            正在读取…
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p data-testid="dir-picker-error" className="mb-2 text-sm text-danger" title={error}>
                {error}
              </p>
            ) : null}

            {entries.length === 0 && !error ? (
              <p data-testid="dir-picker-empty" className="py-8 text-center text-sm text-text-tertiary">
                此目录下没有子目录
              </p>
            ) : null}

            {entries.length > 0 ? (
              <>
                {/* 盘符行：仅处于根目录（无法再上一级、唯一需要换盘的时刻）时出现（D5） */}
                {parent === null && drives && drives.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {drives.map((d) => (
                      <button
                        key={d}
                        type="button"
                        data-testid={`dir-picker-drive-${d.replace(/[:\\]+$/, "")}`}
                        title={`切换到盘 ${d}`}
                        disabled={loading}
                        onClick={() => void navigate(d)}
                        className={DRIVE_CHIP_CLASS}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div data-testid="dir-picker-list">
                  {entries.map((entry, index) => (
                    <button
                      key={entry.path}
                      type="button"
                      data-testid={`dir-picker-entry-${index}`}
                      title={entry.path}
                      disabled={loading}
                      onClick={() => void navigate(entry.path)}
                      className={ENTRY_CLASS}
                    >
                      <Icon icon={Folder} size={14} className="shrink-0 text-text-tertiary" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                        {entry.name}
                      </span>
                    </button>
                  ))}
                </div>

                {truncated ? (
                  <p data-testid="dir-picker-truncated" className="mt-2 text-xs text-text-tertiary">
                    子目录过多，仅显示前 500 个
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </div>
    </Dialog>
  );
}
