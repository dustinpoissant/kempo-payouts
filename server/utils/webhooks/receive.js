import { getPayment, receiveVerifiedEvent } from 'kempo-payments/sdk';
import { getProvider } from '../../providers/index.js';
import { accountForProvider } from '../accounts/store.js';
import { applySnapshot, clearPayoutFailure, markDisconnected, recordPayoutFailure, syncAccount } from '../accounts/sync.js';
import { followStatus } from '../charges/apply.js';

/*
  The Connect webhook: where Stripe reports what happened on recipients' accounts.

  Stripe sends events about connected accounts to an endpoint of their own, signed with that
  endpoint's own secret (`connect_webhook_secret`). Three properties, in order of how costly they are
  to get wrong:

  1. **Verified first.** The signature is checked on the raw body before anything is read from it. An
     unverified event could mark any recipient ready to be paid, or any tip paid.
  2. **Payment state is kempo-payments'.** Payment, refund and dispute events are handed to
     kempo-payments' `receiveVerifiedEvent` — after verification, never before — which applies them
     exactly as it applies its own, with its own idempotency, and fires the `payment:*` hooks this
     extension listens to. Nothing here keeps a second copy of a payment.
  3. **Safe to receive twice.** Account events re-read the account from Stripe and write only what
     differs; a disconnection or a payout failure written twice is the same row. An event that could
     not be applied is answered with an error so Stripe sends it again.
*/

export const receiveConnectWebhook = async ({ provider: providerName, payload, signature }) => {
  const [providerError, provider] = getProvider(providerName);
  if(providerError) return [providerError, null];

  const [verifyError, event] = await provider.verifyEvent({ payload, signature });
  if(verifyError) return [verifyError, null];

  const interpreted = provider.interpretEvent(event);
  const at = event.created ? new Date(event.created * 1000) : new Date();

  if(interpreted.kind === 'payment'){
    const [error, result] = await receiveVerifiedEvent({ provider: provider.name, event });
    if(error) return [error, null];
    /* States with no `payment:*` hook of their own — processing, awaiting the customer's bank — still reach the charge. */
    if(result.paymentId){
      const [, payment] = await getPayment(result.paymentId);
      if(payment) await followStatus(payment);
    }
    return [null, { type: event.type, forwarded: true, ...result }];
  }

  if(interpreted.kind === 'ignored') return [null, { type: event.type, handled: false }];

  /*
    An event about an account this site never connected — one Stripe platform can serve a staging
    site and a live one. Recorded nowhere, and acknowledged so Stripe stops sending it.
  */
  const [lookupError, account] = interpreted.accountId ? await accountForProvider(provider.name, interpreted.accountId) : [{ code: 404 }, null];
  if(lookupError?.code === 404) return [null, { type: event.type, handled: false, unmatched: true }];
  if(lookupError) return [lookupError, null];

  let result = [null, null];
  if(interpreted.kind === 'account'){
    /*
      Read fresh rather than trusting the event's copy: account events can arrive out of order, and
      the account as Stripe has it now is never out of date. When Stripe cannot be asked, the copy in
      the event is used, and only if it is newer than what is already here.
    */
    result = await syncAccount(account);
    if(result[0] && interpreted.snapshot) result = await applySnapshot(account, interpreted.snapshot, { at });
  }
  if(interpreted.kind === 'deauthorized') result = await markDisconnected(account);
  if(interpreted.kind === 'payout_failed') result = await recordPayoutFailure(account, interpreted.message, at);
  if(interpreted.kind === 'payout_paid') result = await clearPayoutFailure(account);

  const [error] = result;
  if(error) return [error, null];
  return [null, { type: event.type, handled: true, accountId: account.id }];
};
