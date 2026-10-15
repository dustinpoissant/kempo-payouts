import { eq } from 'drizzle-orm';
import { kempoPayoutCharge } from '../server/db/schema.js';
import { reserveAccount } from '../server/utils/accounts/store.js';
import { onPaymentSucceeded } from '../server/utils/charges/apply.js';
import { reserveCharge } from '../server/utils/charges/store.js';
import { db, seedDatabase } from './helpers/db.js';
import { freshUser, key, purge, seedAccount, seedCharge } from './helpers/fixtures.js';

/*
  The guarantees that only mean something when requests really do arrive at once. On the unit tier's
  PGlite they run one after another by construction; on the integration tier's Postgres they are
  truly parallel, which is where these earn their keep.

  - A double-tapped "Tip" button: one payment per idempotency key, however many arrive together.
  - A double-clicked "Set up payouts": one Stripe account per user.
  - Tips paid at the same moment near the fee cap: the site keeps exactly the cap — never more, and
    never less because two corrections both counted the same room.
*/

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = purge;

export default {
  'ten requests with one idempotency key make one charge': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const shared = key();

    const results = await Promise.all(Array.from({ length: 10 }, () => reserveCharge({
      idempotencyKey: shared, recipientUserId: person.id, accountId: account.providerAccountId,
      referenceOwner: 'crowd-pulse', referenceId: 'gig', amount: 500, currency: 'usd', feeAmount: 25, feeSource: 'policy',
    })));
    const made = results.filter(([error]) => !error).length;
    const duplicates = results.filter(([error]) => error?.duplicate).length;
    if(made !== 1 || duplicates !== 9) return fail(`${made} made, ${duplicates} told it was a duplicate`);
    pass('');
  },

  'five onboarding clicks at once claim one account': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const results = await Promise.all(Array.from({ length: 5 }, () => reserveAccount({ userId: person.id, provider: 'stripe', country: 'US' })));
    const made = results.filter(([error]) => !error).length;
    if(made !== 1) return fail(`${made} claims succeeded`);
    if(results.some(([error]) => error && error.code !== 409)) return fail(`a losing claim was not a 409: ${JSON.stringify(results.map(([error]) => error))}`);
    pass('');
  },

  'tips paid at the same moment near the cap leave the site exactly the cap': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const reference = { owner: 'crowd-pulse', ref: 'busy-night' };

    // Each tip was created when nothing had been paid yet, so each carries the full 5% — 8 × 500 against a 2,000 cap.
    const tips = [];
    for(let index = 0; index < 8; index++) tips.push(await seedCharge({ account, amount: 10000, fee: 500, feeCap: 2000, owner: reference.owner, ref: reference.ref }));
    await Promise.all(tips.map(({ payment }) => onPaymentSucceeded({ ...payment, status: 'succeeded' })));

    const rows = await db.select().from(kempoPayoutCharge).where(eq(kempoPayoutCharge.referenceId, reference.ref));
    const kept = rows.reduce((sum, row) => sum + row.feeAmount - row.feeRefunded - row.feeCapPending, 0);
    const owed = rows.reduce((sum, row) => sum + row.feeCapPending, 0);
    if(rows.some(row => row.status !== 'succeeded')) return fail('a tip was not marked paid');
    if(kept !== 2000 || owed !== 2000) return fail(`the site keeps ${kept} and owes back ${owed}; expected 2000 and 2000`);
    pass('2000 kept, 2000 owed back, across 8 tips paid at once');
  },
};
