import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  billingAccounts,
  creditPurchases,
  predictions,
  videoCreditReservations,
} from "@workspace/db/schema";
import {
  linkVideoCreditReservation,
  refundFailedPredictionCredits,
  refundUntrackedVideoCredits,
  reserveVideoCredits,
} from "../src/billing";

test("video credits are reserved and refunded exactly once across retries", async () => {
  const testId = randomUUID();
  const accountId = `refund-test-${testId}`;
  const userId = `refund-test-user-${testId}`;

  const readAccount = async () => {
    const [account] = await db.select().from(billingAccounts)
      .where(eq(billingAccounts.id, accountId)).limit(1);
    assert.ok(account);
    return account;
  };

  const reserve = async () => {
    const reservation = await reserveVideoCredits(accountId, 5);
    assert.ok(reservation);
    return reservation.reservationId;
  };

  const addPrediction = async (reservationId: string, status: "starting" | "failed" | "canceled") => {
    const id = `refund-test-prediction-${randomUUID()}`;
    await linkVideoCreditReservation(reservationId, id);
    await db.insert(predictions).values({
      id,
      userId,
      creditReservationId: reservationId,
      billingAccountId: accountId,
      creditsCharged: 5,
      status,
      prompt: "Refund integration test",
      modelId: "test/model",
      modelName: "Test model",
      aspectRatio: "16:9",
      duration: 5,
      createdAt: new Date(),
    });
    return id;
  };

  try {
    await db.insert(billingAccounts).values({
      id: accountId,
      email: `${testId}@example.invalid`,
      creditsRemaining: 10,
    });
    await db.insert(creditPurchases).values({
      id: `refund-test-purchase-${testId}`,
      stripeSessionId: `refund-test-session-${testId}`,
      billingAccountId: accountId,
      credits: 10,
    });

    const firstReservation = await reserve();
    assert.equal((await readAccount()).creditsRemaining, 5);
    const failedId = await addPrediction(firstReservation, "failed");
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => refundFailedPredictionCredits(failedId)),
    );
    assert.ok(concurrent.some(Boolean));
    assert.equal((await readAccount()).creditsRemaining, 10);
    assert.equal((await readAccount()).generationsUsed, 0);
    assert.ok((await db.select().from(predictions).where(eq(predictions.id, failedId)))[0].creditsRefundedAt);
    await refundFailedPredictionCredits(failedId);
    assert.equal((await readAccount()).creditsRemaining, 10);

    const secondReservation = await reserve();
    const untracked = await Promise.all(
      Array.from({ length: 6 }, () => refundUntrackedVideoCredits(secondReservation)),
    );
    assert.ok(untracked.some(Boolean));
    await refundUntrackedVideoCredits(secondReservation);
    assert.equal((await readAccount()).creditsRemaining, 10);

    const thirdReservation = await reserve();
    const processingId = await addPrediction(thirdReservation, "starting");
    assert.equal(await refundUntrackedVideoCredits(thirdReservation), null);
    assert.equal((await readAccount()).creditsRemaining, 5);
    await db.update(predictions).set({ status: "canceled" }).where(eq(predictions.id, processingId));
    assert.ok(await refundFailedPredictionCredits(processingId));
    assert.equal((await readAccount()).creditsRemaining, 10);

    const fourthReservation = await reserve();
    await linkVideoCreditReservation(fourthReservation, `refund-test-orphan-${testId}`);
    assert.ok(await refundUntrackedVideoCredits(fourthReservation));
    assert.equal((await readAccount()).creditsRemaining, 10);
    assert.equal((await readAccount()).generationsUsed, 0);
  } finally {
    try {
      await db.delete(predictions).where(eq(predictions.userId, userId));
      await db.delete(videoCreditReservations).where(eq(videoCreditReservations.billingAccountId, accountId));
      await db.delete(creditPurchases).where(eq(creditPurchases.billingAccountId, accountId));
      await db.delete(billingAccounts).where(eq(billingAccounts.id, accountId));
    } finally {
      await pool.end();
    }
  }
});