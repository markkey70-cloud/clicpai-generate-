import { Router, type IRouter, type RequestHandler } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { z } from "zod";
import {
  CreateBillingCheckoutBody,
  CreateBillingCheckoutResponse,
} from "@workspace/api-zod";
import {
  addCreditsForCheckout,
  createStripeCheckoutSession,
  findOrCreateBillingAccount,
  hasPaidGenerationEntitlement,
  isPaygPaymentMethodAllowed,
  isValidPaygCheckoutAmount,
  PAYG_DURATIONS,
  PAYG_RATES,
  resolvePaygPaymentMethod,
  resolveCheckoutBillingEmail,
  quotePayg,
} from "../billing";
import { stripeForm, stripeRequest } from "../stripeClient";

const router: IRouter = Router();
const emailSchema = z.string().trim().email().max(320);
const checkoutSchema = CreateBillingCheckoutBody.extend({ email: emailSchema });
const confirmSchema = z.object({
  sessionId: z.string().startsWith("cs_").max(255),
});

function authenticatedUserId(req: Parameters<typeof getAuth>[0]) {
  const auth = getAuth(req);
  return auth.sessionClaims?.userId as string | undefined ?? auth.userId;
}

const requireAuth: RequestHandler = (req, res, next) => {
  if (!authenticatedUserId(req)) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
};

async function authenticatedEmail(req: Parameters<typeof getAuth>[0]) {
  const userId = authenticatedUserId(req);
  if (!userId) return null;
  const user = await clerkClient.users.getUser(userId);
  return user.primaryEmailAddress?.emailAddress?.trim().toLowerCase() ?? null;
}

function getAppUrl(req: { get(name: string): string | undefined; protocol: string }) {
  const origin = req.get("origin");
  if (origin) return origin;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domain) return `https://${domain}`;
  return `${req.protocol}://${req.get("host")}`;
}

router.get("/billing/plans", (_req, res) => {
  res.json({
    mode: "live_pay_as_you_go",
    rates: {
      usdPerSecond: PAYG_RATES.usdCentsPerSecond / 100,
      thbPerSecond: PAYG_RATES.thbSatangPerSecond / 100,
    },
    examples: PAYG_DURATIONS.map((seconds) => ({
      seconds,
      usdCents: quotePayg(seconds, "usd"),
      thbSatang: quotePayg(seconds, "thb"),
    })),
  });
});

type StripeProduct = { id: string };
type StripePrice = {
  id: string;
  currency: string;
  unit_amount: number | null;
  metadata?: Record<string, string>;
};

async function getPaygPrice(durationSeconds: number, currency: "usd" | "thb") {
  const products = await stripeRequest<{ data: StripeProduct[] }>(
    `/v1/products/search?${stripeForm({ query: "active:'true' AND metadata['product_key']:'video_seconds'" })}`,
  );
  let productId = products.data[0]?.id;
  if (!productId) {
    const product = await stripeRequest<StripeProduct>("/v1/products", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stripeForm({
        name: "CLICPai video generation",
        description: "Prepaid AI video generation time",
        "metadata[product_key]": "video_seconds",
      }),
    });
    productId = product.id;
  }

  const prices = await stripeRequest<{ data: StripePrice[] }>(
    `/v1/prices?${stripeForm({ product: productId, active: "true", limit: "100" })}`,
  );
  const amount = quotePayg(durationSeconds, currency);
  const existing = prices.data.find(
    (price) =>
      price.currency === currency &&
      price.unit_amount === amount &&
      price.metadata?.duration_seconds === String(durationSeconds),
  );
  if (existing) return existing.id;

  const price = await stripeRequest<StripePrice>("/v1/prices", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: stripeForm({
      product: productId,
      currency,
      unit_amount: String(amount),
      "metadata[duration_seconds]": String(durationSeconds),
    }),
  });
  return price.id;
}

router.get("/billing/account", requireAuth, async (req, res) => {
  try {
    const email = await authenticatedEmail(req);
    if (!email) {
      res.status(422).json({ error: "Your account does not have a primary email address." });
      return;
    }
    const account = await findOrCreateBillingAccount(email);
    const hasPaidEntitlement = await hasPaidGenerationEntitlement(account.id);
    res.json({
      creditsRemaining: hasPaidEntitlement ? account.creditsRemaining : 0,
      generationsUsed: account.generationsUsed,
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not load billing account");
    res.status(500).json({ error: "Could not load your credit balance." });
  }
});

router.post("/billing/checkout", requireAuth, async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Enter a valid email, duration, currency, and payment method.",
    });
    return;
  }

  const { email: payerEmail, durationSeconds, currency } = parsed.data;
  const paymentMethod = resolvePaygPaymentMethod(parsed.data.paymentMethod);
  if (!isPaygPaymentMethodAllowed(currency, paymentMethod)) {
    res.status(400).json({ error: "PromptPay is only available for THB purchases." });
    return;
  }

  try {
    const authenticated = await authenticatedEmail(req);
    if (!authenticated) {
      res.status(422).json({ error: "Your account does not have a primary email address." });
      return;
    }
    const appUrl = getAppUrl(req);
    const priceId = await getPaygPrice(durationSeconds, currency);
    const session = await createStripeCheckoutSession({
      mode: "payment",
      customer_email: payerEmail,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "payment_method_types[0]": paymentMethod,
      success_url: `${appUrl}/pricing?checkout=success&seconds=${durationSeconds}&currency=${currency}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing?checkout=cancelled`,
      "metadata[duration_seconds]": String(durationSeconds),
      "metadata[currency]": currency,
      "metadata[payment_method]": paymentMethod,
      "metadata[expected_amount]": String(quotePayg(durationSeconds, currency)),
      // Keep credit ownership tied to the signed-in account, not the payer email.
      "metadata[billing_email]": authenticated,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    res.json(CreateBillingCheckoutResponse.parse({ url: session.url }));
  } catch (error) {
    req.log.error({ err: error }, "Stripe checkout creation failed");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Could not start checkout.",
    });
  }
});

router.post("/billing/checkout/confirm", requireAuth, async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid checkout session." });
    return;
  }

  try {
    const authenticated = await authenticatedEmail(req);
    if (!authenticated) {
      res.status(422).json({ error: "Your account does not have a primary email address." });
      return;
    }
    const session = await stripeRequest<{
      payment_status?: string;
      status?: string;
      metadata?: Record<string, string>;
      customer_details?: { email?: string | null };
      currency?: string;
      amount_total?: number;
    }>(`/v1/checkout/sessions/${encodeURIComponent(parsed.data.sessionId)}`);
    const paid = session.payment_status === "paid" && session.status === "complete";
    const metadataCurrency = session.metadata?.currency?.toLowerCase();
    const sessionCurrency = session.currency?.toLowerCase();
    const expectedAmountRaw = session.metadata?.expected_amount;
    const expectedAmount =
      expectedAmountRaw === undefined ? null : Number(expectedAmountRaw);
    const sessionEmail = resolveCheckoutBillingEmail(
      session.metadata?.billing_email,
      session.customer_details?.email,
    );
    if (paid && sessionEmail !== authenticated) {
      res.status(403).json({ error: "This checkout does not belong to your account." });
      return;
    }
    const durationSeconds = Number(session.metadata?.duration_seconds ?? 0);
    if (paid && (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 180)) {
      res.status(400).json({ error: "This checkout has an invalid credit amount." });
      return;
    }
    const amountMatchesQuote =
      sessionCurrency === metadataCurrency &&
      isValidPaygCheckoutAmount(
        durationSeconds,
        metadataCurrency,
        session.amount_total,
        expectedAmountRaw,
      );
    if (paid && !amountMatchesQuote) {
      req.log.warn(
        {
          currency: session.currency,
          amountTotal: session.amount_total,
          expectedAmount,
        },
        "Stripe checkout total did not match its quote",
      );
      res.status(409).json({
        error:
          "The payment amount did not match the quoted price. Credits were not added; please contact support.",
      });
      return;
    }
    const account = paid
      ? await addCreditsForCheckout(authenticated, parsed.data.sessionId, durationSeconds)
      : null;
    res.status(paid ? 200 : 402).json({
      paid,
      durationSeconds,
      creditsRemaining: account?.creditsRemaining,
      currency: metadataCurrency ?? session.currency,
      amount: session.amount_total,
    });
  } catch (error) {
    req.log.error({ err: error }, "Stripe checkout confirmation failed");
    res.status(502).json({ error: "Could not verify the Stripe payment." });
  }
});

export default router;