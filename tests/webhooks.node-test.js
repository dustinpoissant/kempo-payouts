import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { deleteSetting } from 'kempo/server/sdk.js';
import { newId } from '../node_modules/kempo-payments/server/utils/payments/store.js';
import { kempoPayoutAccount } from '../server/db/schema.js';
import { canReceive } from '../server/utils/accounts/connect.js';
import { chargeById } from '../server/utils/charges/store.js';
import { receiveConnectWebhook } from '../server/utils/webhooks/receive.js';
import { db, seedDatabase } from './helpers/db.js';
import { freshUser, heard, listen, purge, registerOwnHooks, resetSettings, seedAccount, seedCharge, setSettings } from './helpers/fixtures.js';

/*
  The Connect webhook, driven with events signed the way Stripe signs them: `generateTestHeaderString`
  makes a real signature for a secret chosen here, and the same `constructEvent` production uses
  checks it. No request is made to Stripe — which is also why an account event falls back to the
  copy of the account inside the event, the path production takes when Stripe cannot be reached.
*/

const SECRET = 'whsec_kempo_payouts_suite';
const signer = new Stripe('sk_test_signature_helper_only');

const deliver = (event, { signature } = {}) => {
  const payload = JSON.stringify(event);
  return receiveConnectWebhook({ provider: 'stripe', payload, signature: signature ?? signer.webhooks.generateTestHeaderString({ payload, secret: SECRET }) });
};

const accountEvent = (account, fields = {}, created = Math.floor(Date.now() / 1000)) => ({
  id: `evt_${newId()}`,
  type: 'account.updated',
  account: account.providerAccountId,
  created,
  data: { object: {
    id: account.providerAccountId, object: 'account', country: 'US', default_currency: 'usd', details_submitted: true,
    charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [], past_due: [], disabled_reason: null, current_deadline: null },
    controller: { stripe_dashboard: { type: 'express' }, fees: { payer: 'application' }, losses: { payments: 'application' } },
    ...fields,
  } },
});

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await resetSettings();
  await purge();
};

export default {
  'an event with no secret configured, a bad signature or none is refused and changes nothing': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id, status: 'pending' });
    const event = accountEvent(account);

    const [unconfigured] = await deliver(event);
    if(unconfigured?.code !== 409) return fail(`with no secret configured: ${JSON.stringify(unconfigured)}`);

    await setSettings({ connect_webhook_secret: SECRET });
    const [forged] = await deliver(event, { signature: 't=1,v1=deadbeef' });
    if(forged?.code !== 400) return fail(`a forged signature gave ${JSON.stringify(forged)}`);
    const [unsigned] = await receiveConnectWebhook({ provider: 'stripe', payload: JSON.stringify(event), signature: null });
    if(unsigned?.code !== 400) return fail(`no signature gave ${JSON.stringify(unsigned)}`);
    const [wrongSecret] = await deliver(event, { signature: signer.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: 'whsec_somebody_else' }) });
    if(wrongSecret?.code !== 400) return fail(`a signature from another endpoint gave ${JSON.stringify(wrongSecret)}`);

    const [, can] = await canReceive({ userId: person.id });
    if(can) return fail('an unverified event made the account payable');
    pass('');
  },

  'Stripe saying an account is ready, through the webhook, flips canReceive to true': async ({ pass, fail }) => {
    await purge();
    await setSettings({ connect_webhook_secret: SECRET });
    await listen('payouts:account-updated');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id, status: 'pending' });

    const [error, result] = await deliver(accountEvent(account));
    if(error || !result.handled) return fail(`not handled: ${JSON.stringify(error || result)}`);
    const [, can] = await canReceive({ userId: person.id });
    if(!can) return fail('canReceive is still false');
    if(!heard('payouts:account-updated')[0]?.data.canReceive) return fail('the change was not announced');

    // An older event arriving late does not undo it.
    await deliver(accountEvent(account, { charges_enabled: false }, Math.floor(Date.now() / 1000) - 3600));
    const [, still] = await canReceive({ userId: person.id });
    if(!still) return fail('a stale event undid a newer one');
    pass('');
  },

  'an account event Stripe cannot be asked about, with no copy in it, is retried rather than dropped': async ({ pass, fail }) => {
    await purge();
    await setSettings({ connect_webhook_secret: SECRET });
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id, status: 'pending' });
    const [error] = await deliver({ id: `evt_${newId()}`, type: 'capability.updated', account: account.providerAccountId, data: { object: { id: 'card_payments', account: account.providerAccountId, status: 'active' } } });
    if(!error || error.code < 400) return fail('the event was acknowledged although nothing could be applied');
    pass('');
  },

  'a recipient disconnecting cannot be paid from that moment': async ({ pass, fail }) => {
    await purge();
    await setSettings({ connect_webhook_secret: SECRET });
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });

    const [error] = await deliver({ id: `evt_${newId()}`, type: 'account.application.deauthorized', account: account.providerAccountId, data: { object: { id: 'ca_platform', object: 'application' } } });
    if(error) return fail(error.msg);
    const [, can] = await canReceive({ userId: person.id });
    const [row] = await db.select().from(kempoPayoutAccount).where(eq(kempoPayoutAccount.id, account.id));
    if(can || row.status !== 'disconnected' || !row.disconnectedAt) return fail(`after deauthorizing: ${row.status}, canReceive ${can}`);
    pass('');
  },

  'a failed payout is shown until the next one is paid': async ({ pass, fail }) => {
    await purge();
    await setSettings({ connect_webhook_secret: SECRET });
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });

    await deliver({ id: `evt_${newId()}`, type: 'payout.failed', account: account.providerAccountId, created: Math.floor(Date.now() / 1000), data: { object: { id: 'po_1', failure_message: 'The bank account has been closed' } } });
    const [failed] = await db.select().from(kempoPayoutAccount).where(eq(kempoPayoutAccount.id, account.id));
    if(failed.payoutFailure !== 'The bank account has been closed') return fail(`recorded ${JSON.stringify(failed.payoutFailure)}`);

    await deliver({ id: `evt_${newId()}`, type: 'payout.paid', account: account.providerAccountId, data: { object: { id: 'po_2' } } });
    const [paid] = await db.select().from(kempoPayoutAccount).where(eq(kempoPayoutAccount.id, account.id));
    if(paid.payoutFailure !== null) return fail('a paid payout did not clear it');
    pass('');
  },

  'a payment event is handed to kempo-payments once verified, and the charge follows': async ({ pass, fail }) => {
    await purge();
    await setSettings({ connect_webhook_secret: SECRET });
    await registerOwnHooks();
    await listen('payouts:charge-succeeded');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const { charge, payment } = await seedCharge({ account, amount: 800, fee: 40 });
    const intent = status => ({ id: payment.providerRef, status, amount: 800, amount_received: status === 'succeeded' ? 800 : 0, currency: 'usd', capture_method: 'automatic', livemode: false });

    const [processingError] = await deliver({ id: `evt_${newId()}`, type: 'payment_intent.processing', account: account.providerAccountId, data: { object: intent('processing') } });
    if(processingError) return fail(processingError.msg);
    const [, processing] = await chargeById(charge.id);
    if(processing.status !== 'processing') return fail(`a processing payment left the charge ${processing.status}`);

    const succeeded = { id: `evt_${newId()}`, type: 'payment_intent.succeeded', account: account.providerAccountId, data: { object: intent('succeeded') } };
    const [error, result] = await deliver(succeeded);
    if(error || !result.forwarded || !result.handled) return fail(`not forwarded and applied: ${JSON.stringify(error || result)}`);
    const [, paid] = await chargeById(charge.id);
    if(paid.status !== 'succeeded') return fail(`the charge is ${paid.status}`);

    const [, again] = await deliver(succeeded);
    if(!again?.duplicate) return fail('a redelivered payment event was applied twice');
    if(heard('payouts:charge-succeeded').length !== 1) return fail(`payouts:charge-succeeded fired ${heard('payouts:charge-succeeded').length} times`);
    pass('');
  },

  'events about accounts this site never connected, and types nothing acts on, are acknowledged': async ({ pass, fail }) => {
    await purge();
    await setSettings({ connect_webhook_secret: SECRET });
    const [, stranger] = await deliver({ id: `evt_${newId()}`, type: 'account.updated', account: 'acct_somebody_else', data: { object: { id: 'acct_somebody_else', object: 'account' } } });
    if(!stranger?.unmatched) return fail(`another platform's account: ${JSON.stringify(stranger)}`);
    const [, ignored] = await deliver({ id: `evt_${newId()}`, type: 'customer.created', account: 'acct_x', data: { object: { id: 'cus_1' } } });
    if(ignored?.handled !== false) return fail(`an unrelated event: ${JSON.stringify(ignored)}`);
    await deleteSetting('kempo-payouts', 'connect_webhook_secret');
    pass('');
  },
};
