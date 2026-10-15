import { eq, sql } from 'drizzle-orm';
import { receiveVerifiedEvent } from 'kempo-payments/sdk';
import { kempoPayment } from '../node_modules/kempo-payments/server/db/schema.js';
import { insertPayment, newId } from '../node_modules/kempo-payments/server/utils/payments/store.js';
import { kempoPayoutCharge } from '../server/db/schema.js';
import { createConnectedPayment } from '../server/utils/charges/create.js';
import { onPaymentSucceeded } from '../server/utils/charges/apply.js';
import { refundCharge } from '../server/utils/charges/refund.js';
import { chargeById, listCharges, reserveCharge, summary } from '../server/utils/charges/store.js';
import { db, seedDatabase } from './helpers/db.js';
import { freshUser, heard, key, listen, purge, registerOwnHooks, resetSettings, seedAccount, seedCharge, seedCountries, setSettings } from './helpers/fixtures.js';

/*
  Charging a recipient, and a charge following its payment.

  Creating a payment needs Stripe, which is not connected here: a request that passes every check
  stops with "Stripe is not connected", which is how these tests tell a refused request from one
  that reached Stripe. What happens *after* Stripe — the payment succeeding, being refunded or
  disputed — is driven through kempo-payments' own `receiveVerifiedEvent`, the entry point the
  Connect webhook uses, so the hooks fire from the real code and reach this extension's real handlers.
*/

const reference = { owner: 'crowd-pulse', ref: 'gig-1' };
const notConnected = error => /not connected/i.test(error?.msg || '');
const count = async table => (await db.select({ total: sql`count(*)::int` }).from(table))[0].total;

const event = (type, account, object) => ({ id: `evt_${newId()}`, type, account, data: { object } });

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await resetSettings();
  await purge();
};

export default {
  'a malformed request is refused before any payment is started': async ({ pass, fail }) => {
    await purge();
    await seedCountries();
    const person = await freshUser('DJ');
    await seedAccount({ userId: person.id });
    const valid = { recipientUserId: person.id, amount: 500, reference, idempotencyKey: key() };

    const cases = [
      [{ ...valid, idempotencyKey: undefined }, 'no idempotency key'],
      [{ ...valid, reference: undefined }, 'no reference'],
      [{ ...valid, reference: { owner: 'crowd-pulse' } }, 'a reference with no ref'],
      [{ ...valid, amount: 5.5 }, 'an amount in dollars'],
      [{ ...valid, amount: 0 }, 'a zero amount'],
      [{ ...valid, currency: 'eur' }, 'a currency that is not the site’s'],
      [{ ...valid, feeAmount: 500 }, 'a fee as large as the payment'],
      [{ ...valid, feeAmount: -1 }, 'a negative fee'],
      [{ ...valid, recipientUserId: '' }, 'no recipient'],
      [{ ...valid, description: 'a\u0000b' }, 'a NUL byte'],
    ];
    for(const [input, what] of cases){
      const [error] = await createConnectedPayment(input);
      if(error?.code !== 400) return fail(`${what} gave ${JSON.stringify(error)}`);
    }
    if(await count(kempoPayoutCharge) || await count(kempoPayment)) return fail('a refused request left a row');
    pass(`${cases.length} refused`);
  },

  'a recipient who cannot be paid, or is in a country the site stopped offering, is refused': async ({ pass, fail }) => {
    await purge();
    await seedCountries();
    const nobody = await freshUser('Nobody');
    const [none] = await createConnectedPayment({ recipientUserId: nobody.id, amount: 500, reference, idempotencyKey: key() });
    if(none?.code !== 409) return fail(`a recipient with no account gave ${JSON.stringify(none)}`);

    const restricted = await freshUser('Restricted');
    await seedAccount({ userId: restricted.id, status: 'restricted' });
    const [notReady] = await createConnectedPayment({ recipientUserId: restricted.id, amount: 500, reference, idempotencyKey: key() });
    if(notReady?.code !== 409) return fail(`a restricted recipient gave ${JSON.stringify(notReady)}`);

    const british = await freshUser('British');
    await seedAccount({ userId: british.id, country: 'GB' });
    await setSettings({ allowed_countries: 'US' });
    const [narrowed] = await createConnectedPayment({ recipientUserId: british.id, amount: 500, reference, idempotencyKey: key() });
    await resetSettings();
    if(narrowed?.code !== 409 || !/United Kingdom/.test(narrowed.msg)) return fail(`a recipient in a country no longer offered gave ${JSON.stringify(narrowed)}`);
    pass('');
  },

  'a valid request reaches Stripe, and a failure leaves the key free to retry': async ({ pass, fail }) => {
    await purge();
    await seedCountries();
    const person = await freshUser('DJ');
    await seedAccount({ userId: person.id });
    const idempotencyKey = key();

    const [first] = await createConnectedPayment({ recipientUserId: person.id, amount: 500, reference, idempotencyKey });
    if(!notConnected(first)) return fail(`it did not reach Stripe: ${JSON.stringify(first)}`);
    if(await count(kempoPayoutCharge)) return fail('the reservation was not released after Stripe failed');

    const [again] = await createConnectedPayment({ recipientUserId: person.id, amount: 500, reference, idempotencyKey, feeAmount: 0 });
    if(!notConnected(again)) return fail(`the retry was refused: ${JSON.stringify(again)}`);
    pass('');
  },

  'the same key again is the same charge, never a second payment': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const { charge } = await seedCharge({ account });
    const before = [await count(kempoPayoutCharge), await count(kempoPayment)];

    const [resumed] = await createConnectedPayment({ recipientUserId: person.id, amount: 1000, reference, idempotencyKey: charge.idempotencyKey });
    if(!notConnected(resumed)) return fail(`a retry did not go back for the existing payment's secret: ${JSON.stringify(resumed)}`);
    if(await count(kempoPayoutCharge) !== before[0] || await count(kempoPayment) !== before[1]) return fail('a retry made another row');

    const inFlight = key();
    await reserveCharge({ idempotencyKey: inFlight, recipientUserId: person.id, accountId: account.providerAccountId, referenceOwner: 'crowd-pulse', referenceId: 'gig-1', amount: 500, currency: 'usd', feeAmount: 25, feeSource: 'policy' });
    const [racing] = await createConnectedPayment({ recipientUserId: person.id, amount: 500, reference, idempotencyKey: inFlight });
    if(racing?.code !== 409) return fail(`a key still being created gave ${JSON.stringify(racing)}`);
    pass('');
  },

  'a payment succeeding at Stripe marks the charge paid and announces it': async ({ pass, fail }) => {
    await purge();
    await registerOwnHooks();
    await listen('payouts:charge-succeeded');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const { charge, payment } = await seedCharge({ account, amount: 1500, fee: 75 });

    const [error, result] = await receiveVerifiedEvent({ event: event('payment_intent.succeeded', account.providerAccountId, {
      id: payment.providerRef, status: 'succeeded', amount: 1500, amount_received: 1500, currency: 'usd', capture_method: 'automatic', livemode: false,
    }) });
    if(error || !result.handled) return fail(`kempo-payments did not apply it: ${JSON.stringify(error || result)}`);

    const [, paid] = await chargeById(charge.id);
    if(paid.status !== 'succeeded' || !paid.succeededAt) return fail(`the charge is ${paid.status}`);
    const announced = heard('payouts:charge-succeeded');
    if(announced.length !== 1 || announced[0].data.charge.id !== charge.id || announced[0].data.payment.connectedAccount !== account.providerAccountId) return fail(`announced: ${JSON.stringify(announced)}`);
    pass('');
  },

  'refunds, disputes and abandoned payments reach the charge the same way': async ({ pass, fail }) => {
    await purge();
    await registerOwnHooks();
    await listen('payouts:charge-refunded', 'payouts:charge-disputed');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const { charge, payment } = await seedCharge({ account, amount: 2000, fee: 100, status: 'succeeded' });

    const [refundError] = await receiveVerifiedEvent({ event: event('charge.refunded', account.providerAccountId, {
      id: 'ch_1', payment_intent: payment.providerRef, amount_refunded: 500,
      refunds: { data: [{ id: `re_${newId()}`, amount: 500, currency: 'usd', status: 'succeeded' }] },
    }) });
    if(refundError) return fail(`the refund was not applied: ${refundError.msg}`);
    const [, refunded] = await chargeById(charge.id);
    if(refunded.amountRefunded !== 500) return fail(`the charge shows ${refunded.amountRefunded} refunded`);
    if(heard('payouts:charge-refunded').length !== 1) return fail('the refund was not announced');

    await receiveVerifiedEvent({ event: event('charge.dispute.created', account.providerAccountId, { payment_intent: payment.providerRef, reason: 'fraudulent' }) });
    const [, disputed] = await chargeById(charge.id);
    if(!disputed.disputed) return fail('the charge is not marked disputed');
    if(heard('payouts:charge-disputed')[0]?.data.reason !== 'fraudulent') return fail('the dispute was not announced with its reason');

    const abandoned = await seedCharge({ account, amount: 700, fee: 35 });
    await receiveVerifiedEvent({ event: event('payment_intent.canceled', account.providerAccountId, {
      id: abandoned.payment.providerRef, status: 'canceled', amount: 700, amount_received: 0, currency: 'usd', capture_method: 'automatic',
    }) });
    const [, canceled] = await chargeById(abandoned.charge.id);
    if(canceled.status !== 'canceled') return fail(`an abandoned payment left the charge ${canceled.status}`);
    pass('');
  },

  'a payment that is not this extension’s is left alone': async ({ pass, fail }) => {
    await purge();
    const [, payment] = await insertPayment({ provider: 'stripe', providerRef: `pi_${newId()}`, status: 'succeeded', amount: 100, currency: 'usd', owner: 'kempo-commerce', reference: 'order-1' });
    const [error, result] = await onPaymentSucceeded(payment);
    if(error || result !== null) return fail(`someone else's payment gave ${JSON.stringify(error || result)}`);
    pass('');
  },

  'a refund is refused unless it is whole, keyed and of a paid charge': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const unpaid = await seedCharge({ account });
    const paid = await seedCharge({ account, status: 'succeeded' });

    const [noKey] = await refundCharge({ chargeId: paid.charge.id });
    if(noKey?.code !== 400) return fail(`no key gave ${JSON.stringify(noKey)}`);
    const [badChoice] = await refundCharge({ chargeId: paid.charge.id, refundApplicationFee: 'yes', idempotencyKey: key() });
    if(badChoice?.code !== 400) return fail(`a non-boolean fee choice gave ${JSON.stringify(badChoice)}`);
    const [badAmount] = await refundCharge({ chargeId: paid.charge.id, amount: 2.5, idempotencyKey: key() });
    if(badAmount?.code !== 400) return fail(`a fractional amount gave ${JSON.stringify(badAmount)}`);
    const [notPaid] = await refundCharge({ chargeId: unpaid.charge.id, idempotencyKey: key() });
    if(notPaid?.code !== 409) return fail(`an unpaid charge gave ${JSON.stringify(notPaid)}`);
    const [missing] = await refundCharge({ chargeId: 'pch_nope', idempotencyKey: key() });
    if(missing?.code !== 404) return fail(`no such charge gave ${JSON.stringify(missing)}`);

    const [reached] = await refundCharge({ chargeId: paid.charge.id, amount: 300, refundApplicationFee: false, idempotencyKey: key() });
    if(!notConnected(reached)) return fail(`a valid refund did not reach Stripe: ${JSON.stringify(reached)}`);
    pass('');
  },

  'the fees collected are what was kept from paid charges, per currency and per recipient': async ({ pass, fail }) => {
    await purge();
    const first = await freshUser('First');
    const second = await freshUser('Second');
    const firstAccount = await seedAccount({ userId: first.id });
    const secondAccount = await seedAccount({ userId: second.id });

    await seedCharge({ account: firstAccount, amount: 1000, fee: 50, status: 'succeeded' });
    const refunded = await seedCharge({ account: firstAccount, amount: 2000, fee: 100, status: 'succeeded' });
    await db.update(kempoPayoutCharge).set({ feeRefunded: 100, amountRefunded: 2000 }).where(eq(kempoPayoutCharge.id, refunded.charge.id));
    await seedCharge({ account: secondAccount, amount: 4000, fee: 200, status: 'succeeded' });
    await seedCharge({ account: secondAccount, amount: 9000, fee: 450 });
    await reserveCharge({ idempotencyKey: key(), recipientUserId: second.id, accountId: secondAccount.providerAccountId, referenceOwner: 'x', referenceId: 'y', amount: 1, currency: 'usd', feeAmount: 0, feeSource: 'policy' });

    const [error, result] = await summary();
    if(error) return fail(error.msg);
    const usd = result.totals.find(total => total.currency === 'usd');
    if(usd.fees !== 250 || usd.count !== 3 || usd.amount !== 7000) return fail(`the totals were ${JSON.stringify(usd)}`);
    if(result.recipients[0].recipientUserId !== second.id || result.recipients[0].fees !== 200) return fail(`the top recipient was ${JSON.stringify(result.recipients[0])}`);

    const [, list] = await listCharges({});
    if(list.total !== 4) return fail(`the list shows ${list.total} charges, counting one still being created`);
    const [, mine] = await listCharges({ recipientUserId: first.id });
    if(mine.total !== 2) return fail(`one recipient's list shows ${mine.total}`);
    pass('');
  },
};
