import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { Router, type IRouter, type RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { CreateSoundVideoBody, CreateSoundVideoParams, UploadSoundVideoParams } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { predictions as predictionsTable } from "@workspace/db/schema";
import { generateSoundAudio, SoundGenerationTimeoutError } from "../lib/soundGeneration";
import { addAudioToVideo, InvalidAudioError, MAX_AUDIO_BYTES } from "../lib/videoAudio";
import { fromDatabase, predictionVideoBuffer } from "./video";

const router: IRouter = Router();

const requireAuth: RequestHandler = (req, res, next) => {
  const auth = getAuth(req);
  const userId = auth.sessionClaims?.userId as string | undefined ?? auth.userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  res.locals.userId = userId;
  next();
};

async function ownedReadyPrediction(id: string, userId: string) {
  const [row] = await db
    .select()
    .from(predictionsTable)
    .where(and(eq(predictionsTable.id, id), eq(predictionsTable.userId, userId)))
    .limit(1);
  return row ? fromDatabase(row) : undefined;
}

function sendDownload(
  res: express.Response,
  workDir: string,
  file: string,
  predictionId: string,
) {
  const cleanup = () => { void rm(workDir, { recursive: true, force: true }); };
  res.once("finish", cleanup);
  res.once("close", cleanup);
  res.download(file, `clicpai-${predictionId.slice(0, 8)}-with-sound.mp4`);
}

router.post("/predictions/:id/sound", requireAuth, async (req, res): Promise<void> => {
  const params = CreateSoundVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }
  const body = CreateSoundVideoBody.safeParse(req.body);
  if (!body.success || !body.data.prompt.trim()) {
    res.status(400).json({ error: "Describe the music or sound effect you want." });
    return;
  }
  const userId = res.locals.userId as string;
  let workDir: string | undefined;

  try {
    const prediction = await ownedReadyPrediction(params.data.id, userId);
    if (!prediction) {
      res.status(404).json({ error: "Prediction not found." });
      return;
    }
    if (prediction.status !== "succeeded" || !prediction.outputUrl) {
      res.status(400).json({ error: "Wait for the video to finish before adding sound." });
      return;
    }
    const sourceVideo = await predictionVideoBuffer(prediction, userId);
    const audio = await generateSoundAudio(body.data.prompt.trim(), body.data.kind, prediction.duration);
    workDir = await mkdtemp(join(tmpdir(), "clicpai-sound-"));
    const finalVideo = await addAudioToVideo(sourceVideo, audio, workDir, "sound");
    sendDownload(res, workDir, finalVideo, prediction.id);
  } catch (error) {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    req.log.error({ err: error, predictionId: params.data.id }, "Could not add generated sound");
    res.status(error instanceof SoundGenerationTimeoutError ? 504 : 502).json({
      error: error instanceof SoundGenerationTimeoutError
        ? error.message
        : "Could not generate sound for this video. Please try again.",
    });
  }
});

router.post(
  "/predictions/:id/sound-upload",
  requireAuth,
  express.raw({ type: "application/octet-stream", limit: MAX_AUDIO_BYTES }),
  async (req, res): Promise<void> => {
    const params = UploadSoundVideoParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Prediction not found." });
      return;
    }
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || !audio.length) {
      res.status(400).json({ error: "Choose an audio file up to 20 MB." });
      return;
    }
    const userId = res.locals.userId as string;
    let workDir: string | undefined;

    try {
      const prediction = await ownedReadyPrediction(params.data.id, userId);
      if (!prediction) {
        res.status(404).json({ error: "Prediction not found." });
        return;
      }
      if (prediction.status !== "succeeded" || !prediction.outputUrl) {
        res.status(400).json({ error: "Wait for the video to finish before adding sound." });
        return;
      }
      const sourceVideo = await predictionVideoBuffer(prediction, userId);
      workDir = await mkdtemp(join(tmpdir(), "clicpai-sound-upload-"));
      const finalVideo = await addAudioToVideo(sourceVideo, audio, workDir, "sound");
      sendDownload(res, workDir, finalVideo, prediction.id);
    } catch (error) {
      if (workDir) await rm(workDir, { recursive: true, force: true });
      req.log.error({ err: error, predictionId: params.data.id }, "Could not add uploaded sound");
      res.status(error instanceof InvalidAudioError ? 400 : 502).json({
        error: error instanceof InvalidAudioError
          ? error.message
          : "Could not add the uploaded audio to this video.",
      });
    }
  },
);

export default router;