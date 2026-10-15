import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/*
  This extension's own record of who can be paid, and of every charge it made for them. None of it
  is money: the money is in each recipient's own account at the processor, which is the whole point
  — the site never holds it. Rebuilding any of this means asking the processor.

  Amounts are integers in the currency's smallest unit (cents), never floats.
*/

/*
  One row per user who has started connecting a payout account.

  `providerAccountId` is the processor's id for it (Stripe's `acct_…`). The status columns are a copy
  of what the processor last said, refreshed by its webhooks and by "Check with Stripe": the
  processor is the authority, and a recipient can only be paid when it says both charges and payouts
  are enabled (`canReceive`).

  `dashboard`, `feesCollector` and `lossesCollector` record how the account was set up — who pays
  the processor's fees on a charge, and who is liable when its balance goes negative. The processor
  does not let either change after an account is created, so an account keeps what it was created
  with even if the site later sets new ones up differently. See PLAN.md's findings.

  `status` is this extension's summary: `pending` (setup not finished), `restricted` (the processor
  needs more information, or has turned something off), `enabled`, or `disconnected` (the account was
  disconnected from the site, or rejected).
*/
export const kempoPayoutAccount = pgTable('kempoPayoutAccount', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('providerAccountId').notNull(),
  status: text('status').notNull(),
  chargesEnabled: boolean('chargesEnabled').notNull().default(false),
  payoutsEnabled: boolean('payoutsEnabled').notNull().default(false),
  detailsSubmitted: boolean('detailsSubmitted').notNull().default(false),
  country: text('country').notNull(),
  defaultCurrency: text('defaultCurrency'),
  dashboard: text('dashboard'),
  feesCollector: text('feesCollector'),
  lossesCollector: text('lossesCollector'),
  requirementsDue: jsonb('requirementsDue'),
  requirementsDeadline: timestamp('requirementsDeadline'),
  disabledReason: text('disabledReason'),
  payoutFailure: text('payoutFailure'),
  payoutFailedAt: timestamp('payoutFailedAt'),
  livemode: boolean('livemode').notNull().default(false),
  disconnectedAt: timestamp('disconnectedAt'),
  syncedAt: timestamp('syncedAt'),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  userIndex: uniqueIndex('kempoPayoutAccount_user_idx').on(table.userId),
  providerAccountIndex: uniqueIndex('kempoPayoutAccount_providerAccount_idx').on(table.provider, table.providerAccountId),
}));

/*
  One row per charge this extension made on a recipient's account — a tip, a donation.

  The payment itself is kempo-payments' (`paymentId`): its status, refunds and webhook history live
  there, and this row never keeps a second copy of payment state beyond what the fee needs. What it
  adds is *who was paid and for what* — the recipient, and the caller's `{ owner, ref }` reference
  (Crowd Pulse's event) — and *what the site took*.

  `feeAmount` is the fee the charge was created with; `feeRefunded` is how much of it has been given
  back since (a refund that returned the fee, or a correction that kept the site under its cap).
  `feeSource` says where the fee came from: `policy` (the percentage and cap) or `caller` (an explicit
  `feeAmount`). `feeCap` is the cap that applied when the charge was made, kept so a later change to the
  setting cannot change what an earlier charge was allowed to take. `feeCapPending` is part of the fee
  still to be given back to keep under that cap, when the processor could not be reached to do it.

  `paymentId` is null for the moment between reserving the idempotency key and the payment existing;
  such a row has status `creating` and is removed if the payment cannot be made.
*/
export const kempoPayoutCharge = pgTable('kempoPayoutCharge', {
  id: text('id').primaryKey(),
  paymentId: text('paymentId'),
  idempotencyKey: text('idempotencyKey').notNull(),
  recipientUserId: text('recipientUserId').notNull(),
  accountId: text('accountId').notNull(),
  referenceOwner: text('referenceOwner').notNull(),
  referenceId: text('referenceId').notNull(),
  payerUserId: text('payerUserId'),
  amount: integer('amount').notNull(),
  amountRefunded: integer('amountRefunded').notNull().default(0),
  currency: text('currency').notNull(),
  feeAmount: integer('feeAmount').notNull().default(0),
  feeRefunded: integer('feeRefunded').notNull().default(0),
  feeSource: text('feeSource').notNull(),
  feeCap: integer('feeCap'),
  feeCapPending: integer('feeCapPending').notNull().default(0),
  status: text('status').notNull(),
  disputed: boolean('disputed').notNull().default(false),
  description: text('description'),
  succeededAt: timestamp('succeededAt'),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}, table => ({
  paymentIndex: uniqueIndex('kempoPayoutCharge_payment_idx').on(table.paymentId),
  idempotencyIndex: uniqueIndex('kempoPayoutCharge_idempotency_idx').on(table.idempotencyKey),
  referenceIndex: index('kempoPayoutCharge_reference_idx').on(table.recipientUserId, table.referenceOwner, table.referenceId),
  recipientIndex: index('kempoPayoutCharge_recipient_idx').on(table.recipientUserId, table.createdAt),
}));

/*
  The countries the processor can open an account in, as it last said — Stripe's country specs, the
  list is never typed in here. Kept so the Get paid page does not ask Stripe on every visit, and so
  the list is there when Stripe cannot be reached.

  `supportedPaymentCurrencies` is what decides whether the site can charge in its own currency on an
  account there. `refusedAt` / `refusedReason` record Stripe declining to create an account in that
  country after all — Stripe's own refusal is the final word, and a refused country is not offered
  again until an administrator says to try it again. `isPlatform` marks the country of the site's own
  Stripe account, which decides one rule (see server/utils/countries.js).
*/
export const kempoPayoutCountry = pgTable('kempoPayoutCountry', {
  country: text('country').primaryKey(),
  defaultCurrency: text('defaultCurrency'),
  supportedPaymentCurrencies: jsonb('supportedPaymentCurrencies'),
  isPlatform: boolean('isPlatform').notNull().default(false),
  refusedAt: timestamp('refusedAt'),
  refusedReason: text('refusedReason'),
  fetchedAt: timestamp('fetchedAt').notNull(),
});
