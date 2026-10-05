import { randomUUID } from "node:crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const IMAGE_UPLOAD_TTL_MS = 15 * 60 * 1000;

function privateImageLocation(userId: string, uploadId: string) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("Private image storage is not configured.");
  const fullPath = `${privateDir.replace(/\/$/, "")}/reference-images/${encodeURIComponent(userId)}/${uploadId}`;
  const parts = fullPath.replace(/^\/+/, "").split("/");
  const bucketName = parts.shift();
  if (!bucketName || parts.length === 0) {
    throw new Error("Private image storage path is invalid.");
  }
  return { bucketName, objectName: parts.join("/") };
}

async function signedImageUrl(
  userId: string,
  uploadId: string,
  method: "GET" | "PUT",
  contentType?: string,
) {
  const { bucketName, objectName } = privateImageLocation(userId, uploadId);
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
        expires_at: new Date(Date.now() + IMAGE_UPLOAD_TTL_MS).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not access private image storage (${response.status}).`);
  }
  const body = (await response.json()) as { signed_url?: string };
  if (!body.signed_url) throw new Error("Private image storage did not return a signed URL.");
  return body.signed_url;
}

export async function createImageUpload(userId: string, contentType: string) {
  const uploadId = randomUUID();
  return {
    uploadId,
    uploadUrl: await signedImageUrl(userId, uploadId, "PUT", contentType),
    contentType,
  };
}

export function getReferenceImageUrl(userId: string, uploadId: string) {
  return signedImageUrl(userId, uploadId, "GET");
}