import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

type ReplicateError = {
  title?: string;
  detail?: string;
  status?: number;
};

export class ReplicateRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ReplicateRequestError";
  }
}

export async function replicateRequest<T>(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<T> {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  const response = token
    ? await fetch(`https://api.replicate.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      })
    : await connectors.proxy("replicate", path, init);
  const body = (await response.json().catch(() => null)) as
    | T
    | ReplicateError
    | null;

  if (!response.ok) {
    const error = body as ReplicateError | null;
    throw new ReplicateRequestError(
      error?.detail ?? error?.title ?? `Replicate request failed (${response.status})`,
      response.status,
    );
  }

  return body as T;
}