import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, lt, or } from "drizzle-orm";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { db } from "@workspace/db";
import { predictions } from "@workspace/db/schema";
import { logger } from "./logger";
import { createLipSyncedVideo, LipSyncPredictionFailedError } from "./lipSync";
import { addAudioToVideo } from "./videoAudio";
import {
  downloadStoredVideo,
  downloadStoredVideoIfPresent,
  getVideoProviderUrl,
  storeVideo,
} from "./videoStorage";
import { downloadVoiceUpload, loadSynthesizedVoice, storeSynthesizedVoice } from "./voiceStorage";
import { voicePresets, type VoiceStyle } from "./voicePresets";

const active = new Set<string>();
const MAX_ACTIVE_VOICES = 2;
const STALE_AFTER_MS = 30 * 60 * 1000;
const MAX_LIP_SYNC_INPUT_BYTES = 100 * 1024 * 1024;

async function finishVoice(
  predictionId: string,
  userId: string,
  claimId: string,
  mode: string,
  style: VoiceStyle,
  text: string | null,
  uploadId: string | null,
  lipSyncPredictionId: string | null,
  lipSyncEnabled: boolean,
  duration: number,
) {
  let workDir: string | undefined;
  const heartbeat = setInterval(() => {
    void db.update(predictions)
      .set({ voiceClaimedAt: new Date() })
      .where(and(
        eq(predictions.id, predictionId),
        eq(predictions.userId, userId),
        eq(predictions.voiceClaimId, claimId),
        eq(predictions.voiceStatus, "processing"),
      ))
      .catch((error) => logger.warn({ err: error, predictionId }, "Could not renew voice lease"));
  }, 60_000);
  heartbeat.unref();
  try {
    workDir = await mkdtemp(join(tmpdir(), "clicpai-final-voice-"));
    if (lipSyncEnabled) {
      const cachedLipSyncedVideo = await downloadStoredVideoIfPresent(
        userId,
        predictionId,
        "lip-synced",
      );
      if (!cachedLipSyncedVideo) {
        let audio: Buffer | null = null;
        let videoUrl = "";
        if (!lipSyncPredictionId) {
          if (mode === "text" && text) {
            audio = await loadSynthesizedVoice(userId, predictionId);
            if (!audio) {
              const preset = voicePresets[style];
              audio = await textToSpeech(text, preset.voice, "mp3", preset.instructions);
              await storeSynthesizedVoice(userId, predictionId, audio);
            }
          } else if (mode === "upload" && uploadId) {
            audio = await downloadVoiceUpload(userId, uploadId);
          }

          if (!audio?.length) throw new Error("The selected voice is unavailable.");
          const source = await downloadStoredVideo(userId, predictionId);
          if (source.length > MAX_LIP_SYNC_INPUT_BYTES) {
            throw new Error("This video is too large for lip-sync. Try a shorter or lower-resolution video.");
          }
          videoUrl = await getVideoProviderUrl(userId, predictionId, "original");
        }
        const lipSyncedVideo = await createLipSyncedVideo(
          videoUrl,
          audio ?? Buffer.alloc(0),
          workDir,
          duration,
          lipSyncPredictionId,
          async (providerPredictionId) => {
            const [claimed] = await db.update(predictions)
              .set({ lipSyncPredictionId: providerPredictionId })
              .where(and(
                eq(predictions.id, predictionId),
                eq(predictions.userId, userId),
                eq(predictions.voiceClaimId, claimId),
                eq(predictions.voiceStatus, "processing"),
              ))
              .returning({ id: predictions.id });
            if (!claimed) throw new Error("The voice processing claim expired. Try again.");
          },
        );
        await storeVideo(userId, predictionId, lipSyncedVideo, "lip-synced");
      }
    } else {
      const source = await downloadStoredVideo(userId, predictionId);
      let audio: Buffer | null = null;
      if (mode === "text" && text) {
        audio = await loadSynthesizedVoice(userId, predictionId);
        if (!audio) {
          const preset = voicePresets[style];
          audio = await textToSpeech(text, preset.voice, "mp3", preset.instructions);
          await storeSynthesizedVoice(userId, predictionId, audio);
        }
      } else if (mode === "upload" && uploadId) {
        audio = await downloadVoiceUpload(userId, uploadId);
      }
      if (!audio?.length) throw new Error("The selected voice is unavailable.");

      const finalPath = await addAudioToVideo(source, audio, workDir, "voice");
      await storeVideo(userId, predictionId, await readFile(finalPath), `voiced-${claimId}`);
    }
    await db.update(predictions)
      .set({
        voiceStatus: "succeeded",
        voiceClaimedAt: null,
        voiceClaimId: null,
        voiceObjectId: claimId,
        voiceError: null,
        lipSyncPredictionId: null,
      })
      .where(and(
        eq(predictions.id, predictionId),
        eq(predictions.userId, userId),
        eq(predictions.voiceClaimId, claimId),
        eq(predictions.voiceStatus, "processing"),
      ));
  } catch (error) {
    logger.error({ err: error, predictionId }, "Could not save video with voice");
    const failureUpdate = {
      voiceStatus: "failed",
      voiceClaimedAt: null,
      voiceClaimId: null,
      voiceError: lipSyncEnabled
        ? "Could not finish lip-sync for this video. Try again."
        : "Could not add your voice to this video. Try again.",
      ...(error instanceof LipSyncPredictionFailedError ? { lipSyncPredictionId: null } : {}),
    };
    await db.update(predictions)
      .set(failureUpdate)
      .where(and(
        eq(predictions.id, predictionId),
        eq(predictions.userId, userId),
        eq(predictions.voiceClaimId, claimId),
        eq(predictions.voiceStatus, "processing"),
      ))
      .catch((dbError) => logger.error({ err: dbError, predictionId }, "Could not mark voice failure"));
  } finally {
    clearInterval(heartbeat);
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch((error) => {
        logger.warn({ err: error, predictionId }, "Could not remove temporary voice files");
      });
    }
    active.delete(predictionId);
  }
}

/**
 * Atomically claims one pending voice job. The lease lets a later request or the
 * worker recover a job if the API process restarts during synthesis or mixing.
 */
export async function maybeStartVoice(predictionId: string, userId: string) {
  if (active.has(predictionId) || active.size >= MAX_ACTIVE_VOICES) return;
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  const claimId = randomUUID();
  const [job] = await db.update(predictions)
    .set({ voiceStatus: "processing", voiceClaimedAt: new Date(), voiceClaimId: claimId, voiceError: null })
    .where(and(
      eq(predictions.id, predictionId),
      eq(predictions.userId, userId),
      eq(predictions.status, "succeeded"),
      or(
        eq(predictions.voiceStatus, "pending"),
        and(eq(predictions.voiceStatus, "processing"), lt(predictions.voiceClaimedAt, staleBefore)),
      ),
    ))
    .returning({
      mode: predictions.voiceMode,
      style: predictions.voiceStyle,
      text: predictions.voiceText,
      uploadId: predictions.voiceUploadId,
      lipSyncPredictionId: predictions.lipSyncPredictionId,
      lipSyncEnabled: predictions.lipSyncEnabled,
      duration: predictions.duration,
    });
  if (!job) return;
  active.add(predictionId);
  void finishVoice(
    predictionId,
    userId,
    claimId,
    job.mode,
    job.style as VoiceStyle,
    job.text,
    job.uploadId,
    job.lipSyncPredictionId,
    job.lipSyncEnabled,
    job.duration,
  );
}