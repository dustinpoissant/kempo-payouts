import { capExcess, percentOf, policyFee, proportionalFeeRefund } from '../server/utils/charges/fees.js';
import { feeFor } from '../server/utils/charges/create.js';
import { onPaymentRefunded, onPaymentSucceeded } from '../server/utils/charges/apply.js';
import { updateCharge } from '../server/utils/charges/store.js';
import { parseCountries, parseFeeCap, parseFeePercent } from '../server/utils/config.js';
import { seedDatabase } from './helpers/db.js';
import { freshUser, purge, resetSettings, seedAccount, seedCharge, setSettings } from './helpers/fixtures.js';

/*
  The site's fee: how much of a payment to a user the site keeps.

  The arithmetic is tested exactly, as pure functions. Then the cap — Crowd Pulse's "5% of tips, up to
  $1,000 of tips per event, so at most $50" — across several tips to one recipient for one event,
  against a real database, with the charges moving to "paid" through the same function the webhook
  reaches. Nothing here calls Stripe.
*/

const reference = { owner: 'crowd-pulse', ref: 'wedding-26' };

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await resetSettings();
  await purge();
};

/* A charge with the fee the policy gives it now, then paid — the way a run of tips goes. */
const tip = async (account, amount, fee) => {
  const { charge, payment } = await seedCharge({ account, amount, fee, feeSource: 'policy', feeCap: 5000, owner: reference.owner, ref: reference.ref });
  await onPaymentSucceeded({ ...payment, status: 'succeeded' });
  return charge;
};

export default {
  'the fee is the percentage, rounded down, never more': async ({ pass, fail }) => {
    const cases = [
      [100, 5, 'usd', 5],
      [150, 5, 'usd', 7],
      [199, 5, 'usd', 9],
      [1000, 2.5, 'usd', 25],
      [333, 2.5, 'usd', 8],
      [1000, 0, 'usd', 0],
      [1200, 5, 'jpy', 60],
      [1250, 5, 'kwd', 60],
      [99999999, 99.99, 'usd', 99989999],
    ];
    for(const [amount, percent, currency, expected] of cases){
      const fee = percentOf(amount, percent, currency);
      if(fee !== expected) return fail(`${percent}% of ${amount} ${currency} gave ${fee}, expected ${expected}`);
      if(fee >= amount && amount) return fail(`the fee on ${amount} is not less than it`);
    }
    pass(`${cases.length} amounts`);
  },

  'the cap holds the fee to what is left of it': async ({ pass, fail }) => {
    const uncapped = policyFee({ amount: 10000, currency: 'usd', percent: 5, cap: 0, used: 999999 });
    if(uncapped.fee !== 500 || uncapped.capped) return fail(`no cap gave ${JSON.stringify(uncapped)}`);
    const room = policyFee({ amount: 10000, currency: 'usd', percent: 5, cap: 5000, used: 4800 });
    if(room.fee !== 200 || !room.capped) return fail(`200 left gave ${JSON.stringify(room)}`);
    const full = policyFee({ amount: 10000, currency: 'usd', percent: 5, cap: 5000, used: 5000 });
    if(full.fee !== 0) return fail(`a reached cap still took ${full.fee}`);
    const over = policyFee({ amount: 10000, currency: 'usd', percent: 5, cap: 5000, used: 6000 });
    if(over.fee !== 0 || over.remaining !== 0) return fail(`a passed cap gave ${JSON.stringify(over)}`);
    const dinars = policyFee({ amount: 100000, currency: 'kwd', percent: 5, cap: 5000, used: 4995 });
    if(dinars.fee % 10) return fail(`a three-decimal fee of ${dinars.fee} is not whole hundredths`);
    pass('');
  },

  'what is over the cap after a charge succeeds is exactly the excess': async ({ pass, fail }) => {
    const cases = [
      [{ fee: 50, cap: 5000, usedBefore: 4990 }, 40],
      [{ fee: 50, cap: 5000, usedBefore: 4950 }, 0],
      [{ fee: 50, cap: 5000, usedBefore: 6000 }, 50],
      [{ fee: 50, cap: 0, usedBefore: 999999 }, 0],
      [{ fee: 0, cap: 5000, usedBefore: 5000 }, 0],
    ];
    for(const [input, expected] of cases){
      if(capExcess(input) !== expected) return fail(`${JSON.stringify(input)} gave ${capExcess(input)}, expected ${expected}`);
    }
    if(proportionalFeeRefund({ fee: 50, amount: 1000, refunded: 400 }) !== 20) return fail('a 40% refund does not return 40% of the fee');
    if(proportionalFeeRefund({ fee: 50, amount: 1000, refunded: 1000 }) !== 50) return fail('a full refund does not return the whole fee');
    pass('');
  },

  'the settings refuse anything that is not a fee, a cap or a country list': async ({ pass, fail }) => {
    for(const bad of [-1, 100, 150, '5%', 'five', 2.555, NaN, null, {}]){
      if(parseFeePercent(bad) !== null) return fail(`fee ${JSON.stringify(bad)} was accepted`);
    }
    for(const good of [0, 5, '5', 2.5, '2.75', 99.99]){
      if(parseFeePercent(good) === null) return fail(`fee ${JSON.stringify(good)} was refused`);
    }
    for(const bad of [-1, 1.5, '12.50', 'lots', 100000000]){
      if(parseFeeCap(bad) !== null) return fail(`cap ${JSON.stringify(bad)} was accepted`);
    }
    if(parseFeeCap('5000') !== 5000 || parseFeeCap(0) !== 0) return fail('a valid cap was refused');
    if(parseCountries('us, gb ,CA').join() !== 'US,GB,CA') return fail('a country list was not read');
    if(parseCountries('') .length !== 0) return fail('an empty list is not "no narrowing"');
    if(parseCountries('USA,GB') !== null) return fail('a three-letter code was accepted');
    pass('');
  },

  /*
    The case the cap exists for: Crowd Pulse's 5% up to $1,000 of tips per event. The fee each tip is
    created with comes from feeFor, against the tips already paid, and each is paid before the next.
  */
  'the cap holds across many tips to one recipient for one event': async ({ pass, fail }) => {
    await purge();
    await setSettings({ fee_percent: 5, fee_cap: 5000 });
    const recipient = await freshUser('DJ');
    const account = await seedAccount({ userId: recipient.id });

    const fees = [];
    for(const amount of [40000, 40000, 15000, 10000, 2000]){
      const [error, quote] = await feeFor({ amount, recipientUserId: recipient.id, reference });
      if(error) return fail(error.msg);
      fees.push(quote.fee);
      await tip(account, amount, quote.fee);
    }
    if(fees.join() !== '2000,2000,750,250,0') return fail(`the fees were ${fees.join()}`);

    const [, after] = await feeFor({ amount: 2000, recipientUserId: recipient.id, reference });
    if(after.used !== 5000 || after.fee !== 0) return fail(`after the cap: ${JSON.stringify(after)}`);

    // Another event, and another recipient, start from nothing.
    const [, nextEvent] = await feeFor({ amount: 2000, recipientUserId: recipient.id, reference: { ...reference, ref: 'birthday-27' } });
    if(nextEvent.fee !== 100) return fail(`another event took ${nextEvent.fee}`);
    const someoneElse = await freshUser('Other DJ');
    const [, other] = await feeFor({ amount: 2000, recipientUserId: someoneElse.id, reference });
    if(other.fee !== 100) return fail(`another recipient took ${other.fee}`);
    pass('2000 + 2000 + 750 + 250 + 0 = the $50 cap');
  },

  'a tip that is not paid, or is refunded with its fee, does not use the cap up': async ({ pass, fail }) => {
    await purge();
    await setSettings({ fee_percent: 5, fee_cap: 5000 });
    const recipient = await freshUser('DJ');
    const account = await seedAccount({ userId: recipient.id });

    await seedCharge({ account, amount: 40000, fee: 2000, feeCap: 5000, owner: reference.owner, ref: reference.ref });
    const [, unpaid] = await feeFor({ amount: 1000, recipientUserId: recipient.id, reference });
    if(unpaid.used !== 0) return fail(`an unpaid tip counted ${unpaid.used}`);

    const paid = await tip(account, 40000, 2000);
    const [, used] = await feeFor({ amount: 1000, recipientUserId: recipient.id, reference });
    if(used.used !== 2000) return fail(`a paid tip counted ${used.used}`);

    await updateCharge(paid.id, { feeRefunded: 2000, amountRefunded: 40000 });
    const [, refunded] = await feeFor({ amount: 1000, recipientUserId: recipient.id, reference });
    if(refunded.used !== 0) return fail(`a tip refunded with its fee still counted ${refunded.used}`);
    pass('');
  },

  /*
    Two tips started at the same moment near the cap both see the same room. When the second is paid
    the total is over, and the excess has to come back: that is recorded as owed back immediately
    (Stripe cannot be reached here, so it stays pending) and the cap counts it as already returned.
  */
  'a tip that takes the total past the cap owes the excess back': async ({ pass, fail }) => {
    await purge();
    await setSettings({ fee_percent: 5, fee_cap: 5000 });
    const recipient = await freshUser('DJ');
    const account = await seedAccount({ userId: recipient.id });

    await tip(account, 90000, 4500);
    const raced = [];
    for(let index = 0; index < 2; index++){
      raced.push(await seedCharge({ account, amount: 10000, fee: 500, feeCap: 5000, owner: reference.owner, ref: reference.ref }));
    }
    const [, first] = await onPaymentSucceeded({ ...raced[0].payment, status: 'succeeded' });
    const [, second] = await onPaymentSucceeded({ ...raced[1].payment, status: 'succeeded' });

    if(first.feeCapPending !== 0) return fail(`the tip that fitted owes ${first.feeCapPending}`);
    if(second.feeCapPending !== 500) return fail(`the tip over the cap owes ${second.feeCapPending}, not 500`);

    const [, quote] = await feeFor({ amount: 1000, recipientUserId: recipient.id, reference });
    if(quote.used !== 5000) return fail(`the cap counts ${quote.used} kept, not 5000`);

    // Running the hook again (a redelivered webhook) does not owe it twice.
    const [, again] = await onPaymentSucceeded({ ...raced[1].payment, status: 'succeeded' });
    if(again.feeCapPending !== 500) return fail(`a second run owes ${again.feeCapPending}`);
    pass('4500 + 500 kept; the next 500 owed back');
  },

  'a fee set by the caller is not corrected against the cap': async ({ pass, fail }) => {
    await purge();
    await setSettings({ fee_percent: 5, fee_cap: 5000 });
    const recipient = await freshUser('DJ');
    const account = await seedAccount({ userId: recipient.id });
    await tip(account, 100000, 5000);

    const { payment } = await seedCharge({ account, amount: 10000, fee: 800, feeSource: 'caller', feeCap: null, owner: reference.owner, ref: reference.ref });
    const [, paid] = await onPaymentSucceeded({ ...payment, status: 'succeeded' });
    if(paid.feeCapPending !== 0) return fail(`a caller's fee was corrected by ${paid.feeCapPending}`);
    pass('');
  },

  'a refund with the fee, when Stripe cannot be asked, is estimated the way Stripe works it out': async ({ pass, fail }) => {
    await purge();
    const recipient = await freshUser('DJ');
    const account = await seedAccount({ userId: recipient.id });
    const { payment } = await seedCharge({ account, amount: 1000, fee: 50, status: 'succeeded' });

    const [, withFee] = await onPaymentRefunded({ ...payment, amountRefunded: 400 }, null, { feeHint: { refundApplicationFee: true } });
    if(withFee.amountRefunded !== 400 || withFee.feeRefunded !== 20) return fail(`after a 400 refund: ${withFee.amountRefunded} refunded, ${withFee.feeRefunded} fee back`);
    const [, keptFee] = await onPaymentRefunded({ ...payment, amountRefunded: 600 }, null, { feeHint: { refundApplicationFee: false } });
    if(keptFee.feeRefunded !== 20) return fail(`a refund that kept the fee gave back ${keptFee.feeRefunded}`);
    pass('');
  },
};
