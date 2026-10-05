import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const VOICE_UPLOAD_TTL_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);

export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

export const VOICE_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

export class InvalidVoiceUploadError extends Error {}

function privateVoiceLocation(userId: string, uploadId: string, generated = false) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("Private voice storage is not configured.");
  const fullPath = `${privateDir.replace(/\/$/, "")}/${generated ? "generated-narrations" : "voice-recordings"}/${encodeURIComponent(userId)}/${encodeURIComponent(uploadId)}${generated ? ".mp3" : ""}`;
  const parts = fullPath.replace(/^\/+/, "").split("/");
  const bucketName = parts.shift();
  if (!bucketName || parts.length === 0) {
    throw new Error("Private voice storage path is invalid.");
  }
  return { bucketName, objectName: parts.join("/") };
}

async function signedVoiceUrl(
  userId: string,
  uploadId: string,
  method: "GET" | "PUT",
  contentType?: string,
  generated = false,
) {
  const { bucketName, objectName } = privateVoiceLocation(userId, uploadId, generated);
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        content_type: contentType,
        expires_at: new Date(Date.now() + VOICE_UPLOAD_TTL_MS).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not access private voice storage (${response.status}).`);
  }
  const body = (await response.json()) as { signed_url?: string };
  if (!body.signed_url) {
    throw new Error("Private voice storage did not return a signed URL.");
  }
  return body.signed_url;
}

export async function createVoiceUpload(userId: string, contentType: string) {
  if (!userId || !VOICE_TYPES.has(contentType)) {
    throw new InvalidVoiceUploadError("Choose a supported audio file type.");
  }
  const uploadId = randomUUID();
  return {
    uploadId,
    uploadUrl: await signedVoiceUrl(userId, uploadId, "PUT", contentType),
    contentType,
  };
}

export async function downloadVoiceUpload(
  userId: string,
  uploadId: string,
): Promise<Buffer> {
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
    throw new InvalidVoiceUploadError("The voice upload identifier is invalid.");
  }

  const downloadUrl = await signedVoiceUrl(userId, uploadId, "GET");
  const response = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404) {
    throw new InvalidVoiceUploadError("The voice recording was not found.");
  }
  if (!response.ok) {
    throw new Error(`Could not load the voice recording (${response.status}).`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_VOICE_BYTES) {
    await response.body?.cancel();
    throw new InvalidVoiceUploadError("The voice recording exceeds the 20 MB limit.");
  }
  if (!response.body) {
    throw new InvalidVoiceUploadError("The voice recording is missing or empty.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_VOICE_BYTES) {
        await reader.cancel();
        throw new InvalidVoiceUploadError("The voice recording exceeds the 20 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  if (totalBytes === 0) {
    throw new InvalidVoiceUploadError("The voice recording is missing or empty.");
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function validateVoiceRecording(audio: Buffer): Promise<void> {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new InvalidVoiceUploadError("Choose a voice recording.");
  }
  if (audio.length > MAX_VOICE_BYTES) {
    throw new InvalidVoiceUploadError("The voice recording exceeds the 20 MB limit.");
  }

  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "voice-recording-"));
    const audioPath = join(workDir, "recording.bin");
    await writeFile(audioPath, audio);
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        audioPath,
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    if (!stdout.trim().split(/\r?\n/).includes("audio")) {
      throw new InvalidVoiceUploadError("The file does not contain playable audio.");
    }
  } catch (error) {
    if (error instanceof InvalidVoiceUploadError) throw error;
    throw new InvalidVoiceUploadError("The file does not contain playable audio.");
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

export async function loadSynthesizedVoice(userId: string, predictionId: string) {
  const url = await signedVoiceUrl(userId, predictionId, "GET", undefined, true);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not load saved narration (${response.status}).`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_VOICE_BYTES) {
    await response.body?.cancel();
    throw new Error("The saved narration is too large.");
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > MAX_VOICE_BYTES) throw new Error("The saved narration is invalid.");
  return audio;
}

export async function storeSynthesizedVoice(userId: string, predictionId: string, audio: Buffer) {
  if (!audio.length || audio.length > MAX_VOICE_BYTES) throw new Error("The generated narration is too large.");
  const url = await signedVoiceUrl(userId, predictionId, "PUT", "audio/mpeg", true);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg", "Content-Length": String(audio.length) },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Could not save generated narration (${response.status}).`);
}