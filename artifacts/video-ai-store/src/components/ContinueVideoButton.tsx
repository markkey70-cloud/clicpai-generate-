import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import {
  getGetBillingPlansQueryKey,
  getGetPredictionQueryKey,
  getListPredictionsQueryKey,
  getListVideoModelsQueryKey,
  useCreatePrediction,
  useListVideoModels,
} from "@workspace/api-client-react";
import type { Prediction, PredictionInput } from "@workspace/api-client-react";

type ContinueVideoButtonProps = {
  prediction: Prediction;
  videoUrl: string;
  onCreated: (prediction: Prediction) => void;
  placement?: "modal" | "progress";
};

type UploadImageResponse = {
  uploadId?: unknown;
  uploadUrl?: unknown;
  error?: unknown;
};

function isSupportedDuration(value: number): value is PredictionInput["duration"] {
  return value === 5 || value === 6 || value === 10;
}

function isSupportedAspectRatio(value: string): value is PredictionInput["aspectRatio"] {
  return value === "16:9" || value === "9:16" || value === "1:1";
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The video took too long to load. Please try again."));
    }, 45_000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };

    const onSuccess = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Could not read this video's final frame. Please try again."));
    };

    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });

    if (eventName === "loadedmetadata" && video.readyState >= 1) {
      onSuccess();
    }
  });
}

function waitForFinalFramePresentation(video: HTMLVideoElement, targetTime: number): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let callbackId: number | undefined;
    const timeout = window.setTimeout(() => {
      cleanup();
      // Some browsers do not present off-screen paused videos to the compositor.
      // A completed seek with current-frame data still confirms a decoded image.
      if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime >= targetTime - 0.02) {
        resolve();
      } else {
        reject(new Error("Could not confirm the video's final frame. Please try again."));
      }
    }, 3_000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      if (callbackId !== undefined) video.cancelVideoFrameCallback(callbackId);
    };

    const checkFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (metadata.mediaTime >= video.duration - 0.25) {
        cleanup();
        resolve();
      } else {
        callbackId = video.requestVideoFrameCallback(checkFrame);
      }
    };

    callbackId = video.requestVideoFrameCallback(checkFrame);
  });
}

async function captureFinalFrame(videoUrl: string): Promise<File> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    const metadataReady = waitForVideoEvent(video, "loadedmetadata");
    video.src = videoUrl;
    video.load();
    await metadataReady;

    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error("This video does not have a readable final frame.");
    }

    // Seek as close to the end as possible, but never to the ended position.
    const targetTime = Math.max(0, video.duration - 0.001);
    const seeked = waitForVideoEvent(video, "seeked");
    const finalFramePresented = waitForFinalFramePresentation(video, targetTime);
    video.currentTime = targetTime;
    await Promise.all([seeked, finalFramePresented]);
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoEvent(video, "loadeddata");
    }
    if (video.currentTime < targetTime - 0.02) {
      throw new Error("Could not seek to the video's final frame. Please try again.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the continuation frame.");

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare the continuation frame."))),
        "image/jpeg",
        0.9,
      );
    });

    if (frame.size === 0 || frame.size > 10 * 1024 * 1024) {
      throw new Error("The continuation frame is too large to upload.");
    }

    return new File([frame], "continuation-frame.jpg", { type: "image/jpeg" });
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function uploadContinuationFrame(file: File): Promise<string> {
  const request = await fetch("/api/uploads/images", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: file.type, size: file.size }),
  });
  const response = (await request.json().catch(() => null)) as UploadImageResponse | null;

  if (!request.ok) {
    const message = typeof response?.error === "string" ? response.error : "Could not prepare the continuation image.";
    throw new Error(message);
  }
  if (typeof response?.uploadId !== "string" || typeof response.uploadUrl !== "string") {
    throw new Error("The upload service returned an invalid response.");
  }

  const upload = await fetch(response.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!upload.ok) throw new Error("Could not upload the continuation image. Please try again.");

  return response.uploadId;
}

export function ContinueVideoButton({ prediction, videoUrl, onCreated, placement = "modal" }: ContinueVideoButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const createPrediction = useCreatePrediction();
  const modelsQuery = useListVideoModels({
    query: {
      queryKey: getListVideoModelsQueryKey(),
      staleTime: 300_000,
    },
  });

  const sourceModel = modelsQuery.data?.find((model) => model.id === prediction.modelId);
  const creditCost = sourceModel?.creditCosts[String(prediction.duration)];
  const isSubmitting = preparing || createPrediction.isPending;
  const canSubmit =
    prompt.trim().length >= 3 &&
    !isSubmitting &&
    typeof creditCost === "number" &&
    !!sourceModel;

  const openDialog = () => {
    setPrompt("");
    setError(null);
    createPrediction.reset();
    setIsOpen(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !sourceModel) return;
    if (!isSupportedDuration(prediction.duration) || !isSupportedAspectRatio(prediction.aspectRatio)) {
      setError("This video uses settings that cannot be continued. Please create a new video instead.");
      return;
    }

    setPreparing(true);
    setError(null);
    try {
      const frameFile = await captureFinalFrame(videoUrl);
      const imageUploadId = await uploadContinuationFrame(frameFile);
      const continuationPrompt = [
        "Continue naturally from the supplied final frame. Preserve the same main character or subject, appearance, clothing, key details, setting, lighting, and visual style. Carry the movement forward without restarting the scene.",
        `Next action: ${prompt.trim()}`,
      ].join(" ");

      const created = await createPrediction.mutateAsync({
        data: {
          prompt: continuationPrompt,
          modelId: prediction.modelId,
          aspectRatio: prediction.aspectRatio,
          duration: prediction.duration,
          expectedCreditCost: creditCost,
          negativePrompt: null,
          imageUploadId,
          imagePurpose: null,
          voiceMode: "none",
          voiceText: null,
          voiceUploadId: null,
        },
      });
      void queryClient.invalidateQueries({ queryKey: getListPredictionsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetPredictionQueryKey(created.id) });
      void queryClient.invalidateQueries({ queryKey: getGetBillingPlansQueryKey() });
      window.dispatchEvent(new Event("credits:updated"));
      setIsOpen(false);
      onCreated(created);
    } catch (captureError) {
      const responseData = captureError && typeof captureError === "object" && "data" in captureError
        ? captureError.data
        : null;
      const serverError = responseData && typeof responseData === "object" && "error" in responseData
        ? responseData.error
        : null;
      setError(
        typeof serverError === "string"
          ? serverError
          : captureError instanceof Error
            ? captureError.message
            : "Could not prepare the continuation.",
      );
    } finally {
      setPreparing(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl border border-background/20 px-4 py-2.5 text-xs font-bold text-background transition hover:border-accent hover:text-accent"
        aria-haspopup="dialog"
        data-testid={`button-continue-video-${prediction.id}-${placement}`}
      >
        <ArrowRight size={15} />
        Continue
      </button>

      {isOpen && createPortal(
        <div className="fixed inset-0 z-[70] grid place-items-center bg-foreground/75 p-4 backdrop-blur-sm">
          <section
            className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="continue-video-title"
            data-testid="dialog-continue-video"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-muted-foreground">
                  Continue this scene
                </p>
                <h2 id="continue-video-title" className="mt-2 font-display text-2xl font-semibold">
                  What happens next?
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                disabled={isSubmitting}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Close continue dialog"
                data-testid="button-close-continue-dialog"
              >
                <X size={16} />
              </button>
            </div>

            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              The final frame starts a new {prediction.duration}-second clip to help preserve the subject and visual style,
              and leave your original video unchanged.
            </p>

            <form onSubmit={submit} className="mt-5">
              <label
                htmlFor={`continue-prompt-${prediction.id}`}
                className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground"
              >
                Describe the next action
              </label>
              <textarea
                id={`continue-prompt-${prediction.id}`}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                maxLength={900}
                minLength={3}
                required
                placeholder="For example: the character turns toward the camera and walks into the sunset."
                className="w-full resize-y rounded-xl border border-input bg-background px-3 py-3 text-sm leading-6 outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground"
                data-testid="input-continue-prompt"
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {modelsQuery.isLoading
                    ? "Checking credit cost…"
                    : modelsQuery.isError
                      ? "Could not load the credit cost."
                      : typeof creditCost === "number"
                        ? `This new clip uses ${creditCost} credits.`
                        : "This model and length are not currently available."}
                </span>
                <span className="font-mono-ui">{prediction.modelName}</span>
              </div>

              <p className="mt-2 text-[11px] leading-5 text-muted-foreground/80">
                Continuations are saved as separate clips in your history. You can download or add sound to the new clip after it finishes.
              </p>

              {error && (
                <p
                  className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
                  role="alert"
                  data-testid="status-continue-error"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-bold text-background transition hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="button-submit-continue"
              >
                {isSubmitting ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" />
                    {preparing ? "Preparing final frame…" : "Starting continuation…"}
                  </>
                ) : (
                  <>
                    <ArrowRight size={16} />
                    Continue for {typeof creditCost === "number" ? `${creditCost} credits` : "credits"}
                  </>
                )}
              </button>
            </form>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}