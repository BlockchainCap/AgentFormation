"use client";

import { z } from "zod";
import {
  normalizeSsmStreamUrl,
  ssmSessionIdSchema,
  ssmStreamUrlSchema,
} from "@/lib/ssm-stream-url";

export interface SessionInfo {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
  terminateToken: string;
}

export interface UploadCreateResponse {
  key: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  uploadUrl: string;
  method: "POST";
  formFields: Record<string, string>;
}

export interface UploadCompleteResponse {
  path: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export interface PendingAttachment extends UploadCompleteResponse {
  id: string;
}

export type UploadStatus =
  | { state: "idle" }
  | { state: "uploading"; filename: string; progress: number }
  | { state: "completing"; filename: string };

export const MAX_ATTACHMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PENDING_ATTACHMENTS = 8;
export const MAX_PENDING_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

export function isS3UploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9.-]+\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

const uploadCreateResponseSchema = z.object({
  key: z.string().min(1).max(1_024),
  filename: z.string().min(1).max(120),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_ATTACHMENT_UPLOAD_BYTES),
  uploadUrl: z.string().max(8_192).url().refine(isS3UploadUrl),
  method: z.literal("POST"),
  formFields: z.record(z.string()),
});

const uploadCompleteResponseSchema = z.object({
  path: z
    .string()
    .regex(
      /^\/workspace\/\.uploads\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,
    ),
  filename: z.string().min(1).max(120),
  mimeType: z.string().min(1).max(120),
  fileSize: z.number().int().positive().max(MAX_ATTACHMENT_UPLOAD_BYTES),
});

async function readJsonResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const errorBody = z
      .object({ error: z.string().min(1).max(300) })
      .safeParse(body);
    throw new Error(
      errorBody.success
        ? errorBody.data.error
        : `Request failed with status ${response.status}`,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("Server returned an invalid response");
  return parsed.data;
}

export function uploadFileToUrl(
  file: File,
  uploadUrl: string,
  formFields: Record<string, string>,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => {
      settle(() => {
        xhr.abort();
        reject(new DOMException("Upload cancelled", "AbortError"));
      });
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
    xhr.open("POST", uploadUrl);
    xhr.timeout = UPLOAD_REQUEST_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        settle(resolve);
        return;
      }
      settle(() =>
        reject(new Error(`Upload failed with status ${xhr.status}`)),
      );
    };
    xhr.onerror = () => settle(() => reject(new Error("Upload failed")));
    xhr.ontimeout = () => settle(() => reject(new Error("Upload timed out")));
    xhr.onabort = () =>
      settle(() => reject(new DOMException("Upload cancelled", "AbortError")));
    const form = new FormData();
    Object.entries(formFields).forEach(([name, value]) => {
      form.append(name, value);
    });
    form.append("file", file);
    xhr.send(form);
  });
}

export function readUploadCreateResponse(response: Response) {
  return readJsonResponse(response, uploadCreateResponseSchema);
}

export function readUploadCompleteResponse(response: Response) {
  return readJsonResponse(response, uploadCompleteResponseSchema);
}

export function getUploadStatusText(
  uploadStatus: UploadStatus,
  uploadError: string,
) {
  if (uploadError) return uploadError;
  if (uploadStatus.state === "uploading") {
    return `Uploading ${uploadStatus.filename} (${uploadStatus.progress}%)`;
  }
  if (uploadStatus.state === "completing") {
    return `Installing ${uploadStatus.filename} on runtime...`;
  }
  return "";
}

function getAttachmentPromptText(upload: UploadCompleteResponse) {
  return `attached file: '${upload.path}'`;
}

export function getAttachmentSubmitSuffix(
  inputValue: string,
  attachments: PendingAttachment[],
) {
  if (attachments.length === 0) return "";
  const prefix = inputValue.length === 0 || /\s$/.test(inputValue) ? "" : " ";
  return `${prefix}${attachments.map(getAttachmentPromptText).join(" ")} `;
}

export async function requestSessionTermination(
  sessionId: string,
  terminateToken: string,
): Promise<boolean> {
  const body = JSON.stringify({ sessionId, terminateToken });
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("/api/session/terminate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function terminateSession(sessionId: string, terminateToken: string) {
  const body = JSON.stringify({ sessionId, terminateToken });
  void requestSessionTermination(sessionId, terminateToken)
    .then((terminated) => {
      if (!terminated && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(
          "/api/session/terminate",
          new Blob([body], { type: "application/json" }),
        );
      }
    })
    .catch(() => {
      // Session Manager's idle timeout remains the final cleanup backstop.
    });
}

export function beaconTerminateSession(
  sessionId: string,
  terminateToken: string,
) {
  const body = JSON.stringify({ sessionId, terminateToken });
  if (typeof navigator.sendBeacon === "function") {
    const accepted = navigator.sendBeacon(
      "/api/session/terminate",
      new Blob([body], { type: "application/json" }),
    );
    if (accepted) return;
  }

  void fetch("/api/session/terminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => {
    // Session Manager's idle timeout remains the final cleanup backstop.
  });
}

const sessionResponseSchema = z.object({
  sessionId: ssmSessionIdSchema,
  streamUrl: ssmStreamUrlSchema,
  tokenValue: z.string().min(1).max(4_096),
  terminateToken: z.string().min(1).max(512),
});

export async function readSessionResponse(res: Response): Promise<SessionInfo> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const errorBody = z
      .object({ error: z.string().min(1).max(300) })
      .safeParse(body);
    throw new Error(
      errorBody.success ? errorBody.data.error : `HTTP ${res.status}`,
    );
  }

  const parsed = sessionResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("Incomplete SSM session response");
  const streamUrl = normalizeSsmStreamUrl(
    parsed.data.streamUrl,
    parsed.data.sessionId,
    (hostname) =>
      /^ssmmessages\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(hostname),
  );
  if (!streamUrl) {
    throw new Error("Unexpected SSM session endpoint");
  }
  return { ...parsed.data, streamUrl };
}
