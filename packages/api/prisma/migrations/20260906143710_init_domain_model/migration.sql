-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('EARN', 'REDEEM', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('RESERVED', 'FULFILLED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'UNMATCHED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "UnmatchedReason" AS ENUM ('UNKNOWN_USER', 'NO_RULE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "source" TEXT NOT NULL,
    "external_event_id" TEXT,
    "redemption_id" TEXT,
    "rule_id" TEXT,
    "reverses_id" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_balances" (
    "user_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_balances_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "earning_rules" (
    "id" TEXT NOT NULL,
    "activity_type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earning_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "cost_points" INTEGER NOT NULL,
    "stock" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reward_id" TEXT NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "cost_points_snapshot" INTEGER NOT NULL,
    "reward_name_snapshot" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "fulfillment_ref" TEXT,
    "failure_reason" TEXT,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilled_at" TIMESTAMPTZ(3),

    CONSTRAINT "redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "partner" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "unmatched_reason" "UnmatchedReason",
    "raw_payload" TEXT NOT NULL,
    "user_ref" TEXT,
    "activity_type" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_external_ref_key" ON "users"("external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "point_transactions_reverses_id_key" ON "point_transactions"("reverses_id");

-- CreateIndex
CREATE INDEX "point_transactions_user_id_created_at_id_idx" ON "point_transactions"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "point_transactions_source_external_event_id_key" ON "point_transactions"("source", "external_event_id");

-- CreateIndex
CREATE INDEX "earning_rules_activity_type_active_effective_from_idx" ON "earning_rules"("activity_type", "active", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "rewards_sku_key" ON "rewards"("sku");

-- CreateIndex
CREATE INDEX "redemptions_user_id_created_at_idx" ON "redemptions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "redemptions_user_id_idempotency_key_key" ON "redemptions"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_unmatched_reason_received_at_idx" ON "webhook_deliveries"("status", "unmatched_reason", "received_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries"("received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_partner_external_event_id_key" ON "webhook_deliveries"("partner", "external_event_id");

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "earning_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "point_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_balances" ADD CONSTRAINT "user_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "rewards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Invariants Prisma's schema language cannot express.
--
-- These live here, in the same migration as the tables they guard, rather than
-- in a side-car .sql file. A separate script is a step someone forgets, and
-- forgetting it does not fail loudly — it removes a backstop and leaves a
-- database that looks correct until the day something depends on it.
--
-- Every one of these sits *underneath* an application-level check that already
-- prevents the same thing. That is the point: the application check produces a
-- good error message, and these make the bad state impossible when a bug,
-- a replay or a manual query bypasses it.
-- ===========================================================================

-- A balance is a cache of SUM(delta) over the ledger, and a negative balance is
-- not a small error — it is points that were spent without being earned. The
-- redemption service already refuses to debit more than a user has; this makes
-- the outcome unrepresentable if that check is ever bypassed.
ALTER TABLE "user_balances"
    ADD CONSTRAINT "user_balances_balance_non_negative"
    CHECK ("balance" >= 0);

-- A zero-delta ledger row is always a bug. It records that something happened
-- while asserting nothing happened, which is worse than either — it pollutes
-- history with rows that cannot be reconciled against any real event.
ALTER TABLE "point_transactions"
    ADD CONSTRAINT "point_transactions_delta_non_zero"
    CHECK ("delta" <> 0);

-- The sign carries the meaning, so the sign and the type must agree. An EARN
-- with a negative delta would silently drain a balance while reading, in every
-- log and every UI, as though the user had earned something. REVERSAL and
-- ADJUSTMENT are signed either way on purpose: a reversal mirrors whatever it
-- undoes, and an operator correction can go in both directions.
ALTER TABLE "point_transactions"
    ADD CONSTRAINT "point_transactions_delta_sign_matches_type"
    CHECK (
        ("type" = 'EARN' AND "delta" > 0)
        OR ("type" = 'REDEEM' AND "delta" < 0)
        OR ("type" IN ('REVERSAL', 'ADJUSTMENT'))
    );

-- Pricing resolves an event's occurredAt against exactly one rule. Two active
-- rules whose windows overlap for the same activity type would make that
-- resolution ambiguous, and an ambiguous price is a balance that depends on
-- which row the planner happened to return first.
--
-- An EXCLUDE constraint is what makes "non-overlapping by construction" a
-- property of the database rather than a convention the seed script happens to
-- follow. A future rule inserted by hand, by an admin endpoint, or by a
-- migration is held to it too.
--
-- btree_gist is required for the equality half of the constraint: GiST does not
-- handle plain `=` on text without it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Guards the range expression below. A window ending before it starts produces
-- an opaque "range lower bound must be less than or equal to range upper bound"
-- from tstzrange; this rejects it with a constraint name that says what is wrong.
ALTER TABLE "earning_rules"
    ADD CONSTRAINT "earning_rules_window_ordered"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- Half-open, '[)': one version may end at the exact instant the next begins
-- with neither a gap nor an overlap. A null effective_to means "still current"
-- and is modelled as infinity. Partial, on `active`, so superseded rules can be
-- deactivated and kept for the ledger rows that reference them.
ALTER TABLE "earning_rules"
    ADD CONSTRAINT "earning_rules_no_overlapping_windows"
    EXCLUDE USING gist (
        "activity_type" WITH =,
        tstzrange("effective_from", COALESCE("effective_to", 'infinity'::timestamptz), '[)') WITH &&
    ) WHERE ("active");

-- The reward-side analogue of a non-negative balance. Stock is decremented with
-- a conditional UPDATE ... WHERE stock > 0 so overselling cannot happen through
-- the service; this makes it impossible through any other route as well.
-- NULL is untouched by the check, and means unlimited.
ALTER TABLE "rewards"
    ADD CONSTRAINT "rewards_stock_non_negative"
    CHECK ("stock" IS NULL OR "stock" >= 0);

-- A reward costing zero or fewer points is free money, and a redemption of one
-- would write a REDEEM entry violating the sign constraint above — failing far
-- from the actual mistake, which was made when the reward was created.
ALTER TABLE "rewards"
    ADD CONSTRAINT "rewards_cost_points_positive"
    CHECK ("cost_points" > 0);
