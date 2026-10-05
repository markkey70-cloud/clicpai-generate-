const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

export type VideoVariant = "original" | "voiced" | "lip-synced" | `voiced-${string}`;

function privateVideoLocation(userId: string, predictionId: string, variant: VideoVariant) {
  if (variant !== "original" && variant !== "voiced" && variant !== "lip-synced" && !/^voiced-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(variant)) {
    throw new Error("The video variant identifier is invalid.");
  }
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) {
    throw new Error("Private video storage is not configured.");
  }
  const suffix = variant === "original" ? "" : `-${variant}`;
  const fullPath = `${privateDir.replace(/\/$/, "")}/videos/${encodeURIComponent(userId)}/${encodeURIComponent(predictionId)}${suffix}.mp4`;
  const parts = fullPath.replace(/^\/+/, "").split("/");
  const bucketName = parts.shift();
  if (!bucketName || parts.length === 0) {
    throw new Error("Private video storage path is invalid.");
  }
  return { bucketName, objectName: parts.join("/") };
}

async function signedVideoUrl(
  userId: string,
  predictionId: string,
  method: "GET" | "PUT",
  variant: VideoVariant = "original",
) {
  const { bucketName, objectName } = privateVideoLocation(userId, predictionId, variant);
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not access private video storage (${response.status}).`);
  }
  const body = (await response.json()) as { signed_url?: string };
  if (!body.signed_url) {
    throw new Error("Private video storage did not return a signed URL.");
  }
  return body.signed_url;
}

export function storedVideoRoute(predictionId: string) {
  return `/api/predictions/${encodeURIComponent(predictionId)}/video`;
}

export function isStoredVideoRoute(value: string) {
  return value.startsWith("/api/predictions/") && value.endsWith("/video");
}

export function getVideoProviderUrl(
  userId: string,
  predictionId: string,
  variant: VideoVariant,
) {
  return signedVideoUrl(userId, predictionId, "GET", variant);
}

export async function storeVideo(
  userId: string,
  predictionId: string,
  bytes: Buffer,
  variant: VideoVariant = "original",
) {
  if (bytes.length > MAX_VIDEO_BYTES) {
    throw new Error("The generated video is too large to save.");
  }
  const uploadUrl = await signedVideoUrl(userId, predictionId, "PUT", variant);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Could not save the generated video (${response.status}).`);
  }
}

export async function fetchStoredVideo(
  userId: string,
  predictionId: string,
  range?: string,
  variant: VideoVariant = "original",
) {
  const downloadUrl = await signedVideoUrl(userId, predictionId, "GET", variant);
  return fetch(downloadUrl, {
    headers: range ? { Range: range } : undefined,
    signal: AbortSignal.timeout(120_000),
  });
}

export async function downloadStoredVideo(
  userId: string,
  predictionId: string,
  variant: VideoVariant = "original",
) {
  const response = await fetchStoredVideo(userId, predictionId, undefined, variant);
  if (!response.ok) {
    throw new Error(`Could not load the saved video (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_VIDEO_BYTES) {
    throw new Error("The saved video is too large to process.");
  }
  return bytes;
}

export async function downloadStoredVideoIfPresent(
  userId: string,
  predictionId: string,
  variant: VideoVariant,
) {
  const response = await fetchStoredVideo(userId, predictionId, undefined, variant);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not load the saved video (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_VIDEO_BYTES) {
    throw new Error("The saved video is too large to process.");
  }
  return bytes;
}