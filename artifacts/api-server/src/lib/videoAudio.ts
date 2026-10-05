import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export class InvalidAudioError extends Error {}

async function hasAudioStream(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", path],
    { timeout: 15_000 },
  );
  return stdout.trim().length > 0;
}

export async function addAudioToVideo(
  video: Buffer,
  audio: Buffer,
  workDir: string,
  kind: "voice" | "sound",
): Promise<string> {
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
    throw new InvalidAudioError("Choose an audio file up to 20 MB.");
  }

  const videoPath = join(workDir, "source.mp4");
  const audioPath = join(workDir, "added-audio.bin");
  const outputPath = join(workDir, `final-with-${kind}.mp4`);
  await Promise.all([writeFile(videoPath, video), writeFile(audioPath, audio)]);

  let addedAudioIsValid: boolean;
  try {
    addedAudioIsValid = await hasAudioStream(audioPath);
  } catch {
    addedAudioIsValid = false;
  }
  if (!addedAudioIsValid) {
    throw new InvalidAudioError("The selected file does not contain playable audio.");
  }

  const hasOriginalAudio = await hasAudioStream(videoPath);
  const filter = hasOriginalAudio
    ? kind === "voice"
      ? "[0:a:0]volume=0.25,apad[original];[1:a:0]apad[added];[original][added]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]"
      : "[0:a:0]apad[original];[1:a:0]volume=0.45,apad[added];[original][added]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]"
    : "[1:a:0]apad[a]";

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-i", videoPath, "-i", audioPath,
      "-filter_complex", filter,
      "-map", "0:v:0", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
      "-shortest", "-movflags", "+faststart", outputPath,
    ]);
    let stderr = "";
    const timeout = setTimeout(() => ffmpeg.kill("SIGKILL"), 120_000);
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    ffmpeg.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ffmpeg.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Could not combine video and audio: ${stderr}`));
    });
  });

  return outputPath;
}