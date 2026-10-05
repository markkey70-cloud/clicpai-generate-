import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const billingAccounts = pgTable("billing_accounts", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  planKey: text("plan_key").notNull().default("free_trial"),
  subscriptionStatus: text("subscription_status").notNull().default("free"),
  creditsRemaining: integer("credits_remaining").notNull().default(0),
  generationsUsed: integer("generations_used").notNull().default(0),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const creditPurchases = pgTable("credit_purchases", {
  id: text("id").primaryKey(),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
  billingAccountId: text("billing_account_id").notNull(),
  credits: integer("credits").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videoCreditReservations = pgTable("video_credit_reservations", {
  id: text("id").primaryKey(),
  billingAccountId: text("billing_account_id").notNull(),
  credits: integer("credits").notNull(),
  predictionId: text("prediction_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
});

export const predictions = pgTable("predictions", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  creditReservationId: text("credit_reservation_id").unique(),
  billingAccountId: text("billing_account_id"),
  creditsCharged: integer("credits_charged").notNull().default(0),
  creditsRefundedAt: timestamp("credits_refunded_at", { withTimezone: true }),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  modelId: text("model_id").notNull(),
  modelName: text("model_name").notNull(),
  aspectRatio: text("aspect_ratio").notNull(),
  duration: integer("duration").notNull(),
  outputUrl: text("output_url"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  progress: integer("progress").notNull().default(0),
  thumbnail: text("thumbnail"),
  lipSyncEnabled: boolean("lip_sync_enabled").notNull().default(false),
  lipSyncPredictionId: text("lip_sync_prediction_id"),
  voiceMode: text("voice_mode").notNull().default("none"),
  voiceStyle: text("voice_style").notNull().default("male"),
  voiceText: text("voice_text"),
  voiceUploadId: text("voice_upload_id"),
  voiceStatus: text("voice_status").notNull().default("none"),
  voiceClaimedAt: timestamp("voice_claimed_at", { withTimezone: true }),
  voiceClaimId: text("voice_claim_id"),
  voiceObjectId: text("voice_object_id"),
  voiceError: text("voice_error"),
});

export type BillingAccount = typeof billingAccounts.$inferSelect;
export type PredictionRecord = typeof predictions.$inferSelect;