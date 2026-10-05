import { Readable } from "node:stream";
import { Router, type IRouter, type RequestHandler } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  CreatePredictionBody,
  GetPredictionParams,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { predictions as predictionsTable, videoCreditReservations } from "@workspace/db/schema";
import {
  findOrCreateBillingAccount,
  hasPaidGenerationEntitlement,
  linkVideoCreditReservation,
  refundFailedPredictionCredits,
  refundUntrackedVideoCredits,
  reserveVideoCredits,
} from "../billing";
import { ReplicateRequestError, replicateRequest } from "../replicateClient";
import {
  downloadStoredVideo,
  fetchStoredVideo,
  isStoredVideoRoute,
  storedVideoRoute,
  storeVideo,
} from "../lib/videoStorage";
import { createImageUpload, getReferenceImageUrl } from "../lib/imageStorage";
import { maybeStartVoice } from "../lib/voiceWorkflow";
import type { VoiceStyle } from "../lib/voicePresets";
import {
  createVoiceUpload,
  downloadVoiceUpload,
  InvalidVoiceUploadError,
  MAX_VOICE_BYTES,
  validateVoiceRecording,
  VOICE_TYPES,
} from "../lib/voiceStorage";
import { logger } from "../lib/logger";

type PredictionStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

type VoiceMode = "none" | "text" | "upload";
type VoiceStatus = "none" | "pending" | "processing" | "succeeded" | "failed";

type StoredPrediction = {
  id: string;
  creditReservationId: string | null;
  billingAccountId: string | null;
  creditsCharged: number;
  creditsRefundedAt: string | null;
  status: PredictionStatus;
  prompt: string;
  modelId: string;
  modelName: string;
  aspectRatio: string;
  duration: number;
  outputUrl: string | null;
  error: string | null;
  createdAt: string;
  progress: number;
  thumbnail: string | null;
  lipSyncEnabled: boolean;
  lipSyncPredictionId: string | null;
  voiceMode: VoiceMode;
  voiceStyle: VoiceStyle;
  voiceText: string | null;
  voiceUploadId: string | null;
  voiceStatus: VoiceStatus;
  voiceObjectId: string | null;
  voiceError: string | null;
};

const router: IRouter = Router();
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function authenticatedUserId(req: Parameters<typeof getAuth>[0]) {
  const auth = getAuth(req);
  return auth.sessionClaims?.userId as string | undefined ?? auth.userId;
}

async function authenticatedEmail(req: Parameters<typeof getAuth>[0]) {
  const userId = authenticatedUserId(req);
  if (!userId) return null;
  const user = await clerkClient.users.getUser(userId);
  return user.primaryEmailAddress?.emailAddress?.trim().toLowerCase() ?? null;
}

const requireAuth: RequestHandler = (req, res, next) => {
  if (!authenticatedUserId(req)) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
};

const models = [
  {
    id: "kwaivgi/kling-v2.5-turbo-pro",
    name: "Kling 2.5 Turbo Pro",
    provider: "Kling",
    description: "Fast cinematic text-to-video generation",
    creditCosts: { 5: 5, 10: 10 },
    lipSyncCreditCosts: { 5: 2, 10: 11 },
    duration: "5 or 10 sec",
    image: "kling-2.5",
  },
  {
    id: "minimax/hailuo-2.3",
    name: "Hailuo 2.3",
    provider: "MiniMax · Replicate",
    description: "High-fidelity video with realistic motion and cinematic VFX",
    creditCosts: { 6: 5, 10: 5 },
    lipSyncCreditCosts: { 6: 6, 10: 6 },
    duration: "6 or 10 sec",
    image: "hailuo-2.3",
  },
];

function getModel(modelId: string) {
  return models.find((model) => model.id === modelId);
}

function outputUrl(output: unknown) {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (
    output &&
    typeof output === "object" &&
    "url" in output &&
    typeof output.url === "string"
  ) {
    return output.url;
  }
  return null;
}

async function downloadVideoBuffer(videoUrl: string) {
  const videoResponse = await fetch(videoUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!videoResponse.ok) {
    throw new Error(`Could not download the generated video (${videoResponse.status}).`);
  }

  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  if (videoBuffer.length > 150 * 1024 * 1024) {
    throw new Error("The generated video is too large to process.");
  }
  return videoBuffer;
}

async function recoverReplicateVideoUrl(predictionId: string) {
  const data = await replicateRequest<Record<string, unknown>>(
    `/v1/predictions/${predictionId}`,
  );
  return outputUrl(data.output);
}

async function ensurePersistentVideo(
  prediction: StoredPrediction,
  userId: string,
) {
  if (prediction.status !== "succeeded" || (prediction.outputUrl && isStoredVideoRoute(prediction.outputUrl))) {
    return prediction;
  }

  let sourceUrl = prediction.outputUrl;
  if (!sourceUrl) {
    if (prediction.voiceMode === "none") return prediction;
    sourceUrl = await recoverReplicateVideoUrl(prediction.id);
    if (!sourceUrl) throw new Error("The video provider did not return a playable video.");
  }
  let videoBuffer: Buffer;
  try {
    videoBuffer = await downloadVideoBuffer(sourceUrl);
  } catch {
    const recoveredUrl = await recoverReplicateVideoUrl(prediction.id);
    if (!recoveredUrl) {
      throw new Error("The original video is no longer available from the video provider.");
    }
    sourceUrl = recoveredUrl;
    videoBuffer = await downloadVideoBuffer(sourceUrl);
  }

  await storeVideo(userId, prediction.id, videoBuffer);
  const saved = {
    ...prediction,
    outputUrl: storedVideoRoute(prediction.id),
  };
  await savePrediction(saved, userId);
  return saved;
}

export async function predictionVideoBuffer(
  prediction: StoredPrediction,
  userId: string,
) {
  const saved = await ensurePersistentVideo(prediction, userId);
  if (saved.voiceMode !== "none" && saved.voiceStatus !== "succeeded") {
    throw new Error("Wait for the voice to finish before downloading this video.");
  }
  if (!saved.outputUrl) {
    throw new Error("The video output is unavailable.");
  }
  return isStoredVideoRoute(saved.outputUrl)
    ? downloadStoredVideo(
        userId,
        saved.id,
        saved.voiceMode === "none"
          ? "original"
          : saved.lipSyncEnabled
            ? "lip-synced"
            : saved.voiceObjectId
              ? `voiced-${saved.voiceObjectId}`
              : "voiced",
      )
    : downloadVideoBuffer(saved.outputUrl);
}

function toPrediction(data: Record<string, unknown>, fallback: StoredPrediction) {
  const status = data.status;
  const output = outputUrl(data.output);
  return {
    ...fallback,
    status:
      status === "starting" ||
      status === "processing" ||
      status === "succeeded" ||
      status === "failed" ||
      status === "canceled"
        ? status
        : fallback.status,
    outputUrl: output ?? fallback.outputUrl,
    error: typeof data.error === "string" ? data.error : fallback.error,
    progress:
      status === "succeeded"
        ? 100
        : status === "processing"
          ? 62
          : status === "starting"
            ? 18
            : fallback.progress,
  } satisfies StoredPrediction;
}

export function fromDatabase(row: typeof predictionsTable.$inferSelect): StoredPrediction {
  return {
    id: row.id,
    creditReservationId: row.creditReservationId,
    billingAccountId: row.billingAccountId,
    creditsCharged: row.creditsCharged,
    creditsRefundedAt: row.creditsRefundedAt?.toISOString() ?? null,
    status: row.status as PredictionStatus,
    prompt: row.prompt,
    modelId: row.modelId,
    modelName: row.modelName,
    aspectRatio: row.aspectRatio,
    duration: row.duration,
    outputUrl: row.outputUrl,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    progress: row.progress,
    thumbnail: row.thumbnail,
    lipSyncEnabled: row.lipSyncEnabled,
    lipSyncPredictionId: row.lipSyncPredictionId,
    voiceMode: row.voiceMode as VoiceMode,
    voiceStyle: row.voiceStyle as VoiceStyle,
    voiceText: row.voiceText,
    voiceUploadId: row.voiceUploadId,
    voiceStatus: row.voiceStatus as VoiceStatus,
    voiceObjectId: row.voiceObjectId,
    voiceError: row.voiceError,
  };
}

function forCustomer(prediction: StoredPrediction) {
  const {
    voiceText: _text,
    voiceUploadId: _uploadId,
    voiceObjectId: _objectId,
    lipSyncPredictionId: _lipSyncPredictionId,
    creditReservationId: _reservationId,
    billingAccountId: _accountId,
    creditsCharged: _creditsCharged,
    creditsRefundedAt: _refundedAt,
    voiceError,
    ...visible
  } = prediction;
  const customerPrediction = {
    ...visible,
    creditsRefunded: !!prediction.creditsRefundedAt,
    refundedCredits: prediction.creditsRefundedAt ? prediction.creditsCharged : 0,
    refundPending: (prediction.status === "failed" || prediction.status === "canceled")
      && prediction.creditsCharged > 0
      && !!prediction.creditReservationId
      && !prediction.creditsRefundedAt,
  };
  if (prediction.status === "succeeded" && prediction.voiceMode !== "none" && prediction.voiceStatus !== "succeeded") {
    return {
      ...customerPrediction,
      status: prediction.voiceStatus === "failed" ? "failed" : "processing",
      progress: prediction.voiceStatus === "failed" ? prediction.progress : 95,
      outputUrl: null,
      error: prediction.voiceStatus === "failed" ? voiceError || "Could not add your voice to this video." : null,
    };
  }
  return customerPrediction;
}

async function savePrediction(prediction: StoredPrediction, userId: string) {
  const [row] = await db
    .insert(predictionsTable)
    .values({
      id: prediction.id,
      userId,
      creditReservationId: prediction.creditReservationId,
      billingAccountId: prediction.billingAccountId,
      creditsCharged: prediction.creditsCharged,
      creditsRefundedAt: prediction.creditsRefundedAt ? new Date(prediction.creditsRefundedAt) : null,
      status: prediction.status,
      prompt: prediction.prompt,
      modelId: prediction.modelId,
      modelName: prediction.modelName,
      aspectRatio: prediction.aspectRatio,
      duration: prediction.duration,
      outputUrl: prediction.outputUrl,
      error: prediction.error,
      createdAt: new Date(prediction.createdAt),
      progress: prediction.progress,
      thumbnail: prediction.thumbnail,
      lipSyncEnabled: prediction.lipSyncEnabled,
      lipSyncPredictionId: prediction.lipSyncPredictionId,
      voiceMode: prediction.voiceMode,
      voiceStyle: prediction.voiceStyle,
      voiceText: prediction.voiceText,
      voiceUploadId: prediction.voiceUploadId,
      voiceStatus: prediction.voiceStatus,
      voiceError: prediction.voiceError,
    })
    .onConflictDoUpdate({
      target: predictionsTable.id,
      set: {
        status: sql`CASE WHEN ${predictionsTable.status} IN ('succeeded', 'failed', 'canceled') THEN ${predictionsTable.status} ELSE excluded.status END`,
        outputUrl: sql`CASE WHEN ${predictionsTable.outputUrl} LIKE '/api/predictions/%/video' THEN ${predictionsTable.outputUrl} ELSE excluded.output_url END`,
        error: prediction.error,
        progress: prediction.progress,
        thumbnail: prediction.thumbnail,
      },
    })
    .returning();
  return row ? fromDatabase(row) : prediction;
}

async function settlePredictionRefund(prediction: StoredPrediction): Promise<StoredPrediction> {
  if (
    (prediction.status !== "failed" && prediction.status !== "canceled") ||
    prediction.creditsRefundedAt ||
    prediction.creditsCharged <= 0 ||
    !prediction.creditReservationId
  ) {
    return prediction;
  }

  const refundedAt = await refundFailedPredictionCredits(prediction.id);
  if (refundedAt) return { ...prediction, creditsRefundedAt: refundedAt.toISOString() };

  const [current] = await db.select().from(predictionsTable)
    .where(eq(predictionsTable.id, prediction.id)).limit(1);
  return current ? fromDatabase(current) : prediction;
}

async function archiveAndStartVoice(prediction: StoredPrediction, userId: string) {
  try {
    const saved = await ensurePersistentVideo(prediction, userId);
    if (saved.status === "succeeded" && saved.outputUrl && isStoredVideoRoute(saved.outputUrl) && saved.voiceMode !== "none") {
      await maybeStartVoice(saved.id, userId);
    }
    return saved;
  } catch (error) {
    if (prediction.status === "succeeded" && prediction.voiceMode !== "none") {
      await db.update(predictionsTable)
        .set({
          voiceStatus: "failed",
          voiceClaimedAt: null,
          voiceClaimId: null,
          voiceError: "Could not save the video before adding voice. Try again.",
        })
        .where(and(
          eq(predictionsTable.id, prediction.id),
          eq(predictionsTable.userId, userId),
          eq(predictionsTable.voiceStatus, "pending"),
        ))
        .catch((dbError) => logger.error({ err: dbError, predictionId: prediction.id }, "Could not mark video archive failure"));
    }
    throw error;
  }
}

async function refreshPrediction(stored: StoredPrediction, userId: string) {
  if (["succeeded", "failed", "canceled"].includes(stored.status)) {
    return archiveAndStartVoice(await settlePredictionRefund(stored), userId);
  }

  const data = await replicateRequest<Record<string, unknown>>(
    `/v1/predictions/${stored.id}`,
  );
  const next = toPrediction(data, stored);
  const changed =
    next.status !== stored.status ||
    next.progress !== stored.progress ||
    next.outputUrl !== stored.outputUrl ||
    next.error !== stored.error;
  const persisted = changed ? await savePrediction(next, userId) : next;
  return archiveAndStartVoice(await settlePredictionRefund(persisted), userId);
}

router.get("/models", (_req, res) => {
  res.json(models);
});

router.post("/uploads/images", requireAuth, async (req, res) => {
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "";
  const size = Number(req.body?.size);
  if (!IMAGE_TYPES.has(contentType) || !Number.isInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) {
    res.status(400).json({ error: "Upload a JPEG, PNG, or WebP image up to 10 MB." });
    return;
  }
  try {
    res.json(await createImageUpload(authenticatedUserId(req)!, contentType));
  } catch (error) {
    req.log.error({ err: error }, "Could not create reference image upload");
    res.status(502).json({ error: "Could not prepare the image upload." });
  }
});

router.post("/uploads/voices", requireAuth, async (req, res) => {
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "";
  const size = Number(req.body?.size);
  if (!VOICE_TYPES.has(contentType) || !Number.isInteger(size) || size < 1 || size > MAX_VOICE_BYTES) {
    res.status(400).json({ error: "Upload an audio recording up to 20 MB (MP3, WAV, M4A, OGG, WebM, AAC, or FLAC)." });
    return;
  }
  try {
    res.json(await createVoiceUpload(authenticatedUserId(req)!, contentType));
  } catch (error) {
    req.log.error({ err: error }, "Could not create private voice upload");
    res.status(502).json({ error: "Could not prepare the voice recording upload." });
  }
});

router.get("/predictions", requireAuth, async (req, res) => {
  const userId = authenticatedUserId(req)!;
  try {
    const rows = await db
      .select()
      .from(predictionsTable)
      .where(eq(predictionsTable.userId, userId))
      .orderBy(desc(predictionsTable.createdAt))
      .limit(100);
    res.json(
      await Promise.all(
        rows.map(async (row) => {
          const stored = fromDatabase(row);
          try {
            return forCustomer(await refreshPrediction(stored, userId));
          } catch (error) {
            req.log.warn(
              { err: error, predictionId: stored.id },
              "Could not refresh video prediction",
            );
            return forCustomer(stored);
          }
        }),
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Could not load predictions");
    res.status(500).json({ error: "Could not load predictions." });
  }
});

router.post("/predictions", requireAuth, async (req, res) => {
  const userId = authenticatedUserId(req)!;
  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please add a prompt and select a valid model." });
    return;
  }

  const { prompt, modelId, aspectRatio, duration, expectedCreditCost, negativePrompt, imageUploadId, imagePurpose, voiceText, voiceUploadId } = parsed.data;
  const voiceMode = parsed.data.voiceMode ?? "none";
  const voiceStyle = parsed.data.voiceStyle ?? "male";
  const lipSyncEnabled = parsed.data.lipSyncEnabled ?? false;
  const model = getModel(modelId);
  if (!model) {
    res.status(400).json({ error: "Select a supported video model." });
    return;
  }
  const baseCreditCost = model.creditCosts[duration];
  if (!baseCreditCost) {
    res.status(400).json({ error: "Select a supported duration for this video model." });
    return;
  }
  if (lipSyncEnabled && (voiceMode === "none" || !imageUploadId || imagePurpose !== "avatar")) {
    res.status(400).json({ error: "Lip-sync requires narration and an uploaded person/avatar photo." });
    return;
  }
  const lipSyncCreditCost = model.lipSyncCreditCosts[duration];
  let creditCost = baseCreditCost;
  if (lipSyncEnabled) {
    if (lipSyncCreditCost === undefined) {
      res.status(400).json({ error: "Lip-sync is not available for this video duration." });
      return;
    }
    creditCost = lipSyncCreditCost;
  }
  if (expectedCreditCost !== undefined && expectedCreditCost !== creditCost) {
    res.status(409).json({ error: "This video's credit cost has changed. Refresh the page and review the new amount before trying again." });
    return;
  }
  if (
    (voiceMode === "text" && (!voiceText?.trim() || voiceText.trim().length < 3 || voiceUploadId)) ||
    (voiceMode === "upload" && (!voiceUploadId || voiceText?.trim())) ||
    (voiceMode === "none" && (voiceText?.trim() || voiceUploadId))
  ) {
    res.status(400).json({ error: "Choose a voice option and provide its script or recording." });
    return;
  }
  if (voiceMode === "upload" && voiceUploadId) {
    try {
      await validateVoiceRecording(await downloadVoiceUpload(userId, voiceUploadId));
    } catch (error) {
      req.log.warn({ err: error }, "Could not validate customer voice recording");
      res.status(error instanceof InvalidVoiceUploadError ? 400 : 502).json({
        error: error instanceof InvalidVoiceUploadError
          ? error.message
          : "Could not verify the voice recording. Please try again.",
      });
      return;
    }
  }
  let billingAccount;
  let reservationId = "";
  try {
    const email = await authenticatedEmail(req);
    if (!email) {
      res.status(422).json({ error: "Your account does not have a primary email address." });
      return;
    }
    billingAccount = await findOrCreateBillingAccount(email);
    const reserved = await reserveVideoCredits(billingAccount.id, creditCost);
    if (!reserved) {
      const hasPaidEntitlement = await hasPaidGenerationEntitlement(billingAccount.id);
      res.status(402).json({
        error: `You need at least ${creditCost} credits from a completed purchase or an active paid plan to start this video.`,
        creditsRemaining: hasPaidEntitlement ? billingAccount.creditsRemaining : 0,
      });
      return;
    }
    reservationId = reserved.reservationId;
  } catch (error) {
    req.log.error({ err: error }, "Could not reserve video credits");
    res.status(500).json({ error: "Could not verify your credit balance." });
    return;
  }
  const actualDuration = duration;
  const actualAspectRatio = aspectRatio;
  const negativeInput = negativePrompt ? { negative_prompt: negativePrompt } : {};
  if (
    model.id === "minimax/hailuo-2.3" &&
    duration !== 6 &&
    duration !== 10
  ) {
    res.status(400).json({ error: "Hailuo 2.3 supports 6- or 10-second video clips." });
    return;
  }

  const compositionPrompt = `${prompt}\n\nComposition: ${aspectRatio}.`;
  let referenceImageUrl: string | undefined;
  if (imageUploadId) {
    try {
      referenceImageUrl = await getReferenceImageUrl(userId, imageUploadId);
    } catch (error) {
      await refundUntrackedVideoCredits(reservationId).catch((refundError) => {
        req.log.error({ err: refundError, reservationId }, "Could not refund rejected reference image yet; worker will retry");
      });
      req.log.warn({ err: error }, "Could not load reference image");
      res.status(400).json({ error: "The reference image is unavailable. Please upload it again." });
      return;
    }
  }
  const purposePrompt = imagePurpose === "avatar"
    ? `${compositionPrompt}\nKeep the uploaded person's identity and appearance consistent.`
    : imagePurpose === "product"
      ? `${compositionPrompt}\nKeep the uploaded product's shape, colors, branding, and details consistent.`
      : compositionPrompt;
  const replicateInput =
    model.id === "minimax/hailuo-2.3"
      ? {
          prompt: negativePrompt
            ? `${purposePrompt}\nAvoid: ${negativePrompt}.`
            : purposePrompt,
          duration,
          resolution: duration === 10 ? "768p" : "1080p",
          prompt_optimizer: true,
          ...(referenceImageUrl ? { first_frame_image: referenceImageUrl } : {}),
        }
      : {
          prompt: purposePrompt,
          duration,
          aspect_ratio: aspectRatio,
          ...negativeInput,
          ...(referenceImageUrl ? { start_image: referenceImageUrl } : {}),
        };

  let predictionSaved = false;
  let providerId: string | null = null;
  try {
    const data = await replicateRequest<Record<string, unknown>>(
      `/v1/models/${model.id}/predictions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "wait=5",
        },
        body: JSON.stringify({ input: replicateInput }),
      },
    );
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) throw new Error("Replicate did not return a prediction ID.");
    providerId = id;
    await linkVideoCreditReservation(reservationId, id);

    const fallback: StoredPrediction = {
      id,
      creditReservationId: reservationId,
      billingAccountId: billingAccount.id,
      creditsCharged: creditCost,
      creditsRefundedAt: null,
      status: "starting",
      prompt,
      modelId: model.id,
      modelName: model.name,
      aspectRatio: actualAspectRatio,
      duration: actualDuration,
      outputUrl: null,
      error: null,
      createdAt: new Date().toISOString(),
      progress: 12,
      thumbnail: null,
      lipSyncEnabled,
      lipSyncPredictionId: null,
      voiceMode,
      voiceStyle: voiceMode === "text" ? voiceStyle : "male",
      voiceText: voiceMode === "text" ? voiceText!.trim() : null,
      voiceUploadId: voiceMode === "upload" ? voiceUploadId! : null,
      voiceStatus: voiceMode === "none" ? "none" : "pending",
      voiceObjectId: null,
      voiceError: null,
    };

    let prediction = toPrediction(data, fallback);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        prediction = await savePrediction(prediction, userId);
        predictionSaved = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 250));
      }
    }
    if (prediction.status === "failed" || prediction.status === "canceled") {
      try {
        prediction = await settlePredictionRefund(prediction);
      } catch (refundError) {
        req.log.error({ err: refundError, predictionId: prediction.id }, "Could not refund failed video yet; worker will retry");
      }
    }
    res.status(201).json(forCustomer(prediction));
  } catch (error) {
    if (!predictionSaved) {
      await refundUntrackedVideoCredits(reservationId).catch((refundError) => {
        req.log.error({ err: refundError, providerId, reservationId }, "Could not refund untracked video credits yet; worker will retry");
      });
    }
    req.log.error({ err: error, providerId, predictionSaved }, "Video prediction creation failed");
    const isProviderNotFound =
      error instanceof ReplicateRequestError && error.status === 404;
    res.status(isProviderNotFound ? 424 : 502).json({
      error:
        isProviderNotFound
          ? "The selected video model is unavailable for this account."
          : error instanceof Error
            ? error.message
            : "Could not start the video prediction.",
    });
  }
});

router.get("/predictions/:id", requireAuth, async (req, res) => {
  const userId = authenticatedUserId(req)!;
  const parsed = GetPredictionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }

  const rows = await db
    .select()
    .from(predictionsTable)
    .where(
      and(
        eq(predictionsTable.id, parsed.data.id),
        eq(predictionsTable.userId, userId),
      ),
    )
    .limit(1);
  const stored = rows[0] ? fromDatabase(rows[0]) : undefined;
  if (!stored) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }

  try {
    res.json(forCustomer(await refreshPrediction(stored, userId)));
  } catch (error) {
    req.log.error({ err: error }, "Replicate prediction refresh failed");
    res.json(forCustomer(stored));
  }
});

router.get("/predictions/:id/video", requireAuth, async (req, res) => {
  const userId = authenticatedUserId(req)!;
  const parsed = GetPredictionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }

  const rows = await db
    .select()
    .from(predictionsTable)
    .where(
      and(
        eq(predictionsTable.id, parsed.data.id),
        eq(predictionsTable.userId, userId),
      ),
    )
    .limit(1);
  const prediction = rows[0] ? fromDatabase(rows[0]) : undefined;
  if (!prediction) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }
  if (prediction.voiceMode !== "none" && prediction.voiceStatus !== "succeeded") {
    res.status(409).json({ error: "Wait for the voice to finish before playing this video." });
    return;
  }

  try {
    const saved = await ensurePersistentVideo(prediction, userId);
    if (!saved.outputUrl || !isStoredVideoRoute(saved.outputUrl)) {
      res.status(410).json({ error: "This video is no longer available." });
      return;
    }
    const storageResponse = await fetchStoredVideo(
      userId,
      saved.id,
      req.get("range"),
      saved.voiceMode === "none"
        ? "original"
        : saved.lipSyncEnabled
          ? "lip-synced"
          : saved.voiceObjectId
            ? `voiced-${saved.voiceObjectId}`
            : "voiced",
    );
    res.status(storageResponse.status);
    for (const header of [
      "accept-ranges",
      "content-length",
      "content-range",
      "content-type",
    ]) {
      const value = storageResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (!storageResponse.body) {
      res.end();
      return;
    }
    Readable.fromWeb(
      storageResponse.body as ReadableStream<Uint8Array>,
    ).pipe(res);
  } catch (error) {
    req.log.error(
      { err: error, predictionId: prediction.id },
      "Could not stream saved video",
    );
    res.status(410).json({
      error:
        error instanceof Error
          ? error.message
          : "This video is no longer available.",
    });
  }
});

router.get("/predictions/:id/download", requireAuth, async (req, res) => {
  const userId = authenticatedUserId(req)!;
  const parsed = GetPredictionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }

  const rows = await db
    .select()
    .from(predictionsTable)
    .where(
      and(
        eq(predictionsTable.id, parsed.data.id),
        eq(predictionsTable.userId, userId),
      ),
    )
    .limit(1);
  const prediction = rows[0] ? fromDatabase(rows[0]) : undefined;
  if (!prediction) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }
  if (prediction.status !== "succeeded" || !prediction.outputUrl) {
    res.status(400).json({ error: "Wait for the video to finish before downloading it." });
    return;
  }
  if (prediction.voiceMode !== "none" && prediction.voiceStatus !== "succeeded") {
    res.status(409).json({ error: "Wait for the voice to finish before downloading this video." });
    return;
  }

  try {
    const videoBuffer = await predictionVideoBuffer(prediction, userId);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="clicpai-${prediction.id.slice(0, 8)}-video.mp4"`,
    );
    res.send(videoBuffer);
  } catch (error) {
    req.log.error(
      { err: error, predictionId: prediction.id },
      "Could not download completed video",
    );
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not download the video.",
    });
  }
});

router.post("/predictions/:id/voice-retry", requireAuth, async (req, res) => {
  const userId = authenticatedUserId(req)!;
  const parsed = GetPredictionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "Prediction not found." });
    return;
  }

  try {
    const [row] = await db.update(predictionsTable)
      .set({ voiceStatus: "pending", voiceError: null, voiceClaimedAt: null, voiceClaimId: null })
      .where(and(
        eq(predictionsTable.id, parsed.data.id),
        eq(predictionsTable.userId, userId),
        eq(predictionsTable.status, "succeeded"),
        eq(predictionsTable.voiceStatus, "failed"),
      ))
      .returning();
    if (!row) {
      const [existing] = await db.select({ id: predictionsTable.id })
        .from(predictionsTable)
        .where(and(eq(predictionsTable.id, parsed.data.id), eq(predictionsTable.userId, userId)))
        .limit(1);
      res.status(existing ? 409 : 404).json({
        error: existing ? "Voice can only be retried after a failed attempt." : "Prediction not found.",
      });
      return;
    }
    const prediction = fromDatabase(row);
    if (prediction.outputUrl && isStoredVideoRoute(prediction.outputUrl)) {
      await maybeStartVoice(prediction.id, userId);
    }
    res.status(202).json(forCustomer(prediction));
  } catch (error) {
    req.log.error(
      { err: error, predictionId: parsed.data.id },
      "Could not retry voice processing",
    );
    res.status(502).json({ error: "Could not retry voice processing." });
  }
});

export function startPredictionWorker() {
  let working = false;
  let providerCursor: { createdAt: Date; id: string } | null = null;
  let refundCursor: { createdAt: Date; id: string } | null = null;
  let orphanCursor: { createdAt: Date; id: string } | null = null;
  const tick = async () => {
    if (working) return;
    working = true;
    try {
      const voiceRows = await db.select().from(predictionsTable)
        .where(and(
          eq(predictionsTable.status, "succeeded"),
          inArray(predictionsTable.voiceStatus, ["pending", "processing"]),
        ))
        .orderBy(asc(predictionsTable.createdAt))
        .limit(25);
      const pendingRefund = and(
          inArray(predictionsTable.status, ["failed", "canceled"]),
          gt(predictionsTable.creditsCharged, 0),
          isNotNull(predictionsTable.creditReservationId),
          isNull(predictionsTable.creditsRefundedAt),
        );
      const refundFilter = refundCursor ? and(
        pendingRefund,
        or(
          gt(predictionsTable.createdAt, refundCursor.createdAt),
          and(
            eq(predictionsTable.createdAt, refundCursor.createdAt),
            gt(predictionsTable.id, refundCursor.id),
          ),
        ),
      ) : pendingRefund;
      const refundRows = await db.select().from(predictionsTable)
        .where(refundFilter)
        .orderBy(asc(predictionsTable.createdAt), asc(predictionsTable.id))
        .limit(25);
      const lastRefund = refundRows.at(-1);
      refundCursor = lastRefund ? { createdAt: lastRefund.createdAt, id: lastRefund.id } : null;
      const staleReservation = and(
        isNull(videoCreditReservations.refundedAt),
        lt(videoCreditReservations.createdAt, new Date(Date.now() - 20 * 60_000)),
        sql`not exists (
          select 1 from ${predictionsTable}
          where ${predictionsTable.creditReservationId} = ${videoCreditReservations.id}
        )`,
      );
      const orphanFilter = orphanCursor ? and(
        staleReservation,
        or(
          gt(videoCreditReservations.createdAt, orphanCursor.createdAt),
          and(
            eq(videoCreditReservations.createdAt, orphanCursor.createdAt),
            gt(videoCreditReservations.id, orphanCursor.id),
          ),
        ),
      ) : staleReservation;
      const orphanRows = await db.select().from(videoCreditReservations)
        .where(orphanFilter)
        .orderBy(asc(videoCreditReservations.createdAt), asc(videoCreditReservations.id))
        .limit(25);
      const lastOrphan = orphanRows.at(-1);
      orphanCursor = lastOrphan ? { createdAt: lastOrphan.createdAt, id: lastOrphan.id } : null;
      const pendingProvider = inArray(predictionsTable.status, ["starting", "processing"]);
      const providerFilter = providerCursor
        ? and(
            pendingProvider,
            or(
              gt(predictionsTable.createdAt, providerCursor.createdAt),
              and(
                eq(predictionsTable.createdAt, providerCursor.createdAt),
                gt(predictionsTable.id, providerCursor.id),
              ),
            ),
          )
        : pendingProvider;
      const providerRows = await db.select().from(predictionsTable)
        .where(providerFilter)
        .orderBy(asc(predictionsTable.createdAt), asc(predictionsTable.id))
        .limit(25);
      const last = providerRows.at(-1);
      providerCursor = last ? { createdAt: last.createdAt, id: last.id } : null;
      const rows = [...refundRows, ...voiceRows, ...providerRows];
      for (let index = 0; index < rows.length; index += 4) {
        await Promise.all(rows.slice(index, index + 4).map(async (row) => {
          if (!row.userId) return;
          try {
            await refreshPrediction(fromDatabase(row), row.userId);
          } catch (error) {
            logger.warn({ err: error, predictionId: row.id }, "Could not finish background video");
          }
        }));
      }
      for (let index = 0; index < orphanRows.length; index += 4) {
        await Promise.all(orphanRows.slice(index, index + 4).map(async (reservation) => {
          try {
            await refundUntrackedVideoCredits(reservation.id);
          } catch (error) {
            logger.error({ err: error, reservationId: reservation.id }, "Could not refund untracked video credits; worker will retry");
          }
        }));
      }
    } catch (error) {
      logger.error({ err: error }, "Could not poll unfinished videos");
    } finally {
      working = false;
    }
  };
  const interval = setInterval(() => { void tick(); }, 15_000);
  interval.unref();
  void tick();
}

export default router;