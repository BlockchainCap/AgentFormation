"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENTS,
  readUploadCompleteResponse,
  readUploadCreateResponse,
  uploadFileToUrl,
  type PendingAttachment,
  type UploadStatus,
} from "./terminal-api";

interface UseTerminalUploadOptions {
  inputRef: RefObject<HTMLInputElement | null>;
  tmuxSession: string;
}

export function useTerminalUpload({
  inputRef,
  tmuxSession,
}: UseTerminalUploadOptions) {
  const uploadInFlightRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>({
    state: "idle",
  });
  const [uploadError, setUploadError] = useState("");

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      uploadInFlightRef.current = false;
    },
    [],
  );

  const removePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  const resetUploadState = useCallback(() => {
    requestIdRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    uploadInFlightRef.current = false;
    setPendingAttachments([]);
    setUploadStatus({ state: "idle" });
    setUploadError("");
  }, []);

  const handleFileSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || uploadInFlightRef.current) return;

      if (file.size < 1 || file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
        setUploadError("Files must be between 1 byte and 50 MB.");
        return;
      }
      if (
        pendingAttachments.length >= MAX_PENDING_ATTACHMENTS ||
        pendingAttachments.reduce(
          (total, attachment) => total + attachment.fileSize,
          0,
        ) +
          file.size >
          MAX_PENDING_ATTACHMENT_BYTES
      ) {
        setUploadError(
          "Submit or remove pending files before attaching another one.",
        );
        return;
      }

      uploadInFlightRef.current = true;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      requestAbortRef.current?.abort();
      const requestController = new AbortController();
      requestAbortRef.current = requestController;
      setUploadError("");
      setUploadStatus({ state: "uploading", filename: file.name, progress: 0 });

      try {
        const mimeType = file.type || "application/octet-stream";
        const createResponse = await fetch("/api/session/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mimeType,
            fileSize: file.size,
          }),
          signal: requestController.signal,
        });
        const upload = await readUploadCreateResponse(createResponse);
        if (requestId !== requestIdRef.current) return;

        await uploadFileToUrl(
          file,
          upload.uploadUrl,
          upload.formFields,
          (progress) => {
            if (requestId !== requestIdRef.current) return;
            setUploadStatus({
              state: "uploading",
              filename: file.name,
              progress,
            });
          },
          requestController.signal,
        );

        if (requestId !== requestIdRef.current) return;
        setUploadStatus({ state: "completing", filename: file.name });
        const completeResponse = await fetch("/api/session/upload", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: upload.key,
            filename: upload.filename,
            mimeType: upload.mimeType,
            fileSize: upload.fileSize,
            tmuxSession,
          }),
          signal: requestController.signal,
        });
        const completed = await readUploadCompleteResponse(completeResponse);
        if (requestId !== requestIdRef.current) return;

        setPendingAttachments((current) => {
          if (
            current.some((attachment) => attachment.path === completed.path)
          ) {
            return current;
          }
          if (
            current.length >= MAX_PENDING_ATTACHMENTS ||
            current.reduce(
              (total, attachment) => total + attachment.fileSize,
              completed.fileSize,
            ) > MAX_PENDING_ATTACHMENT_BYTES
          ) {
            return current;
          }
          return [...current, { ...completed, id: crypto.randomUUID() }];
        });
        inputRef.current?.focus();
        setUploadStatus({ state: "idle" });
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setUploadError(
          error instanceof Error ? error.message : "File upload failed",
        );
        setUploadStatus({ state: "idle" });
      } finally {
        if (requestId === requestIdRef.current) {
          requestAbortRef.current = null;
          uploadInFlightRef.current = false;
        }
      }
    },
    [inputRef, pendingAttachments, tmuxSession],
  );

  return {
    handleFileSelection,
    pendingAttachments,
    removePendingAttachment,
    resetUploadState,
    setPendingAttachments,
    uploadError,
    uploadInFlightRef,
    uploadStatus,
  };
}
