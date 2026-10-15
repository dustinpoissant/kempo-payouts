import { sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPayoutAccount, kempoPayoutCharge } from './server/db/schema.js';

/*
  Nothing here is deleted, and nothing at Stripe changes. Uninstalling without purging leaves the
  tables in place, so reinstalling restores every connected account; purging drops them, and that is
  kempo's decision to make.

  What this does is say what is at stake. The recipients' Stripe accounts, their balances and their
  payouts are entirely unaffected — the money is theirs and is at Stripe, never here. What the site
  loses is its record of who is connected and what it has charged, and its ability to charge anybody
  new. Payments already made can still be refunded from the Stripe dashboard.
*/
export default async () => {
  try {
    const [accounts] = await db.select({ count: sql`count(*)::int` }).from(kempoPayoutAccount);
    const fees = await db.select({
      currency: kempoPayoutCharge.currency,
      fees: sql`coalesce(sum(${kempoPayoutCharge.feeAmount} - ${kempoPayoutCharge.feeRefunded}), 0)::int`,
      count: sql`count(*)::int`,
    }).from(kempoPayoutCharge).where(sql`${kempoPayoutCharge.status} = 'succeeded'`).groupBy(kempoPayoutCharge.currency);

    const collected = fees.map(row => `${row.fees} ${row.currency.toUpperCase()} (smallest unit) from ${row.count} charge${row.count === 1 ? '' : 's'}`).join('; ');
    console.log(`[kempo-payouts] Removing. ${accounts?.count ?? 0} connected payout account${accounts?.count === 1 ? '' : 's'}${collected ? `; fees collected: ${collected}` : ''}. The recipients’ Stripe accounts and balances are untouched; this site simply stops being able to charge to them.`);
  } catch {
    // The tables may already be gone; there is nothing to report on.
  }
};
