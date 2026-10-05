import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { billingAccounts, creditPurchases } from "@workspace/db/schema";
import {
  addCreditsForCheckout,
  findOrCreateBillingAccount,
  isPaygPaymentMethodAllowed,
  isValidPaygCheckoutAmount,
  PAYG_DURATIONS,
  quotePayg,
  resolveCheckoutBillingEmail,
  resolvePaygPaymentMethod,
} from "../src/billing";

test("PromptPay is only allowed for THB purchases, while card works in both currencies", () => {
  assert.equal(isPaygPaymentMethodAllowed("thb", "promptpay"), true);
  assert.equal(isPaygPaymentMethodAllowed("usd", "promptpay"), false);
  assert.equal(isPaygPaymentMethodAllowed("thb", "card"), true);
  assert.equal(isPaygPaymentMethodAllowed("usd", "card"), true);
});

test("checkout requests without a payment method remain card purchases", () => {
  assert.equal(resolvePaygPaymentMethod(), "card");
  assert.equal(resolvePaygPaymentMethod("promptpay"), "promptpay");
});

test("credits stay with the signed-in account when the payer uses another email", () => {
  assert.equal(
    resolveCheckoutBillingEmail("Account@Example.com", "payer@example.net"),
    "account@example.com",
  );
  assert.equal(
    resolveCheckoutBillingEmail(undefined, "payer@example.net"),
    "payer@example.net",
  );
});

test("all listed duration and currency quotes are required to match the charged amount", () => {
  for (const duration of PAYG_DURATIONS) {
    for (const currency of ["usd", "thb"] as const) {
      const amount = quotePayg(duration, currency);
      assert.equal(
        isValidPaygCheckoutAmount(duration, currency, amount, String(amount)),
        true,
      );
      assert.equal(
        isValidPaygCheckoutAmount(duration, currency, amount),
        true,
      );
      assert.equal(
        isValidPaygCheckoutAmount(duration, currency, amount + 1, String(amount)),
        false,
      );
      assert.equal(
        isValidPaygCheckoutAmount(duration, currency, amount, String(amount + 1)),
        false,
      );
    }
  }

  assert.equal(isValidPaygCheckoutAmount(9, "usd", 108), false);
  assert.equal(isValidPaygCheckoutAmount(181, "thb", 72_400), false);
  assert.equal(isValidPaygCheckoutAmount(15, "eur", 6_000), false);
});

test("confirmed credits update the remaining balance exactly once for every duration", async () => {
  const testId = randomUUID();
  const email = `billing-confirm-${testId}@example.invalid`;
  let accountId: string | undefined;

  try {
    const account = await findOrCreateBillingAccount(email);
    accountId = account.id;

    let expectedBalance = 0;
    for (const duration of PAYG_DURATIONS) {
      const sessionId = `cs_test_${testId}_${duration}`;
      expectedBalance += duration;

      const confirmations = await Promise.all(
        Array.from({ length: 3 }, () =>
          addCreditsForCheckout(email, sessionId, duration),
        ),
      );

      for (const confirmed of confirmations) {
        assert.equal(confirmed.creditsRemaining, expectedBalance);
      }
    }

    const [finalAccount] = await db
      .select({ creditsRemaining: billingAccounts.creditsRemaining })
      .from(billingAccounts)
      .where(eq(billingAccounts.id, accountId))
      .limit(1);
    const purchases = await db
      .select({ stripeSessionId: creditPurchases.stripeSessionId, credits: creditPurchases.credits })
      .from(creditPurchases)
      .where(eq(creditPurchases.billingAccountId, accountId));

    assert.equal(expectedBalance, 655);
    assert.equal(finalAccount?.creditsRemaining, expectedBalance);
    assert.equal(purchases.length, PAYG_DURATIONS.length);
    assert.deepEqual(
      purchases.map((purchase) => purchase.credits).sort((a, b) => a - b),
      [...PAYG_DURATIONS].sort((a, b) => a - b),
    );
    assert.equal(new Set(purchases.map((purchase) => purchase.stripeSessionId)).size, PAYG_DURATIONS.length);
  } finally {
    try {
      if (accountId) {
        await db.delete(creditPurchases).where(eq(creditPurchases.billingAccountId, accountId));
        await db.delete(billingAccounts).where(eq(billingAccounts.id, accountId));
      }
    } finally {
      await pool.end();
    }
  }
});