"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
  ServerCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  environmentResponseSchema,
  progressForStage,
  provisioningSteps,
  type ProvisioningProgress,
} from "@/lib/environment-progress";
import { cn } from "@/lib/utils";

type EnvironmentStatus = "not_created" | "provisioning" | "failed";

interface EnvironmentSetupProps {
  initialStatus: EnvironmentStatus;
  initialStartedAt?: string;
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function EnvironmentSetup({
  initialStatus,
  initialStartedAt,
}: EnvironmentSetupProps) {
  const [status, setStatus] = useState(initialStatus);
  const [progress, setProgress] = useState<ProvisioningProgress | undefined>(
    initialStatus === "provisioning" && initialStartedAt
      ? progressForStage("creating_access", initialStartedAt)
      : undefined,
  );
  const [error, setError] = useState<string>();
  const [pollWarning, setPollWarning] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (status !== "provisioning" || !progress) return;
    const startedAt = Date.parse(progress.startedAt);
    const interval = window.setInterval(() => {
      setElapsedSeconds(
        Number.isFinite(startedAt)
          ? Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))
          : 0,
      );
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [progress, status]);

  useEffect(() => {
    if (status !== "provisioning") return;

    let cancelled = false;
    let nextPoll: number | undefined;
    async function refreshProgress() {
      try {
        const response = await fetch("/api/environment", { cache: "no-store" });
        const parsed = environmentResponseSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (!response.ok || !parsed.success) {
          throw new Error("Status check failed");
        }
        if (cancelled) return;
        setPollWarning(undefined);

        if (parsed.data.status === "active") {
          window.location.replace("/");
          return;
        }
        if (parsed.data.status === "failed") {
          setStatus("failed");
          return;
        }
        if (parsed.data.status === "provisioning" && parsed.data.progress) {
          setProgress(parsed.data.progress);
        }
      } catch {
        if (!cancelled) {
          setPollWarning(
            "The latest status check was missed. Retrying automatically…",
          );
        }
      }

      if (!cancelled) {
        nextPoll = window.setTimeout(refreshProgress, 3_000);
      }
    }

    void refreshProgress();
    return () => {
      cancelled = true;
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
    };
  }, [status]);

  async function createEnvironment() {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body.error === "string"
            ? body.error
            : "Environment creation could not start";
        throw new Error(message);
      }
      const parsed = environmentResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.status !== "provisioning") {
        throw new Error("Environment creation returned an invalid status");
      }
      setProgress(
        parsed.data.progress ??
          progressForStage("confirming_access", new Date().toISOString()),
      );
      setElapsedSeconds(0);
      setStatus("provisioning");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Environment creation could not start",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const isProvisioning = status === "provisioning";
  const currentStepIndex = progress
    ? provisioningSteps.findIndex((step) => step.id === progress.stage)
    : -1;
  const currentStep =
    currentStepIndex >= 0 ? provisioningSteps[currentStepIndex] : undefined;

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
      <section className="w-full max-w-xl space-y-6 rounded-2xl border bg-card p-6 shadow-xl sm:p-8">
        <div className="space-y-3 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-400">
            {isProvisioning ? (
              <LoaderCircle className="size-7 animate-spin" />
            ) : (
              <ServerCog className="size-7" />
            )}
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {isProvisioning
                ? "Creating your environment"
                : "Create your coding environment"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {isProvisioning
                ? "AWS is creating one private, persistent runtime for your company sign-in."
                : "Your assigned company sign-in allows one private, persistent runtime in this AWS account."}
            </p>
          </div>
        </div>

        {isProvisioning && progress && currentStep ? (
          <div className="space-y-5" aria-live="polite">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="font-medium">
                  Step {currentStepIndex + 1} of {provisioningSteps.length}
                </span>
                <span className="text-muted-foreground">
                  Elapsed {formatElapsed(elapsedSeconds)}
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={currentStep.percent}
                aria-label="Environment creation progress"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${currentStep.percent}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span>{currentStep.estimate}</span>
                <span>AWS timing can vary</span>
              </div>
            </div>

            <ol className="space-y-3">
              {provisioningSteps.map((step, index) => {
                const isComplete = index < currentStepIndex;
                const isCurrent = index === currentStepIndex;
                return (
                  <li key={step.id} className="flex gap-3">
                    {isComplete ? (
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
                    ) : isCurrent ? (
                      <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
                    ) : (
                      <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground/40" />
                    )}
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "text-sm font-medium",
                          !isComplete && !isCurrent && "text-muted-foreground",
                        )}
                      >
                        {step.label}
                      </p>
                      {isCurrent ? (
                        <p className="text-xs leading-5 text-muted-foreground">
                          {step.detail}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        {status === "failed" ? (
          <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p>The last AWS setup did not finish. You can safely try again.</p>
          </div>
        ) : null}
        {error ? (
          <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p>{error}</p>
          </div>
        ) : null}
        {pollWarning ? (
          <p
            className="text-center text-xs text-muted-foreground"
            role="status"
          >
            {pollWarning}
          </p>
        ) : null}

        <Button
          type="button"
          size="lg"
          className="w-full gap-2"
          disabled={isProvisioning || submitting}
          onClick={createEnvironment}
        >
          {isProvisioning || submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ServerCog className="size-4" />
          )}
          {isProvisioning
            ? (currentStep?.label ?? "Environment is being created")
            : status === "failed"
              ? "Try again"
              : "Create environment"}
        </Button>
      </section>
    </main>
  );
}
