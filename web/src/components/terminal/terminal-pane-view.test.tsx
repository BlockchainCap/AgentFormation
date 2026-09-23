import { createRef, type PointerEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPaneView } from "./terminal-pane-view";

function renderConnectedPane() {
  const handleDpadButtonPointerDown = vi.fn();
  const quickKeySequences: string[] = [];
  const handleQuickKeyPointerDown = vi.fn(
    (event: PointerEvent<HTMLButtonElement>) => {
      quickKeySequences.push(event.currentTarget.dataset.seq ?? "");
    },
  );

  render(
    <TerminalPaneView
      dpadPosition={{ x: 24, y: 24 }}
      error=""
      fileInputRef={createRef<HTMLInputElement>()}
      handleChange={vi.fn()}
      handleDpadButtonPointerDown={handleDpadButtonPointerDown}
      handleDpadPointerCancel={vi.fn()}
      handleDpadPointerDown={vi.fn()}
      handleDpadPointerMove={vi.fn()}
      handleDpadPointerUp={vi.fn()}
      handleFileSelection={vi.fn()}
      handleKeyDown={vi.fn()}
      handleQuickKeyPointerDown={handleQuickKeyPointerDown}
      handleSelectionPointerCancel={vi.fn()}
      handleSelectionPointerDown={vi.fn()}
      handleSelectionPointerMove={vi.fn()}
      handleSelectionPointerUp={vi.fn()}
      handleSubmit={vi.fn()}
      hasTerminalSelection={false}
      inputRef={createRef<HTMLInputElement>()}
      inputValue="draft"
      isActive
      isConnected
      isReviewingHistory={false}
      isTextSelectionMode={false}
      pendingAttachments={[]}
      copyStatus="idle"
      copyTerminalSelection={vi.fn()}
      reconnect={vi.fn()}
      removePendingAttachment={vi.fn()}
      scrollRef={createRef<HTMLDivElement>()}
      scrollToTerminalBottom={vi.fn()}
      state="connected"
      terminalHeight={300}
      termRef={createRef<HTMLDivElement>()}
      toggleTextSelectionMode={vi.fn()}
      uploadError=""
      uploadStatus={{ state: "idle" }}
    />,
  );

  return {
    handleDpadButtonPointerDown,
    handleQuickKeyPointerDown,
    quickKeySequences,
  };
}

describe("TerminalPaneView main interaction baseline", () => {
  afterEach(cleanup);

  it("keeps the live input enabled and labels its action Enter", () => {
    renderConnectedPane();

    expect(
      screen.getByPlaceholderText("Paste or type here — keystrokes go live..."),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit" })).toHaveTextContent(
      "Enter",
    );
  });

  it("sends quick keys and arrow keys on pointer down", () => {
    const { handleDpadButtonPointerDown, handleQuickKeyPointerDown } =
      renderConnectedPane();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Arrow up" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Ctrl+C" }));

    expect(handleDpadButtonPointerDown).toHaveBeenCalledOnce();
    expect(handleQuickKeyPointerDown).toHaveBeenCalledOnce();
  });

  it("exposes the Codex queued-message shortcut on touch screens", () => {
    const { quickKeySequences } = renderConnectedPane();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Edit queued" }));
    expect(quickKeySequences).toEqual(["\x1b[1;2D"]);
  });
});
