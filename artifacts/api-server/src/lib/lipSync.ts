import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { replicateRequest } from "../replicateClient";

const execFileAsync = promisify(execFile);
const MAX_LIP_SYNC_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_DATA_URL_BYTES = 256 * 1024;
const LIP_SYNC_MODEL = "kwaivgi/kling-lip-sync";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_TIME_MS = 4 * 60_000;

type ReplicatePrediction = {
  id?: unknown;
  status?: unknown;
  output?: unknown;
  error?: unknown;
};

export class LipSyncPredictionFailedError extends Error {}

function getOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (output && typeof output === "object" && "url" in output && typeof output.url === "string") {
    return output.url;
  }
  return null;
}

function isReplicateDeliveryUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery"));
  } catch {
    return false;
  }
}

async function createAudioDataUrl(audio: Buffer, workDir: string, durationSeconds: number) {
  if (!audio.length) throw new Error("The narration audio is empty.");
  if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 10) {
    throw new Error("Lip-sync supports videos between 2 and 10 seconds.");
  }

  const inputPath = join(workDir, "lip-sync-audio-source.bin");
  const outputPath = join(workDir, "lip-sync-audio.mp3");
  await writeFile(inputPath, audio);
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vn",
    "-af", `apad=whole_dur=${durationSeconds}`,
    "-t", String(durationSeconds),
    "-ac", "1",
    "-ar", "24000",
    "-c:a", "libmp3lame",
    "-b:a", "64k",
    "-f", "mp3",
    outputPath,
  ], { timeout: 30_000, maxBuffer: 1_000_000 });

  const compressedAudio = await readFile(outputPath);
  const dataUrl = `data:audio/mpeg;base64,${compressedAudio.toString("base64")}`;
  if (Buffer.byteLength(dataUrl) > MAX_AUDIO_DATA_URL_BYTES) {
    throw new Error("The narration could not be compressed to the lip-sync size limit.");
  }
  return dataUrl;
}

async function downloadLipSyncedVideo(url: string) {
  if (!isReplicateDeliveryUrl(url)) {
    throw new Error("The lip-sync provider returned an invalid video URL.");
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the lip-synced video (${response.status}).`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_LIP_SYNC_VIDEO_BYTES) {
    await response.body.cancel();
    throw new Error("The lip-synced video is too large to save.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > MAX_LIP_SYNC_VIDEO_BYTES) {
      await reader.cancel();
      throw new Error("The lip-synced video is too large to save.");
    }
    chunks.push(chunk);
  }
  const video = Buffer.concat(chunks, totalBytes);
  if (video.length < 12 || video.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error("The lip-sync provider did not return a playable MP4.");
  }
  return video;
}

async function waitForLipSync(predictionId: string) {
  const deadline = Date.now() + MAX_POLL_TIME_MS;
  while (Date.now() < deadline) {
    const result = await replicateRequest<ReplicatePrediction>(
      `/v1/predictions/${encodeURIComponent(predictionId)}`,
    );
    if (result.status === "succeeded") return result;
    if (result.status === "failed" || result.status === "canceled") {
      throw new LipSyncPredictionFailedError(
        typeof result.error === "string" ? result.error : "The lip-sync provider could not process this video.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Lip-sync is taking too long. Try again later.");
}

export async function createLipSyncedVideo(
  videoUrl: string,
  audio: Buffer,
  workDir: string,
  durationSeconds: number,
  existingPredictionId: string | null,
  onPredictionCreated: (predictionId: string) => Promise<void>,
) {
  let predictionId = existingPredictionId;
  let prediction: ReplicatePrediction;
  if (predictionId) {
    prediction = await replicateRequest<ReplicatePrediction>(
      `/v1/predictions/${encodeURIComponent(predictionId)}`,
    );
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new LipSyncPredictionFailedError(
        typeof prediction.error === "string" ? prediction.error : "The lip-sync provider could not process this video.",
      );
    }
  } else {
    const audioFile = await createAudioDataUrl(audio, workDir, durationSeconds);
    prediction = await replicateRequest<ReplicatePrediction>(
      `/v1/models/${LIP_SYNC_MODEL}/predictions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "wait=5",
        },
        body: JSON.stringify({
          input: {
            video_url: videoUrl,
            audio_file: audioFile,
          },
        }),
      },
    );
    predictionId = typeof prediction.id === "string" ? prediction.id : "";
    if (!predictionId) throw new Error("Replicate did not return a lip-sync prediction ID.");
    await onPredictionCreated(predictionId);
  }
  const completed = prediction.status === "succeeded"
    ? prediction
    : await waitForLipSync(predictionId!);
  const output = getOutputUrl(completed.output);
  if (!output) throw new Error("The lip-sync provider did not return a video.");
  return downloadLipSyncedVideo(output);
}