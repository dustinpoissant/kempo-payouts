import Stripe from 'stripe';
import { getSetting } from 'kempo/server/sdk.js';

/*
  Stripe Connect. Nothing outside this file knows Stripe exists.

  The contract is documented in server/providers/index.js. Taking, refunding and syncing the payments
  themselves is not here: that is kempo-payments, which this extension calls through its SDK so there
  is one payment record. What is here is the part only Connect has — creating a recipient's account,
  sending them through Stripe's onboarding, their dashboard and balance, the list of countries, the
  site's application fees, and the separate Connect webhook.

  The platform's secret key is kempo-payments' and is read from there, never copied. The only
  credential this extension stores is the signing secret of the Connect webhook endpoint.
*/

export const name = 'stripe';
export const label = 'Stripe';

/* Where Stripe's Connect webhook should be sent, appended to the site's origin. */
export const webhookPath = '/payouts/api/webhooks/stripe';

export const signatureHeader = 'stripe-signature';

/*
  What the Connect endpoint must be subscribed to — shown on the settings screen so nobody has to work
  it out from this file. Account and payout events are this extension's own; the payment, refund and
  dispute events are about charges on connected accounts and are handed to kempo-payments, which owns
  payment state.
*/
export const webhookEvents = [
  'account.updated',
  'capability.updated',
  'account.application.deauthorized',
  'payout.failed',
  'payout.paid',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'payment_intent.amount_capturable_updated',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.closed',
];

/*
  How a recipient's account is set up. **Read PLAN.md's "Findings while building" before changing it.**

  Stripe only creates connected accounts through Accounts v2 now (v1 creation, `type: 'express'`
  included, is refused), and it fixes three things at creation that can never change afterwards:
  which dashboard the recipient gets, who collects Stripe's fees on a direct charge, and who is liable
  when the account's balance goes negative. Stripe allows two setups that make sense here:

  - `express` — the Express Dashboard, which Stripe only allows with the **site** collecting fees and
    carrying losses. On a direct charge Stripe then bills the site the card processing fee, the
    dispute fees and the Connect fees, and the site files the recipients' 1099s.
  - `full` — the full Stripe Dashboard, with **Stripe** collecting its fees from the recipient and
    carrying the losses; Stripe files the 1099-K. Stripe's own recommendation for direct charges.

  `express` is what the owner decided (decision 1); `full` is the recommendation in PLAN.md. Changing
  this affects accounts created from then on; existing ones keep theirs.
*/
export const ACCOUNT_SETUPS = {
  express: { dashboard: 'express', feesCollector: 'application', lossesCollector: 'application' },
  full: { dashboard: 'full', feesCollector: 'stripe', lossesCollector: 'stripe' },
};

export const ACCOUNT_SETUP = 'express';

const read = async (owner, key) => {
  const [error, value] = await getSetting(owner, key, '');
  return error ? '' : String(value || '');
};

const credentials = async () => {
  const [secretKey, webhookSecret] = await Promise.all([
    read('kempo-payments', 'stripe_secret_key'),
    read('kempo-payouts', 'connect_webhook_secret'),
  ]);
  return { secretKey, webhookSecret };
};

/*
  One client per secret key, rebuilt when the key changes so rotating it on kempo-payments' settings
  screen takes effect without a restart.
*/
let cached = { key: null, client: null };

const clientFor = secretKey => {
  if(cached.key !== secretKey) cached = { key: secretKey, client: new Stripe(secretKey) };
  return cached.client;
};

const withClient = async () => {
  const { secretKey } = await credentials();
  if(!secretKey) return [{ code: 409, msg: 'Stripe is not connected yet — add a secret key on the Payments settings screen' }, null];
  return [null, clientFor(secretKey)];
};

/*
  Stripe's errors are written for whoever set up the platform and can run to paragraphs. They are
  logged in full, and only the first sentence goes back, capped — the same rule kempo-payments uses.
*/
const MAX_MESSAGE = 200;

export const failure = error => {
  const code = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
  const message = error?.message || 'Stripe rejected the request';
  console.warn(`[kempo-payouts] Stripe ${error?.type || 'error'}: ${message}`);
  const first = message.split(/(?<=[.!?])\s/)[0];
  return [{ code, msg: first.length > MAX_MESSAGE ? `${first.slice(0, MAX_MESSAGE - 1)}…` : first }, null];
};

export const status = async () => {
  const { secretKey, webhookSecret } = await credentials();
  const mode = secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : null;
  return [null, {
    provider: name,
    label,
    configured: !!secretKey,
    hasWebhookSecret: !!webhookSecret,
    mode,
    livemode: mode === 'live',
    webhookPath,
    webhookEvents,
    accountSetup: ACCOUNT_SETUP,
    ...ACCOUNT_SETUPS[ACCOUNT_SETUP],
  }];
};

/* Stripe calls the account paying its own fees `account` in v1 and `stripe` in v2; this keeps v2's word. */
const collector = value => value === 'account' ? 'stripe' : value || null;

/*
  A connected account, in this extension's words. Read through the v1 API, which accepts a v2
  account's id and answers with the v1 shape — the one that has `charges_enabled` and
  `payouts_enabled`, the two facts a recipient's readiness turns on.

  Requirements are the past-due and currently-due ones: what Stripe needs now, not eventually.
*/
export const fromAccount = account => ({
  providerAccountId: account.id,
  chargesEnabled: !!account.charges_enabled,
  payoutsEnabled: !!account.payouts_enabled,
  detailsSubmitted: !!account.details_submitted,
  country: account.country ? String(account.country).toUpperCase() : null,
  defaultCurrency: account.default_currency || null,
  dashboard: account.controller?.stripe_dashboard?.type || null,
  feesCollector: collector(account.controller?.fees?.payer),
  lossesCollector: collector(account.controller?.losses?.payments),
  requirementsDue: [...new Set([...(account.requirements?.past_due || []), ...(account.requirements?.currently_due || [])])],
  requirementsDeadline: account.requirements?.current_deadline ? new Date(account.requirements.current_deadline * 1000) : null,
  disabledReason: account.requirements?.disabled_reason || null,
});

/*
  Stripe declining to open an account in a country is the final word on whether it can — the country
  specs describe Stripe accounts in general, which can be wider than what a platform may create. Such
  a refusal is told apart from every other error so it can be recorded and turned into a plain
  sentence, rather than shown as Stripe's.

  It comes in two forms, both seen in test mode on a US platform (2026-10-15):

  - at creation, India: `cross_border_connected_account_creation_not_allowed` — "Connected accounts
    in IN cannot be created by platforms in US."
  - at the onboarding link, Malaysia: the account is created, then "You are trying to create an
    account link for a connected account in a country that Connect Onboarding does not yet support."
*/
export const isCountryRefusal = error => (error?.statusCode || 400) < 500 && (
  error?.code === 'cross_border_connected_account_creation_not_allowed'
  || /country/i.test(error?.param || '')
  || /cannot be created by platforms in|countr(y|ies)[^.]*(does not|doesn't|do not|not yet) support|(does not|doesn't|not yet) support[^.]*countr/i.test(error?.message || '')
);

export const createAccount = async ({ email, country, displayName, userId, idempotencyKey }) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];

  const setup = ACCOUNT_SETUPS[ACCOUNT_SETUP];
  try {
    const created = await stripe.v2.core.accounts.create({
      contact_email: email,
      ...(displayName ? { display_name: displayName } : {}),
      dashboard: setup.dashboard,
      identity: { country: String(country).toLowerCase() },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { responsibilities: { fees_collector: setup.feesCollector, losses_collector: setup.lossesCollector } },
      metadata: { kempoUserId: String(userId), createdBy: 'kempo-payouts' },
    }, idempotencyKey ? { idempotencyKey } : undefined);

    const account = await stripe.accounts.retrieve(created.id);
    return [null, fromAccount(account)];
  } catch(err) {
    if(isCountryRefusal(err)){
      console.warn(`[kempo-payouts] Stripe refused an account in ${country}: ${err.message}`);
      return [{ code: 409, msg: err.message, refused: 'country' }, null];
    }
    return failure(err);
  }
};

export const retrieveAccount = async accountId => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    return [null, fromAccount(await stripe.accounts.retrieve(accountId))];
  } catch(err) {
    return failure(err);
  }
};

/*
  Stripe's hosted onboarding, where the recipient gives their identity and bank details to Stripe —
  never to this site. A link is single-use and short-lived; `refreshUrl` is where Stripe sends
  somebody whose link expired, which should simply ask for a new one.
*/
export const onboardingLink = async ({ accountId, returnUrl, refreshUrl }) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    const link = await stripe.accountLinks.create({ account: accountId, type: 'account_onboarding', return_url: returnUrl, refresh_url: refreshUrl });
    return [null, { url: link.url, expiresAt: new Date(link.expires_at * 1000) }];
  } catch(err) {
    if(isCountryRefusal(err)){
      console.warn(`[kempo-payouts] Stripe refused onboarding for ${accountId}: ${err.message}`);
      return [{ code: 409, msg: err.message, refused: 'country' }, null];
    }
    return failure(err);
  }
};

/*
  Removes an account nobody can use — one Stripe created and then would not onboard. Only ever an
  account this extension made moments earlier, with nothing on it; Stripe refuses to delete one that
  has a balance.
*/
export const deleteAccount = async accountId => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    await stripe.accounts.del(accountId);
    return [null, true];
  } catch(err) {
    return failure(err);
  }
};

/*
  Where a recipient manages their money. The Express Dashboard needs a one-time login link made by the
  platform; somebody with the full Stripe Dashboard signs in to it with their own Stripe login.
*/
export const dashboardLink = async ({ accountId, dashboard }) => {
  if(dashboard === 'full') return [null, { url: 'https://dashboard.stripe.com/' }];
  if(dashboard !== 'express') return [{ code: 409, msg: 'This account has no Stripe dashboard' }, null];

  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    const link = await stripe.accounts.createLoginLink(accountId);
    return [null, { url: link.url }];
  } catch(err) {
    return failure(err);
  }
};

/*
  The recipient's balance at Stripe, per currency. Asked live, never stored: it is the one place a
  negative balance after a lost dispute shows up, and a stale copy of it is worse than none.
*/
export const balance = async ({ accountId }) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    const result = await stripe.balance.retrieve({}, { stripeAccount: accountId });
    const shape = entries => (entries || []).map(entry => ({ amount: entry.amount, currency: entry.currency }));
    return [null, { available: shape(result.available), pending: shape(result.pending) }];
  } catch(err) {
    return failure(err);
  }
};

/*
  Stripe's list of countries, with what each can be charged in, and the platform's own country.
*/
export const listCountries = async () => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    const countries = [];
    for await (const spec of stripe.countrySpecs.list({ limit: 100 })){
      countries.push({
        country: String(spec.id).toUpperCase(),
        defaultCurrency: spec.default_currency || null,
        supportedPaymentCurrencies: (spec.supported_payment_currencies || []).map(code => String(code).toLowerCase()),
      });
    }
    const platform = await stripe.accounts.retrieve();
    return [null, { platformCountry: platform.country ? String(platform.country).toUpperCase() : null, countries }];
  } catch(err) {
    return failure(err);
  }
};

/*
  The site's application fee on one charge, as Stripe has it: how much was taken and how much has been
  given back. The fee object lives on the platform; the charge it came from lives on the connected
  account, which is where its id is read from.
*/
export const applicationFee = async ({ connectedAccount, paymentRef }) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentRef, { expand: ['latest_charge'] }, { stripeAccount: connectedAccount });
    const fee = intent.latest_charge?.application_fee;
    const feeId = typeof fee === 'string' ? fee : fee?.id;
    if(!feeId) return [null, null];
    const found = await stripe.applicationFees.retrieve(feeId);
    return [null, { id: found.id, amount: found.amount, amountRefunded: found.amount_refunded, currency: found.currency }];
  } catch(err) {
    return failure(err);
  }
};

/* Gives part of the site's fee back to the recipient, without refunding the payment itself. */
export const refundApplicationFee = async ({ feeId, amount, idempotencyKey }) => {
  const [error, stripe] = await withClient();
  if(error) return [error, null];
  try {
    const refund = await stripe.applicationFees.createRefund(feeId, { amount }, idempotencyKey ? { idempotencyKey } : undefined);
    return [null, { id: refund.id, amount: refund.amount }];
  } catch(err) {
    return failure(err);
  }
};

/*
  Verifies a Connect webhook against its own signing secret — not kempo-payments' endpoint secret;
  Stripe signs the two endpoints separately. `payload` must be the exact bytes that arrived.

  Verification is local arithmetic with the secret; no request is made. A placeholder key is enough
  to reach the SDK's verifier when kempo-payments has no key yet.
*/
export const verifyEvent = async ({ payload, signature }) => {
  const { secretKey, webhookSecret } = await credentials();
  if(!webhookSecret) return [{ code: 409, msg: 'No Connect webhook signing secret is configured' }, null];
  if(!signature) return [{ code: 400, msg: 'Missing signature' }, null];

  try {
    return [null, clientFor(secretKey || 'sk_test_signature_check_only').webhooks.constructEvent(payload, signature, webhookSecret)];
  } catch {
    return [{ code: 400, msg: 'Signature verification failed' }, null];
  }
};

/*
  A verified Connect event, in terms of what this extension does with it. Every event from a
  connected account carries the account's id in `account`.
*/
export const interpretEvent = event => {
  const object = event.data?.object || {};
  const accountId = event.account || null;

  switch(event.type){
    case 'account.updated':
      return { kind: 'account', accountId: accountId || object.id, snapshot: object.object === 'account' ? fromAccount(object) : null };
    case 'capability.updated':
      return { kind: 'account', accountId: accountId || object.account, snapshot: null };
    case 'account.application.deauthorized':
      return { kind: 'deauthorized', accountId };
    case 'payout.failed':
      return { kind: 'payout_failed', accountId, message: object.failure_message || object.failure_code || 'A payout to the bank account failed' };
    case 'payout.paid':
      return { kind: 'payout_paid', accountId };
    default:
      if(/^(payment_intent|charge)\./.test(event.type)) return { kind: 'payment', accountId };
      return { kind: 'ignored', accountId };
  }
};
