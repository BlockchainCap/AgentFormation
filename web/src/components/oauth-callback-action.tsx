"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type OAuthStatus = { kind: "idle" | "success" | "error"; message: string };

export function OAuthCallbackAction() {
  const [open, setOpen] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [status, setStatus] = useState<OAuthStatus>({
    kind: "idle",
    message: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;

    const focusId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setStatus({ kind: "idle", message: "" });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusId);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const submitOAuthCallback = useCallback(async () => {
    const trimmedCallbackUrl = callbackUrl.trim();
    if (!trimmedCallbackUrl) {
      setStatus({
        kind: "error",
        message: "Paste the failed localhost callback URL first.",
      });
      return;
    }

    setSubmitting(true);
    setStatus({ kind: "idle", message: "" });

    try {
      const response = await fetch("/api/oauth/loopback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ callbackUrl: trimmedCallbackUrl }),
      });
      const body = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }

      setCallbackUrl("");
      setStatus({
        kind: "success",
        message:
          "Callback delivered. Return to the terminal to finish sign-in.",
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to deliver OAuth callback.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [callbackUrl]);

  const close = useCallback(() => {
    setOpen(false);
    setStatus({ kind: "idle", message: "" });
  }, []);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Complete remote OAuth login"
        title="Complete remote OAuth login"
        className="gap-1.5 px-2 text-xs text-muted-foreground"
      >
        <Link2 className="size-3.5" />
        <span className="hidden sm:inline">Finish login</span>
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)] md:items-center md:justify-center md:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="oauth-callback-title"
        >
          <div className="w-full rounded-xl border border-border bg-background p-3 shadow-lg md:max-w-lg">
            <div className="mb-3 space-y-1">
              <h2
                id="oauth-callback-title"
                className="text-sm font-semibold text-foreground"
              >
                Complete remote login
              </h2>
              <p className="text-xs text-muted-foreground">
                Seeing <strong>127.0.0.1 refused to connect</strong> is
                expected: the login listener is inside your private runtime, not
                on this device.
              </p>
              <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>
                  Copy the complete URL from the failed page&apos;s address bar.
                </li>
                <li>Return to this AgentFormation tab and paste it below.</li>
                <li>Send it while the remote tool is still waiting.</li>
              </ol>
            </div>

            <textarea
              ref={textareaRef}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://127.0.0.1:46189/callback/request-id?code=...&state=..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={4}
              className={cn(
                "mb-3 w-full resize-none rounded-md border border-input bg-card px-2 py-2",
                "text-xs text-foreground placeholder:text-muted-foreground",
                "focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30",
              )}
            />

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                onClick={close}
                variant="ghost"
                size="sm"
                disabled={submitting}
              >
                Close
              </Button>
              <Button
                type="button"
                onClick={submitOAuthCallback}
                disabled={submitting}
                size="sm"
              >
                {submitting ? "Sending..." : "Send to runtime"}
              </Button>
            </div>

            {status.message && (
              <p
                className={cn(
                  "mt-3 text-xs",
                  status.kind === "success"
                    ? "text-green-600 dark:text-green-400"
                    : "text-destructive",
                )}
              >
                {status.message}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
