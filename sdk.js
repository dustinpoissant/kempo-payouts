/*
  Server-side entry point — what a consumer imports to let its users be paid by other users. Crowd
  Pulse uses it for tips: a guest pays a DJ, the site keeps a fee, and the money is the DJ's, at
  Stripe, from the moment it is paid. The site never holds it.

  ```js
  import { canReceive, createConnectedPayment, feeFor } from 'kempo-payouts/sdk';

  const [, ready] = await canReceive({ userId: event.hostId });          // before offering "Tip"

  const [error, { clientSecret, connectedAccount }] = await createConnectedPayment({
    recipientUserId: event.hostId,
    amount: 500,                                    // $5.00 — minor units, in the site's currency
    reference: { owner: 'crowd-pulse', ref: event.id },
    feeAmount: event.charity ? 0 : undefined,       // optional: your own rule; otherwise the site's policy
    idempotencyKey: form.id,                        // the same key again returns the same payment
    payerUserId: guest?.id,
    description: `Tip at ${event.name}`,
  });
  // <k-pay-form client-secret="…" connected-account="…"> in the browser, then listen for
  // `payouts:charge-succeeded` rather than trusting the browser.
  ```

  The recipient onboards on the Get paid page (/payouts/), or wherever a consumer sends them with
  `createOnboardingLink`.

  Every function returns `[error, data]` with `error = { code, msg }` and none of them throws. These
  are data operations with no permission checks of their own: the routes under public/api decide who
  may do what, and anything calling in here is server-side code that has already decided.

  Hooks fired: `payouts:account-updated`, `payouts:charge-succeeded`, `payouts:charge-refunded`,
  `payouts:charge-disputed` — see server/utils/events.js.
*/

export { getAccount, canReceive, createOnboardingLink, createDashboardLink, getBalance, refreshAccount } from './server/utils/accounts/connect.js';
export { createConnectedPayment, feeFor } from './server/utils/charges/create.js';
export { refundCharge, syncCharge } from './server/utils/charges/refund.js';
export { listCharges, summary, chargeById as getCharge, chargeForPayment as getChargeForPayment } from './server/utils/charges/store.js';
export { listAccounts } from './server/utils/accounts/store.js';
export { availableCountries, refreshCountries } from './server/utils/countries.js';
export { readConfig, siteCurrency } from './server/utils/config.js';
export { receiveConnectWebhook } from './server/utils/webhooks/receive.js';
export { EVENTS } from './server/utils/events.js';
export { OWNER } from './server/utils/owner.js';
