"use client";

import { useState } from "react";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadButton } from "./upload-button";
import { useSsmTerminal } from "./use-ssm-terminal";

interface Props {
  active: boolean;
  tmuxSession: string;
}

export function TerminalPane({ active, tmuxSession }: Props) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [input, setInput] = useState("");
  const controller = useSsmTerminal({ container, tmuxSession, active });
  const connected = controller.state === "connected";

  function submit() {
    if (!input || !connected) return;
    void controller.send(`${input}\r`);
    setInput("");
  }

  return (
    <section className={active ? "flex h-full flex-col" : "hidden"}>
      <div className="relative min-h-0 flex-1 bg-neutral-900">
        <div ref={setContainer} className="h-full w-full p-2" />
        {controller.state !== "connected" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-950/80 p-6">
            <div className="space-y-4 text-center">
              {controller.state === "connecting" ? (
                <Loader2 className="mx-auto size-6 animate-spin text-violet-400" />
              ) : null}
              <p className="max-w-sm text-sm text-neutral-300">
                {controller.state === "connecting"
                  ? "Connecting to your runtime…"
                  : controller.error || "Terminal disconnected."}
              </p>
              {controller.state !== "connecting" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void controller.connect()}
                >
                  <RefreshCw className="size-4" /> Reconnect
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t bg-card p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <UploadButton
          disabled={!connected}
          onUploaded={(path) =>
            setInput((value) => `${value}${value ? " " : ""}${path}`)
          }
        />
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          disabled={!connected}
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Type a command or prompt"
          aria-label="Terminal input"
        />
        <Button
          type="button"
          size="icon"
          onClick={submit}
          disabled={!connected || !input}
          aria-label="Send input"
        >
          <Send className="size-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!connected}
          onClick={() => void controller.send("\u0003")}
        >
          Ctrl-C
        </Button>
      </div>
    </section>
  );
}
