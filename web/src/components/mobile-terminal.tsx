"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TerminalPane } from "@/components/terminal/terminal-pane";
import {
  TerminalTab,
  MobileTerminalProps,
  RECENT_CLOSED_TABS_LIMIT,
  createTerminalTab,
  loadStoredTerminalState,
  useHydrated,
} from "@/components/terminal/terminal-shared";

function ReadyMobileTerminal({ storageKey }: { storageKey: string }) {
  const [initialState] = useState(() => loadStoredTerminalState(storageKey));
  const [tabs, setTabs] = useState<TerminalTab[]>(initialState.tabs);
  const [closedTabs, setClosedTabs] = useState<TerminalTab[]>(
    initialState.closedTabs,
  );
  const [activeTabId, setActiveTabId] = useState(initialState.activeTabId);
  const [nextTabIndex, setNextTabIndex] = useState(initialState.nextTabIndex);
  const [mountedTabIds, setMountedTabIds] = useState<string[]>(
    initialState.mountedTabIds,
  );
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );
  const [showNewTabChooser, setShowNewTabChooser] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const newTabDraftRef = useRef<{
    tabId: string;
    previousActiveTabId: string;
  } | null>(null);
  const longPressTimeoutRef = useRef<number | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );
  const mountedTabIdSet = useMemo(
    () => new Set(mountedTabIds),
    [mountedTabIds],
  );
  const pendingCloseTab = useMemo(
    () => tabs.find((tab) => tab.id === pendingCloseTabId) ?? null,
    [pendingCloseTabId, tabs],
  );
  const renamingTab = useMemo(
    () => tabs.find((tab) => tab.id === renamingTabId) ?? null,
    [renamingTabId, tabs],
  );

  useEffect(() => {
    if (!activeTab) return;

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        activeTabId: activeTab.id,
        closedTabs,
        nextTabIndex,
        tabs,
      }),
    );
  }, [activeTab, closedTabs, nextTabIndex, storageKey, tabs]);

  const createFreshTab = useCallback(() => {
    const nextTab = createTerminalTab(nextTabIndex);
    setTabs([...tabs, nextTab]);
    setNextTabIndex(nextTabIndex + 1);
    setMountedTabIds((currentIds) => [...currentIds, nextTab.id]);
    newTabDraftRef.current = {
      tabId: nextTab.id,
      previousActiveTabId: activeTab.id,
    };
    setActiveTabId(nextTab.id);
    setShowNewTabChooser(false);
    setRenamingTabId(nextTab.id);
    setRenameValue(nextTab.label);
  }, [activeTab.id, nextTabIndex, tabs]);

  const addTab = useCallback(() => {
    if (closedTabs.length > 0) {
      setShowNewTabChooser(true);
      return;
    }

    createFreshTab();
  }, [closedTabs.length, createFreshTab]);

  const reopenClosedTab = useCallback(
    (tabId: string) => {
      const tabToReopen = closedTabs.find((tab) => tab.id === tabId);
      if (!tabToReopen) return;

      setClosedTabs(closedTabs.filter((tab) => tab.id !== tabId));
      setTabs([...tabs, tabToReopen]);
      setMountedTabIds((currentIds) =>
        currentIds.includes(tabId) ? currentIds : [...currentIds, tabId],
      );
      setActiveTabId(tabId);
      setShowNewTabChooser(false);
    },
    [closedTabs, tabs],
  );

  const selectTab = useCallback((tabId: string) => {
    setMountedTabIds((currentIds) =>
      currentIds.includes(tabId) ? currentIds : [...currentIds, tabId],
    );
    setActiveTabId(tabId);
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      if (tabs.length === 1) return;

      const closingTab = tabs.find((tab) => tab.id === tabId);
      if (!closingTab) return;

      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      const nextActiveIndex = Math.max(0, closingIndex - 1);
      const nextActiveTabId =
        activeTabId === tabId
          ? (nextTabs[nextActiveIndex]?.id ?? nextTabs[0].id)
          : activeTabId;

      setTabs(nextTabs);
      setClosedTabs((currentClosedTabs) =>
        [
          closingTab,
          ...currentClosedTabs.filter((tab) => tab.id !== closingTab.id),
        ].slice(0, RECENT_CLOSED_TABS_LIMIT),
      );
      setMountedTabIds((currentIds) => {
        const nextMountedIds = currentIds.filter((id) => id !== tabId);
        return nextMountedIds.includes(nextActiveTabId)
          ? nextMountedIds
          : [...nextMountedIds, nextActiveTabId];
      });
      setPendingCloseTabId(null);

      if (activeTabId === tabId) {
        setActiveTabId(nextActiveTabId);
      }
    },
    [activeTabId, tabs],
  );

  const requestCloseTab = useCallback(
    (tabId: string) => {
      if (tabs.length === 1) return;
      setPendingCloseTabId(tabId);
    },
    [tabs.length],
  );

  const clearLongPressTimeout = useCallback(() => {
    if (longPressTimeoutRef.current === null) return;

    window.clearTimeout(longPressTimeoutRef.current);
    longPressTimeoutRef.current = null;
  }, []);

  const beginRenameTab = useCallback(
    (tab: TerminalTab) => {
      clearLongPressTimeout();
      setRenamingTabId(tab.id);
      setRenameValue(tab.label);
    },
    [clearLongPressTimeout],
  );

  const handleTabPointerDown = useCallback(
    (tab: TerminalTab) => {
      clearLongPressTimeout();
      longPressTimeoutRef.current = window.setTimeout(() => {
        beginRenameTab(tab);
      }, 550);
    },
    [beginRenameTab, clearLongPressTimeout],
  );

  const saveRename = useCallback(() => {
    if (!renamingTab) return;

    const nextLabel = renameValue.trim().slice(0, 24);
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === renamingTab.id
          ? { ...tab, label: nextLabel || tab.tmuxSession }
          : tab,
      ),
    );
    newTabDraftRef.current = null;
    setRenamingTabId(null);
    setRenameValue("");
  }, [renameValue, renamingTab]);

  const cancelRename = useCallback(() => {
    const draft = newTabDraftRef.current;
    if (draft?.tabId === renamingTabId) {
      setTabs((currentTabs) =>
        currentTabs.filter((tab) => tab.id !== draft.tabId),
      );
      setMountedTabIds((currentIds) =>
        currentIds.filter((id) => id !== draft.tabId),
      );
      setActiveTabId(draft.previousActiveTabId);
      newTabDraftRef.current = null;
    }

    setRenamingTabId(null);
    setRenameValue("");
  }, [renamingTabId]);

  useEffect(() => clearLongPressTimeout, [clearLongPressTimeout]);

  if (!activeTab) {
    return null;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end gap-1 border-b border-border bg-muted/40 px-2 pt-1.5">
        <div className="no-scrollbar flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            const isMounted = mountedTabIdSet.has(tab.id);

            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-9 max-w-40 shrink-0 items-center rounded-t-lg border border-b-0 text-xs shadow-sm transition-colors",
                  isActive
                    ? "relative -mb-px border-border bg-background text-foreground"
                    : "border-transparent bg-secondary/70 text-muted-foreground active:bg-secondary",
                )}
              >
                <button
                  type="button"
                  onPointerDown={() => handleTabPointerDown(tab)}
                  onPointerUp={clearLongPressTimeout}
                  onPointerCancel={clearLongPressTimeout}
                  onPointerLeave={clearLongPressTimeout}
                  onDoubleClick={() => beginRenameTab(tab)}
                  onClick={() => selectTab(tab.id)}
                  className="min-w-0 flex-1 truncate px-3 py-2 text-left font-medium"
                  aria-current={isActive ? "page" : undefined}
                  title={`${tab.label} (${tab.tmuxSession})`}
                >
                  {tab.label}
                </button>
                <span
                  className={cn(
                    "mr-1 size-1.5 shrink-0 rounded-full",
                    isMounted ? "bg-emerald-500" : "bg-muted-foreground/35",
                  )}
                  aria-hidden="true"
                />
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => requestCloseTab(tab.id)}
                    className={cn(
                      "mr-1 rounded p-1 transition-colors",
                      isActive
                        ? "text-muted-foreground active:bg-muted"
                        : "text-muted-foreground/70 active:bg-secondary",
                    )}
                    aria-label={`Close ${tab.label}`}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={addTab}
          aria-label="New terminal tab"
          title="New terminal tab"
          className="mb-1 size-7 shrink-0 rounded-full"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          if (!mountedTabIdSet.has(tab.id)) return null;

          const isActive = tab.id === activeTab.id;

          return (
            <div
              key={tab.id}
              className={cn("absolute inset-0", !isActive && "hidden")}
              aria-hidden={!isActive}
            >
              <TerminalPane tmuxSession={tab.tmuxSession} isActive={isActive} />
            </div>
          );
        })}
      </div>

      {showNewTabChooser && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 px-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-terminal-tab-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl">
            <div className="space-y-2">
              <h2
                id="new-terminal-tab-title"
                className="text-sm font-semibold text-foreground"
              >
                Open Terminal Tab
              </h2>
              <p className="text-xs leading-5 text-muted-foreground">
                Create a fresh tmux session, or reopen one of your 20 most
                recently closed tabs.
              </p>
            </div>
            <div className="mt-4 space-y-3">
              <Button type="button" className="w-full" onClick={createFreshTab}>
                Create New Tab
              </Button>

              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recently Closed
                </p>
                {closedTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => reopenClosedTab(tab.id)}
                    className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-left active:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {tab.label}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        tmux: {tab.tmuxSession}
                      </span>
                    </span>
                    <span className="text-xs text-accent">Reopen</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowNewTabChooser(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {renamingTab && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 px-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-terminal-tab-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl">
            <div className="space-y-2">
              <h2
                id="rename-terminal-tab-title"
                className="text-sm font-semibold text-foreground"
              >
                Rename Tab
              </h2>
              <p className="text-xs leading-5 text-muted-foreground">
                Friendly labels help you remember what is happening in each tab.
                The tmux session stays `{renamingTab.tmuxSession}`.
              </p>
              <input
                type="text"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveRename();
                  }
                  if (event.key === "Escape") {
                    cancelRename();
                  }
                }}
                autoFocus
                maxLength={24}
                className={cn(
                  "mt-2 w-full rounded-lg border border-input bg-background px-3 py-2",
                  "text-sm text-foreground placeholder:text-muted-foreground",
                  "focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30",
                )}
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancelRename}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={saveRename}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {pendingCloseTab && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 px-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-terminal-tab-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl">
            <div className="space-y-2">
              <h2
                id="close-terminal-tab-title"
                className="text-sm font-semibold text-foreground"
              >
                Close {pendingCloseTab.label}?
              </h2>
              <p className="text-xs leading-5 text-muted-foreground">
                This closes the browser connection for this tab. The tmux
                session `{pendingCloseTab.tmuxSession}` will keep running on the
                AWS runtime and can be reopened from the plus button.
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPendingCloseTabId(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => closeTab(pendingCloseTab.id)}
              >
                Close Tab
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function MobileTerminal({ storageScope }: MobileTerminalProps) {
  const hydrated = useHydrated();
  const storageKey = `mobile-terminal-tabs:${storageScope}`;
  if (!hydrated) return <div className="h-full bg-background" />;
  return <ReadyMobileTerminal key={storageKey} storageKey={storageKey} />;
}
