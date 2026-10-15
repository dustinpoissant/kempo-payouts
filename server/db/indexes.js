import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';

/*
  The indexes server/db/schema.js declares, created by hand — kempo's installer makes columns and
  primary keys from a Drizzle schema and nothing else. install.js and update.js both run this, and a
  static test checks the list against the schema.

  The unique ones are correctness guarantees, so failing to make one fails the install:

  - one payout account per user, and one row per processor account — otherwise two users could
    claim the same account, and a webhook would update whichever row came back first;
  - one charge per payment — the hooks find the charge by its payment;
  - one charge per idempotency key — what makes a retried request create one payment, not two.
*/
export const INDEXES = [
  { name: 'kempoPayoutAccount_user_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoPayoutAccount_user_idx" ON "kempoPayoutAccount" ("userId")` },
  { name: 'kempoPayoutAccount_providerAccount_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoPayoutAccount_providerAccount_idx" ON "kempoPayoutAccount" ("provider", "providerAccountId")` },
  { name: 'kempoPayoutCharge_payment_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoPayoutCharge_payment_idx" ON "kempoPayoutCharge" ("paymentId")` },
  { name: 'kempoPayoutCharge_idempotency_idx', required: true, sql: sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoPayoutCharge_idempotency_idx" ON "kempoPayoutCharge" ("idempotencyKey")` },
  { name: 'kempoPayoutCharge_reference_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoPayoutCharge_reference_idx" ON "kempoPayoutCharge" ("recipientUserId", "referenceOwner", "referenceId")` },
  { name: 'kempoPayoutCharge_recipient_idx', sql: sql`CREATE INDEX IF NOT EXISTS "kempoPayoutCharge_recipient_idx" ON "kempoPayoutCharge" ("recipientUserId", "createdAt")` },
];

export const createIndexes = async () => {
  for(const index of INDEXES){
    try {
      await db.execute(index.sql);
    } catch(error) {
      if(index.required) throw new Error(`[kempo-payouts] Could not create ${index.name}, which payouts cannot work safely without: ${error.message}`);
      console.warn(`[kempo-payouts] Could not create the index ${index.name}: ${error.message}`);
    }
  }
};
