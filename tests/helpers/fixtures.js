import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { eq, inArray, like } from 'drizzle-orm';
import { clearHandlerCache, createHook, createUser, deleteSetting, setSetting } from 'kempo/server/sdk.js';
import { hook, session, setting, user } from 'kempo/server/db/schema.js';
import { kempoPayment, kempoPaymentEvent, kempoPaymentRefund } from '../../node_modules/kempo-payments/server/db/schema.js';
import { insertPayment, newId } from '../../node_modules/kempo-payments/server/utils/payments/store.js';
import { kempoPayoutAccount, kempoPayoutCharge, kempoPayoutCountry } from '../../server/db/schema.js';
import { reserveCharge, updateCharge } from '../../server/utils/charges/store.js';
import { db } from './db.js';

/*
  What the suites share: people, accounts, countries, payments and charges written straight into the
  tables, so that nothing in the default run needs Stripe — and a way to listen to hooks.

  Nothing here is a stand-in for Stripe's behaviour. Rows are written the way the code under test
  would have written them after Stripe answered; the code that asks Stripe is proved against its
  test mode by scripts/connect-test-mode.js instead.
*/

const require = createRequire(import.meta.url);
const config = require('../../kempo-config.json');

export const key = () => crypto.randomUUID();

export const TEST_EMAIL_DOMAIN = '@payouts-suite.test';

/* A real kempo user, because onboarding reads the user's email and the lists show their name. */
export const freshUser = async (name = 'Recipient') => {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomBytes(5).toString('hex')}${TEST_EMAIL_DOMAIN}`;
  const [error, created] = await createUser({ name, email, password: 'PayoutsSuite123!', emailVerified: true });
  if(error) throw new Error(`could not create a user: ${error.msg}`);
  return created.user;
};

/*
  Every table this extension and kempo-payments write, the suite's users, its hooks and the payouts
  settings — back to nothing, so no suite runs on what another left.
*/
export const purge = async () => {
  await db.delete(kempoPaymentEvent);
  await db.delete(kempoPaymentRefund);
  await db.delete(kempoPayment);
  await db.delete(kempoPayoutCharge);
  await db.delete(kempoPayoutAccount);
  await db.delete(kempoPayoutCountry);
  await db.delete(setting).where(like(setting.name, 'kempo-payouts:%'));
  await db.delete(setting).where(inArray(setting.name, ['kempo-payments:stripe_secret_key', 'kempo-payments:stripe_webhook_secret', 'kempo-payments:stripe_publishable_key', 'kempo-products:currency', 'kempo-payments:currency']));
  await db.delete(hook).where(inArray(hook.owner, ['kempo-payouts', 'kempo-payouts-test']));
  const rows = await db.select({ id: user.id }).from(user).where(like(user.email, `%${TEST_EMAIL_DOMAIN}`));
  if(rows.length){
    await db.delete(session).where(inArray(session.userId, rows.map(row => row.id)));
    await db.delete(user).where(inArray(user.id, rows.map(row => row.id)));
  }
  clearHandlerCache();
};

/*
  Stripe's country list as the cache would hold it after a fetch. The specs are trimmed to what the
  rules read: a default currency, the currencies an account there can be charged in, and which
  country the platform is in.
*/
export const COUNTRIES = [
  { country: 'US', defaultCurrency: 'usd', supportedPaymentCurrencies: ['usd', 'eur', 'gbp', 'cad'], isPlatform: true },
  { country: 'GB', defaultCurrency: 'gbp', supportedPaymentCurrencies: ['usd', 'eur', 'gbp'] },
  { country: 'CA', defaultCurrency: 'cad', supportedPaymentCurrencies: ['usd', 'cad'] },
  { country: 'BR', defaultCurrency: 'brl', supportedPaymentCurrencies: ['usd', 'brl'] },
  { country: 'XQ', defaultCurrency: 'xqq', supportedPaymentCurrencies: ['xqq'] },
];

export const seedCountries = async (rows = COUNTRIES) => {
  await db.delete(kempoPayoutCountry);
  const now = new Date();
  for(const row of rows) await db.insert(kempoPayoutCountry).values({ isPlatform: false, ...row, fetchedAt: now });
};

/* A connected account in the state Stripe last reported. */
export const seedAccount = async ({ userId, status = 'enabled', country = 'US', ...rest } = {}) => {
  const now = new Date();
  const ready = status === 'enabled';
  const row = {
    id: `pac_${crypto.randomBytes(8).toString('hex')}`,
    userId,
    provider: 'stripe',
    providerAccountId: `acct_${crypto.randomBytes(8).toString('hex')}`,
    status,
    chargesEnabled: ready,
    payoutsEnabled: ready,
    detailsSubmitted: status !== 'pending',
    country,
    defaultCurrency: COUNTRIES.find(entry => entry.country === country)?.defaultCurrency || 'usd',
    dashboard: 'express',
    feesCollector: 'application',
    lossesCollector: 'application',
    requirementsDue: [],
    livemode: false,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
  await db.insert(kempoPayoutAccount).values(row);
  return row;
};

/*
  A charge and the kempo-payments payment behind it, as createConnectedPayment leaves them once
  Stripe has made the intent.
*/
export const seedCharge = async ({ account, amount = 1000, fee = 50, feeSource = 'policy', feeCap = null, owner = 'crowd-pulse', ref = 'event-1', status = 'requires_payment_method', currency = 'usd' } = {}) => {
  const [reserveError, charge] = await reserveCharge({
    idempotencyKey: key(),
    recipientUserId: account.userId,
    accountId: account.providerAccountId,
    referenceOwner: owner,
    referenceId: ref,
    amount,
    currency,
    feeAmount: fee,
    feeSource,
    feeCap,
  });
  if(reserveError) throw new Error(reserveError.msg);

  const [paymentError, payment] = await insertPayment({
    provider: 'stripe',
    providerRef: `pi_${newId()}`,
    status,
    amount,
    amountCaptured: status === 'succeeded' ? amount : 0,
    currency,
    owner: 'kempo-payouts',
    reference: charge.id,
    connectedAccount: account.providerAccountId,
    applicationFee: fee,
  });
  if(paymentError) throw new Error(paymentError.msg);

  const [updateError, updated] = await updateCharge(charge.id, { paymentId: payment.id, status, ...(status === 'succeeded' ? { succeededAt: new Date() } : {}) });
  if(updateError) throw new Error(updateError.msg);
  return { charge: updated, payment };
};

export const setSettings = async values => {
  for(const [name, value] of Object.entries(values)){
    const declared = config.settings.find(entry => entry.name === name);
    await setSetting('kempo-payouts', name, value, declared?.type || 'string', false, declared?.description || null);
  }
};

export const resetSettings = async () => {
  for(const { name } of config.settings) await deleteSetting('kempo-payouts', name).catch(() => {});
};

/*
  This extension's own hook handlers registered the way kempo's installer registers them from
  kempo-config.json — so a payment changed through kempo-payments reaches them exactly as on a site.
*/
export const registerOwnHooks = async () => {
  await db.delete(hook).where(eq(hook.owner, 'kempo-payouts'));
  for(const [event, callback] of Object.entries(config.hooks)){
    await createHook({ owner: 'kempo-payouts', event, callback: fileURLToPath(new URL(`../../${callback.replace(/^\.\//, '')}`, import.meta.url)) });
  }
  clearHandlerCache();
};

/* Listens to this extension's own hooks; what each was given lands in `heard()`. */
export const listen = async (...events) => {
  await db.delete(hook).where(eq(hook.owner, 'kempo-payouts-test'));
  for(const event of events) await createHook({ owner: 'kempo-payouts-test', event, callback: fileURLToPath(new URL(`../fixtures/record-${event.split(':')[1]}.js`, import.meta.url)) });
  clearHandlerCache();
  globalThis.kempoPayoutsHeard = [];
};

export const heard = event => (globalThis.kempoPayoutsHeard || []).filter(entry => !event || entry.event === event);
