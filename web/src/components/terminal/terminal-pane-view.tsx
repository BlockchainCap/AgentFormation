"use client";

import type {
  ChangeEventHandler,
  KeyboardEventHandler,
  PointerEventHandler,
  RefObject,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Copy,
  Loader2,
  MousePointer2,
  Paperclip,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DPAD_HEIGHT_PX,
  DPAD_WIDTH_PX,
  QUICK_KEYS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_MAX_COLUMNS,
  TERMINAL_MAX_WIDTH_FACTOR,
  getUploadStatusText,
  type ConnectionState,
  type DpadPosition,
  type PendingAttachment,
  type UploadStatus,
} from "./terminal-shared";

interface TerminalPaneViewProps {
  dpadPosition: DpadPosition | null;
  error: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleChange: ChangeEventHandler<HTMLInputElement>;
  handleDpadButtonPointerDown: PointerEventHandler<HTMLButtonElement>;
  handleDpadPointerCancel: PointerEventHandler<HTMLDivElement>;
  handleDpadPointerDown: PointerEventHandler<HTMLDivElement>;
  handleDpadPointerMove: PointerEventHandler<HTMLDivElement>;
  handleDpadPointerUp: PointerEventHandler<HTMLDivElement>;
  handleFileSelection: ChangeEventHandler<HTMLInputElement>;
  handleKeyDown: KeyboardEventHandler<HTMLInputElement>;
  handleQuickKeyPointerDown: PointerEventHandler<HTMLButtonElement>;
  handleSelectionPointerCancel: PointerEventHandler<HTMLDivElement>;
  handleSelectionPointerDown: PointerEventHandler<HTMLDivElement>;
  handleSelectionPointerMove: PointerEventHandler<HTMLDivElement>;
  handleSelectionPointerUp: PointerEventHandler<HTMLDivElement>;
  handleSubmit: () => void;
  hasTerminalSelection: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  inputValue: string;
  isActive: boolean;
  isConnected: boolean;
  isReviewingHistory: boolean;
  isTextSelectionMode: boolean;
  pendingAttachments: PendingAttachment[];
  copyStatus: "idle" | "copied" | "error";
  copyTerminalSelection: () => void;
  reconnect: () => void;
  removePendingAttachment: (attachmentId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToTerminalBottom: (options?: {
    force?: boolean;
    resetHorizontal?: boolean;
  }) => void;
  state: ConnectionState;
  terminalHeight: number | null;
  termRef: RefObject<HTMLDivElement | null>;
  toggleTextSelectionMode: () => void;
  uploadError: string;
  uploadStatus: UploadStatus;
}

export function TerminalPaneView({
  dpadPosition,
  error,
  fileInputRef,
  handleChange,
  handleDpadButtonPointerDown,
  handleDpadPointerCancel,
  handleDpadPointerDown,
  handleDpadPointerMove,
  handleDpadPointerUp,
  handleFileSelection,
  handleKeyDown,
  handleQuickKeyPointerDown,
  handleSelectionPointerCancel,
  handleSelectionPointerDown,
  handleSelectionPointerMove,
  handleSelectionPointerUp,
  handleSubmit,
  hasTerminalSelection,
  inputRef,
  inputValue,
  isActive,
  isConnected,
  isReviewingHistory,
  isTextSelectionMode,
  pendingAttachments,
  copyStatus,
  copyTerminalSelection,
  reconnect,
  removePendingAttachment,
  scrollRef,
  scrollToTerminalBottom,
  state,
  terminalHeight,
  termRef,
  toggleTextSelectionMode,
  uploadError,
  uploadStatus,
}: TerminalPaneViewProps) {
  const keyBtnClass = cn(
    "rounded-md border border-border bg-secondary px-2 py-1",
    "text-[11px] font-medium text-secondary-foreground",
    "active:bg-accent active:text-accent-foreground active:border-accent",
    "transition-colors disabled:cursor-not-allowed disabled:opacity-45",
  );
  const dpadButtonClass = cn(
    keyBtnClass,
    "flex size-[30px] items-center justify-center p-0",
    "border-white/25 bg-background/45 shadow-sm backdrop-blur-md",
    "supports-[backdrop-filter]:bg-background/30",
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Terminal area */}
      <div
        ref={scrollRef}
        className="terminal-touch-pane no-scrollbar relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-contain"
        style={{ touchAction: "none" }}
      >
        <div className="relative p-2">
          <div
            ref={termRef}
            className={cn("overflow-hidden", !isConnected && "invisible")}
            style={{
              height: terminalHeight ? `${terminalHeight}px` : "100%",
              fontFamily: TERMINAL_FONT_FAMILY,
              fontSize: `${TERMINAL_FONT_SIZE}px`,
              lineHeight: TERMINAL_LINE_HEIGHT,
              minWidth: "100%",
              width: `min(${TERMINAL_MAX_COLUMNS}ch, ${TERMINAL_MAX_WIDTH_FACTOR * 100}%)`,
            }}
          />
          {isConnected && isTextSelectionMode && (
            <div
              className="absolute inset-2 z-10 cursor-text touch-none"
              onPointerDown={handleSelectionPointerDown}
              onPointerMove={handleSelectionPointerMove}
              onPointerUp={handleSelectionPointerUp}
              onPointerCancel={handleSelectionPointerCancel}
              title="Drag to highlight terminal text"
            />
          )}
        </div>
      </div>

      {isConnected && isTextSelectionMode && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <p className="rounded-full border border-border/70 bg-background/90 px-3 py-1 text-[10px] text-foreground shadow-lg backdrop-blur-md">
            Drag over terminal text, then press Cmd+C or choose Copy.
          </p>
        </div>
      )}

      {isConnected && isReviewingHistory && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(
              "pointer-events-auto rounded-full border border-border/70",
              "bg-background/85 px-3 text-xs shadow-xl backdrop-blur-md",
              "supports-[backdrop-filter]:bg-background/70",
            )}
            onClick={() =>
              scrollToTerminalBottom({ force: true, resetHorizontal: true })
            }
          >
            Back to latest
          </Button>
        </div>
      )}

      {/* Overlay for non-connected states */}
      {!isConnected && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background px-6">
          {state === "error" ? (
            <>
              <TerminalIcon className="size-8 text-muted-foreground" />
              <p className="text-sm text-destructive">{error}</p>
              <Button onClick={reconnect} variant="outline" size="sm">
                Reconnect
              </Button>
            </>
          ) : (
            <>
              <Loader2 className="size-6 animate-spin text-accent" />
              <p className="text-sm text-muted-foreground">
                {state === "resuming"
                  ? "Resuming terminal session..."
                  : state === "idle"
                    ? "Connecting..."
                    : "Starting terminal session..."}
              </p>
            </>
          )}
        </div>
      )}

      {/* Arrow d-pad — floats over terminal, bottom-right */}
      {isActive && isConnected && !isTextSelectionMode && dpadPosition && (
        <div
          onPointerDown={handleDpadPointerDown}
          onPointerMove={handleDpadPointerMove}
          onPointerUp={handleDpadPointerUp}
          onPointerCancel={handleDpadPointerCancel}
          className={cn(
            "fixed z-20 grid touch-none select-none grid-cols-3 gap-0.5 rounded-lg",
            "border border-white/20 bg-background/25 p-1 shadow-2xl",
            "backdrop-blur-xl backdrop-saturate-150",
            "supports-[backdrop-filter]:bg-background/15",
          )}
          style={{
            left: dpadPosition.x,
            top: dpadPosition.y,
            width: DPAD_WIDTH_PX,
            height: DPAD_HEIGHT_PX,
          }}
          aria-label="Draggable arrow keys"
        >
          <div aria-hidden="true" className="cursor-move" />
          <button
            type="button"
            data-seq={"\x1b[A"}
            onPointerDown={handleDpadButtonPointerDown}
            className={dpadButtonClass}
            aria-label="Arrow up"
          >
            <ArrowUp className="size-4" />
          </button>
          <div aria-hidden="true" className="cursor-move" />
          <button
            type="button"
            data-seq={"\x1b[D"}
            onPointerDown={handleDpadButtonPointerDown}
            className={dpadButtonClass}
            aria-label="Arrow left"
          >
            <ArrowLeft className="size-4" />
          </button>
          <button
            type="button"
            data-seq={"\x1b[B"}
            onPointerDown={handleDpadButtonPointerDown}
            className={dpadButtonClass}
            aria-label="Arrow down"
          >
            <ArrowDown className="size-4" />
          </button>
          <button
            type="button"
            data-seq={"\x1b[C"}
            onPointerDown={handleDpadButtonPointerDown}
            className={dpadButtonClass}
            aria-label="Arrow right"
          >
            <ArrowRight className="size-4" />
          </button>
        </div>
      )}

      {/* Bottom bar */}
      <div
        className={cn(
          "shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]",
          !isConnected && "pointer-events-none invisible",
        )}
        aria-hidden={!isConnected}
      >
        {/* Quick keys */}
        <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
          {QUICK_KEYS.map((k) => (
            <button
              key={k.label}
              data-action={k.action}
              data-seq={k.seq}
              onPointerDown={handleQuickKeyPointerDown}
              className={keyBtnClass}
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            onClick={toggleTextSelectionMode}
            aria-pressed={isTextSelectionMode}
            className={cn(
              keyBtnClass,
              "inline-flex w-[6.75rem] items-center justify-center gap-1",
              isTextSelectionMode &&
                "border-accent bg-accent text-accent-foreground",
            )}
          >
            <MousePointer2 className="size-3" />
            {isTextSelectionMode ? "Selecting" : "Select text"}
          </button>
          <button
            type="button"
            onClick={copyTerminalSelection}
            disabled={!hasTerminalSelection}
            aria-label="Copy selected terminal text"
            aria-live="polite"
            className={cn(
              keyBtnClass,
              "inline-flex w-[5.5rem] items-center justify-center gap-1",
              copyStatus === "copied" &&
                "border-emerald-500/60 text-emerald-600 dark:text-emerald-400",
              copyStatus === "error" && "border-destructive text-destructive",
            )}
          >
            <Copy className="size-3" />
            {copyStatus === "copied"
              ? "Copied"
              : copyStatus === "error"
                ? "Try again"
                : "Copy"}
          </button>
        </div>

        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1">
            {pendingAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border",
                  "bg-background px-2 py-1 text-[11px] text-foreground",
                )}
              >
                <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-[12rem] truncate">
                  {attachment.filename}
                </span>
                <button
                  type="button"
                  onClick={() => removePendingAttachment(attachment.id)}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Remove ${attachment.filename}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input composer */}
        <div className="flex items-center gap-2 px-2 pb-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelection}
            aria-label="Upload file"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadStatus.state !== "idle"}
            aria-label="Upload file"
            className="shrink-0"
          >
            {uploadStatus.state === "idle" ? (
              <Paperclip className="size-4" />
            ) : (
              <Loader2 className="size-4 animate-spin" />
            )}
          </Button>
          <input
            ref={inputRef}
            type="text"
            enterKeyHint="done"
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Paste or type here — keystrokes go live..."
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn(
              "min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2.5",
              "text-sm text-foreground placeholder:text-muted-foreground",
              "focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30",
              "transition-colors",
            )}
          />
          <Button
            type="button"
            onClick={handleSubmit}
            aria-label="Submit"
            className="shrink-0 px-4 py-2.5"
          >
            <CornerDownLeft className="size-4" />
            Enter
          </Button>
        </div>
        {(uploadStatus.state !== "idle" || uploadError) && (
          <div
            role={uploadError ? "alert" : "status"}
            className={cn(
              "px-2 pb-2 text-[11px]",
              uploadError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {getUploadStatusText(uploadStatus, uploadError)}
          </div>
        )}
      </div>
    </div>
  );
}
