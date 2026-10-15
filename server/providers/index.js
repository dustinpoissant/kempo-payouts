import * as stripe from './stripe.js';

/*
  The registry, and the contract a Connect provider module implements. Only Stripe ships, and only
  Stripe offers what this needs; the seam is here from the first commit for the same reason it is in
  kempo-payments — so nothing outside this directory grows a dependency on one company's SDK.

  | Export                 | Shape                                                                       |
  |------------------------|-----------------------------------------------------------------------------|
  | `name`, `label`        | the id stored on every account row, and what a person is shown              |
  | `webhookPath`, `signatureHeader`, `webhookEvents` | where its Connect webhook goes, and what to subscribe |
  | `status()`             | `[err, { configured, hasWebhookSecret, mode, dashboard, feesCollector, … }]` |
  | `createAccount({ email, country, displayName, userId, idempotencyKey })` | `[err, snapshot]` — `err.refused === 'country'` when the provider will not open one there |
  | `retrieveAccount(id)`  | `[err, snapshot]` — `{ chargesEnabled, payoutsEnabled, requirementsDue, … }` |
  | `onboardingLink({ accountId, returnUrl, refreshUrl })` | `[err, { url, expiresAt }]`                 |
  | `dashboardLink({ accountId, dashboard })` | `[err, { url }]`                                         |
  | `balance({ accountId })` | `[err, { available: [{ amount, currency }], pending }]`                   |
  | `listCountries()`      | `[err, { platformCountry, countries: [{ country, supportedPaymentCurrencies, … }] }]` |
  | `applicationFee({ connectedAccount, paymentRef })` | `[err, { id, amount, amountRefunded } \| null]` |
  | `refundApplicationFee({ feeId, amount, idempotencyKey })` | `[err, { id, amount }]`                  |
  | `verifyEvent({ payload, signature })` | `[err, event]` — against the Connect endpoint's own secret   |
  | `interpretEvent(event)` | `{ kind: 'account' \| 'deauthorized' \| 'payout_failed' \| 'payout_paid' \| 'payment' \| 'ignored', accountId, … }` |

  Charges, refunds and payment webhooks are not here: they go through kempo-payments, so a payment
  has one record whichever account it was taken on.
*/

const PROVIDERS = new Map([[stripe.name, stripe]]);

export const DEFAULT_PROVIDER = stripe.name;

export const getProvider = name => {
  const provider = PROVIDERS.get(name || DEFAULT_PROVIDER);
  if(!provider) return [{ code: 400, msg: `No payout provider named "${name}" is installed` }, null];
  return [null, provider];
};

export const signatureHeaderFor = name => PROVIDERS.get(name)?.signatureHeader || null;

export const listProviders = () => [...PROVIDERS.values()].map(provider => ({
  name: provider.name,
  label: provider.label,
  webhookPath: provider.webhookPath,
  webhookEvents: provider.webhookEvents,
}));
