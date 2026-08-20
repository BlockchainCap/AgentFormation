"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { defaultTab, nextTab, parseTabs } from "./tabs";
import { TerminalPane } from "./terminal-pane";
import type { TerminalTab } from "./types";

interface Props {
  storageScope: string;
}

const subscribeToHydration = () => () => undefined;

function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
}

function ReadyWorkspace({ storageKey }: { storageKey: string }) {
  const initialTabs = useMemo(
    () => parseTabs(localStorage.getItem(storageKey)),
    [storageKey],
  );
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabs);
  const [activeId, setActiveId] = useState(initialTabs[0].id);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(tabs));
  }, [storageKey, tabs]);

  function addTab() {
    const tab = nextTab(tabs);
    if (!tab) return;
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }

  function closeTab(id: string) {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== id);
      const next = remaining.length > 0 ? remaining : [defaultTab()];
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <nav
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-card px-2 py-1"
        aria-label="Terminal tabs"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="flex shrink-0 items-center rounded-md border bg-background"
          >
            <button
              type="button"
              className="px-3 py-1.5 text-xs"
              aria-current={activeId === tab.id ? "page" : undefined}
              onClick={() => setActiveId(tab.id)}
            >
              {tab.label}
            </button>
            <button
              type="button"
              className="p-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => closeTab(tab.id)}
              aria-label={`Close ${tab.label}`}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={addTab}
          disabled={tabs.length >= 6}
          aria-label="Add terminal tab"
        >
          <Plus className="size-4" />
        </Button>
      </nav>
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tmuxSession={tab.tmuxSession}
            active={activeId === tab.id}
          />
        ))}
      </div>
    </div>
  );
}

export function TerminalWorkspace({ storageScope }: Props) {
  const hydrated = useHydrated();
  const storageKey = `agentformation:terminal-tabs:${storageScope}`;
  if (!hydrated) return <div className="h-full bg-neutral-900" />;
  return <ReadyWorkspace key={storageKey} storageKey={storageKey} />;
}
