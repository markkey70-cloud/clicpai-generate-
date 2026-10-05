import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { billingAccounts, creditPurchases, predictions, videoCreditReservations } from "@workspace/db/schema";
import { stripeForm, stripeRequest } from "./stripeClient";

export const PAYG_DURATIONS = [10, 15, 30, 60, 90, 120, 150, 180] as const;

export const PAYG_RATES = {
  usdCentsPerSecond: 12,
  thbSatangPerSecond: 400,
} as const;

export function quotePayg(durationSeconds: number, currency: "usd" | "thb") {
  return currency === "usd"
    ? durationSeconds * PAYG_RATES.usdCentsPerSecond
    : durationSeconds * PAYG_RATES.thbSatangPerSecond;
}

export type PaygPaymentMethod = "card" | "promptpay";

export function resolvePaygPaymentMethod(
  paymentMethod?: PaygPaymentMethod,
): PaygPaymentMethod {
  return paymentMethod ?? "card";
}

export function resolveCheckoutBillingEmail(
  accountEmail: string | null | undefined,
  payerEmail: string | null | undefined,
) {
  return (accountEmail ?? payerEmail)?.trim().toLowerCase();
}

export function isPaygPaymentMethodAllowed(
  currency: "usd" | "thb",
  paymentMethod: PaygPaymentMethod,
) {
  return paymentMethod === "card" || currency === "thb";
}

export function isValidPaygCheckoutAmount(
  durationSeconds: number,
  currency: string | undefined,
  amountTotal: number | undefined,
  expectedAmountRaw?: string | null,
) {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 10 ||
    durationSeconds > 180 ||
    (currency !== "usd" && currency !== "thb")
  ) {
    return false;
  }

  const quotedAmount = quotePayg(durationSeconds, currency);
  const expectedAmount = expectedAmountRaw == null
    ? quotedAmount
    : Number(expectedAmountRaw);
  return (
    Number.isSafeInteger(amountTotal) &&
    amountTotal === quotedAmount &&
    Number.isSafeInteger(expectedAmount) &&
    expectedAmount === quotedAmount
  );
}

export const BILLING_PLANS = {
  free_trial: {
    name: "Free Trial",
    monthlyCredits: 0,
    amount: 0,
  },
  creator_mini: {
    name: "Creator Mini",
    monthlyCredits: 100,
    amount: 1900,
  },
  pro_studio: {
    name: "Pro Studio",
    monthlyCredits: 240,
    amount: 3900,
  },
} as const;

export type PaidPlanKey = "creator_mini" | "pro_studio";

type StripeProduct = {
  id: string;
  metadata?: Record<string, string>;
};

type StripePrice = {
  id: string;
  product: string | StripeProduct;
  unit_amount: number | null;
  currency: string;
  recurring?: { interval?: string } | null;
};

function isPaidPlanKey(value: unknown): value is PaidPlanKey {
  return value === "creator_mini" || value === "pro_studio";
}

function toPlanKey(price: StripePrice): PaidPlanKey | null {
  const product = typeof price.product === "string" ? null : price.product;
  const key = product?.metadata?.plan_key;
  return isPaidPlanKey(key) ? key : null;
}

export async function getPaidPrices() {
  const prices = await stripeRequest<{ data: StripePrice[] }>(
    "/v1/prices?active=true&type=recurring&limit=100&expand[]=data.product",
  );

  return prices.data
    .map((price) => {
      const planKey = toPlanKey(price);
      if (!planKey) return null;
      return {
        planKey,
        priceId: price.id,
        amount: price.unit_amount ?? 0,
        currency: price.currency,
        interval: price.recurring?.interval ?? "month",
      };
    })
    .filter((price): price is NonNullable<typeof price> => price !== null);
}

export async function getPriceForPlan(planKey: PaidPlanKey) {
  const price = (await getPaidPrices()).find((item) => item.planKey === planKey);
  if (!price) {
    throw new Error(`Stripe price for ${planKey} is not configured.`);
  }
  return price;
}

export async function findOrCreateBillingAccount(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.email, normalizedEmail))
    .limit(1);
  if (existing[0]) return existing[0];

  const created = await db
    .insert(billingAccounts)
    .values({
      id: randomUUID(),
      email: normalizedEmail,
      creditsRemaining: 0,
    })
    .returning();
  return created[0];
}

export async function hasPaidGenerationEntitlement(accountId: string) {
  const purchases = await db
    .select({ id: creditPurchases.id })
    .from(creditPurchases)
    .where(
      and(
        eq(creditPurchases.billingAccountId, accountId),
        sql`${creditPurchases.credits} > 0`,
      ),
    )
    .limit(1);
  if (purchases.length > 0) return true;

  const accounts = await db
    .select({
      planKey: billingAccounts.planKey,
      subscriptionStatus: billingAccounts.subscriptionStatus,
      currentPeriodEnd: billingAccounts.currentPeriodEnd,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.id, accountId))
    .limit(1);
  const account = accounts[0];
  return Boolean(
    account &&
      (account.planKey === "creator_mini" || account.planKey === "pro_studio") &&
      account.subscriptionStatus === "active" &&
      account.currentPeriodEnd &&
      account.currentPeriodEnd.getTime() > Date.now(),
  );
}

export async function addCreditsForCheckout(
  email: string,
  sessionId: string,
  credits: number,
) {
  const account = await findOrCreateBillingAccount(email);
  return db.transaction(async (tx) => {
    const purchase = await tx
      .insert(creditPurchases)
      .values({
        id: randomUUID(),
        stripeSessionId: sessionId,
        billingAccountId: account.id,
        credits,
      })
      .onConflictDoNothing({ target: creditPurchases.stripeSessionId })
      .returning({ id: creditPurchases.id });

    if (!purchase.length) {
      return (await tx
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.id, account.id))
        .limit(1))[0] ?? account;
    }

    const updated = await tx
      .update(billingAccounts)
      .set({
        creditsRemaining: sql`${billingAccounts.creditsRemaining} + ${credits}`,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.id, account.id))
      .returning();
    return updated[0] ?? account;
  });
}

export async function reserveVideoCredits(accountId: string, credits: number) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .update(billingAccounts)
      .set({
        creditsRemaining: sql`${billingAccounts.creditsRemaining} - ${credits}`,
        generationsUsed: sql`${billingAccounts.generationsUsed} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(billingAccounts.id, accountId),
          sql`${billingAccounts.creditsRemaining} >= ${credits}`,
          sql`(
            exists (
              select 1
              from ${creditPurchases}
              where ${creditPurchases.billingAccountId} = ${billingAccounts.id}
                and ${creditPurchases.credits} > 0
            )
            or (
              ${billingAccounts.planKey} in ('creator_mini', 'pro_studio')
              and ${billingAccounts.subscriptionStatus} = 'active'
              and ${billingAccounts.currentPeriodEnd} > now()
            )
          )`,
        ),
      )
      .returning();
    if (!account) return null;

    const reservationId = randomUUID();
    await tx.insert(videoCreditReservations).values({
      id: reservationId,
      billingAccountId: accountId,
      credits,
    });
    return { reservationId };
  });
}

export async function linkVideoCreditReservation(reservationId: string, predictionId: string) {
  const [linked] = await db
    .update(videoCreditReservations)
    .set({ predictionId })
    .where(and(
      eq(videoCreditReservations.id, reservationId),
      isNull(videoCreditReservations.refundedAt),
    ))
    .returning({ id: videoCreditReservations.id });
  if (!linked) throw new Error("The credit reservation for this video has expired.");
}

async function restoreReservedCredits(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  accountId: string,
  credits: number,
) {
  const [account] = await tx
    .update(billingAccounts)
    .set({
      creditsRemaining: sql`${billingAccounts.creditsRemaining} + ${credits}`,
      generationsUsed: sql`greatest(${billingAccounts.generationsUsed} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.id, accountId))
    .returning({ id: billingAccounts.id });
  if (!account) throw new Error("Could not find the account for this video refund.");
}

export async function refundUntrackedVideoCredits(reservationId: string) {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .update(videoCreditReservations)
      .set({ refundedAt: new Date() })
      .where(and(
        eq(videoCreditReservations.id, reservationId),
        isNull(videoCreditReservations.refundedAt),
        sql`not exists (
          select 1 from ${predictions}
          where ${predictions.creditReservationId} = ${videoCreditReservations.id}
        )`,
      ))
      .returning({
        billingAccountId: videoCreditReservations.billingAccountId,
        credits: videoCreditReservations.credits,
        refundedAt: videoCreditReservations.refundedAt,
      });
    if (!claim) return null;
    await restoreReservedCredits(tx, claim.billingAccountId, claim.credits);
    return claim.refundedAt;
  });
}

export async function refundFailedPredictionCredits(predictionId: string) {
  return db.transaction(async (tx) => {
    const [prediction] = await tx
      .select({
        status: predictions.status,
        reservationId: predictions.creditReservationId,
      })
      .from(predictions)
      .where(eq(predictions.id, predictionId))
      .limit(1);
    if (
      !prediction?.reservationId ||
      (prediction.status !== "failed" && prediction.status !== "canceled")
    ) return null;

    const [claim] = await tx
      .update(videoCreditReservations)
      .set({ refundedAt: new Date() })
      .where(
        and(
          eq(videoCreditReservations.id, prediction.reservationId),
          isNull(videoCreditReservations.refundedAt),
        ),
      )
      .returning({
        billingAccountId: videoCreditReservations.billingAccountId,
        credits: videoCreditReservations.credits,
        refundedAt: videoCreditReservations.refundedAt,
      });
    if (claim) {
      await restoreReservedCredits(tx, claim.billingAccountId, claim.credits);
    }
    const refundedAt = claim?.refundedAt ?? (await tx
      .select({ refundedAt: videoCreditReservations.refundedAt })
      .from(videoCreditReservations)
      .where(eq(videoCreditReservations.id, prediction.reservationId))
      .limit(1))[0]?.refundedAt;
    if (!refundedAt) return null;
    const [marked] = await tx
      .update(predictions)
      .set({ creditsRefundedAt: refundedAt })
      .where(eq(predictions.id, predictionId))
      .returning({ id: predictions.id });
    if (!marked) throw new Error("Could not mark the refunded video.");
    return refundedAt;
  });
}

export async function syncAccountFromStripe(
  email: string,
  existingAccount?: Awaited<ReturnType<typeof findOrCreateBillingAccount>>,
) {
  const account = existingAccount ?? (await findOrCreateBillingAccount(email));
  if (!account.stripeCustomerId) return account;

  const subscriptions = await stripeRequest<{
    data: Array<{
      id: string;
      status: string;
      current_period_end?: number;
      items?: { data?: Array<{ price?: StripePrice }> };
    }>;
  }>(
    `/v1/subscriptions?customer=${encodeURIComponent(account.stripeCustomerId)}&status=all&limit=10&expand[]=data.items.data.price.product`,
  );
  const subscription = subscriptions.data.find((item) =>
    ["active", "trialing", "past_due"].includes(item.status),
  );
  if (!subscription) return account;

  const price = subscription.items?.data?.[0]?.price;
  const planKey = price ? toPlanKey(price) : null;
  const normalizedPlan: PaidPlanKey = planKey ?? "creator_mini";
  const updated = await db
    .update(billingAccounts)
    .set({
      stripeSubscriptionId: subscription.id,
      planKey: normalizedPlan,
      subscriptionStatus: subscription.status,
      creditsRemaining: BILLING_PLANS[normalizedPlan].monthlyCredits,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.id, account.id))
    .returning();
  return updated[0] ?? account;
}

export async function createStripeCustomer(email: string, accountId: string) {
  return stripeRequest<{ id: string }>(
    "/v1/customers",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stripeForm({
        email,
        "metadata[billingAccountId]": accountId,
      }),
    },
  );
}

export async function createStripeCheckoutSession(values: Record<string, string>) {
  return stripeRequest<{ url: string | null }>(
    "/v1/checkout/sessions",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stripeForm(values),
    },
  );
}

export async function createStripePortalSession(customerId: string, returnUrl: string) {
  return stripeRequest<{ url: string }>(
    "/v1/billing_portal/sessions",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stripeForm({ customer: customerId, return_url: returnUrl }),
    },
  );
}