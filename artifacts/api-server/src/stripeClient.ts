import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

type StripeRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export async function stripeRequest<T>(
  path: string,
  init: StripeRequestInit = {},
): Promise<T> {
  const response = await connectors.proxy("stripe", path, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const stripeError =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : null;
    const message =
      stripeError ??
      (body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Stripe request failed with status ${response.status}`);
    throw new Error(message);
  }

  return body as T;
}

export function stripeForm(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}