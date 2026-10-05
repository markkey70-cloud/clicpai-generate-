import { setTimeout as delay } from "node:timers/promises";
import { replicateRequest } from "../replicateClient";
import { MAX_AUDIO_BYTES } from "./videoAudio";

// Pinned to the short-sample model; do not switch to the $0.20/output model.
const SOUND_MODEL_VERSION =
  "9aff84a639f96d0f7e6081cdea002d15133d0043727f849c40abdd166b7c75a8";

type SoundPrediction = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string | null;
};

export class SoundGenerationTimeoutError extends Error {}

function audioOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (output && typeof output === "object" && "url" in output && typeof output.url === "string") {
    return output.url;
  }
  return null;
}

export async function generateSoundAudio(
  prompt: string,
  kind: "music" | "effects",
  seconds: number,
): Promise<Buffer> {
  const description = kind === "music"
    ? `Short instrumental background music: ${prompt}`
    : `Short sound effects and ambience: ${prompt}`;
  let prediction = await replicateRequest<SoundPrediction>("/v1/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "wait=5" },
    body: JSON.stringify({
      version: SOUND_MODEL_VERSION,
      input: {
        prompt: description,
        seconds_total: Math.max(5, Math.min(10, Math.round(seconds))),
        negative_prompt: kind === "music"
          ? "singing, voice, vocals, dialogue, narration, speech"
          : "music, singing, voice, dialogue, narration, speech",
      },
    }),
  });

  if (!prediction.id) throw new Error("The sound provider did not return a job ID.");
  const predictionId = prediction.id;
  // The first request can wait for a cold model boot before GPU inference starts.
  const deadline = Date.now() + 240_000;
  while (prediction.status === "starting" || prediction.status === "processing") {
    if (Date.now() >= deadline) {
      throw new SoundGenerationTimeoutError("Sound generation is taking too long. Please try again later.");
    }
    await delay(2_000);
    prediction = await replicateRequest<SoundPrediction>(`/v1/predictions/${encodeURIComponent(predictionId)}`);
  }
  if (prediction.status !== "succeeded") {
    throw new Error(prediction.error || "The sound provider could not create audio for this prompt.");
  }

  const output = audioOutputUrl(prediction.output);
  if (!output) throw new Error("The sound provider returned no audio.");
  const url = new URL(output);
  if (url.protocol !== "https:" || !(url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery"))) {
    throw new Error("The sound provider returned an unexpected audio location.");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error("Could not download the generated sound.");
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_AUDIO_BYTES) throw new Error("Generated sound is too large to process.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) {
    throw new Error("The generated sound is empty or too large to process.");
  }
  return buffer;
}