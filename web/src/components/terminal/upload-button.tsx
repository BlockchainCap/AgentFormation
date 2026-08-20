"use client";

import { useRef, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 50 * 1024 * 1024;

interface Props {
  disabled: boolean;
  onUploaded: (path: string) => void;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Upload failed");
  return body;
}

export function UploadButton({ disabled, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      setError("Files must be 50 MB or smaller.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await responseJson<{
        key: string;
        uploadUrl: string;
      }>(
        await fetch("/api/session/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            filename: file.name,
            contentType: file.type || "application/octet-stream",
            size: file.size,
          }),
        }),
      );
      const put = await fetch(created.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error("Upload to storage failed");
      const completed = await responseJson<{ path: string }>(
        await fetch("/api/session/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "complete", key: created.key }),
        }),
      );
      onUploaded(completed.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        aria-label="Upload a file"
        title="Upload a file"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Paperclip className="size-4" />
        )}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
