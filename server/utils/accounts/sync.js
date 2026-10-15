import { getProvider } from '../../providers/index.js';
import { fire } from '../events.js';
import { canReceive, statusOf, toPublic } from './status.js';
import { updateAccount } from './store.js';

/*
  Where an account row is brought into line with what the processor says, and the one place
  `payouts:account-updated` is fired from — so a consumer hears about every change, whether it came
  from a webhook, the recipient returning from onboarding, or an administrator pressing "Check with
  Stripe". It fires only when something actually changed.
*/

const FIELDS = ['status', 'chargesEnabled', 'payoutsEnabled', 'detailsSubmitted', 'country', 'defaultCurrency', 'dashboard', 'feesCollector', 'lossesCollector', 'requirementsDue', 'requirementsDeadline', 'disabledReason', 'payoutFailure', 'payoutFailedAt', 'disconnectedAt', 'providerAccountId', 'livemode'];

const same = (a, b) => {
  if(a instanceof Date || b instanceof Date) return (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

export const commit = async (account, changes) => {
  const changed = Object.fromEntries(Object.entries(changes).filter(([key, value]) => FIELDS.includes(key) ? !same(account[key], value) : true));
  const meaningful = Object.keys(changed).some(key => FIELDS.includes(key));

  const [error, updated] = await updateAccount(account.id, changed);
  if(error) return [error, null];

  if(meaningful){
    await fire('payouts:account-updated', { account: toPublic(updated), previous: toPublic(account), canReceive: canReceive(updated) });
  }
  return [null, { account: updated, changed: meaningful }];
};

/*
  Applies a processor snapshot. `at` is when the processor produced it: a webhook can arrive out of
  order, and a snapshot older than the one already applied is ignored rather than allowed to undo a
  newer one.
*/
export const applySnapshot = async (account, snapshot, { at = new Date() } = {}) => {
  if(account.syncedAt && new Date(account.syncedAt).getTime() > at.getTime()) return [null, { account, changed: false, stale: true }];

  const changes = {
    chargesEnabled: snapshot.chargesEnabled,
    payoutsEnabled: snapshot.payoutsEnabled,
    detailsSubmitted: snapshot.detailsSubmitted,
    requirementsDue: snapshot.requirementsDue,
    requirementsDeadline: snapshot.requirementsDeadline,
    disabledReason: snapshot.disabledReason,
    ...(snapshot.country ? { country: snapshot.country } : {}),
    ...(snapshot.defaultCurrency ? { defaultCurrency: snapshot.defaultCurrency } : {}),
    ...(snapshot.dashboard ? { dashboard: snapshot.dashboard } : {}),
    ...(snapshot.feesCollector ? { feesCollector: snapshot.feesCollector } : {}),
    ...(snapshot.lossesCollector ? { lossesCollector: snapshot.lossesCollector } : {}),
    syncedAt: at,
  };
  changes.status = statusOf({ ...account, ...changes }, account.status);

  return commit(account, changes);
};

/* Asks the processor now and applies the answer. */
export const syncAccount = async account => {
  if(account.status === 'creating') return [{ code: 409, msg: 'This account is still being created' }, null];
  const [providerError, provider] = getProvider(account.provider);
  if(providerError) return [providerError, null];

  const [error, snapshot] = await provider.retrieveAccount(account.providerAccountId);
  if(error) return [error, null];
  return applySnapshot(account, snapshot);
};

/*
  The recipient disconnected their account from the site (or it was rejected). Nothing can be
  charged to it from this moment: `canReceive` is false before the hook announcing it has even fired.
*/
export const markDisconnected = account => commit(account, {
  status: 'disconnected',
  chargesEnabled: false,
  payoutsEnabled: false,
  disconnectedAt: account.disconnectedAt || new Date(),
});

/*
  A payout to the recipient's bank failed — a closed account, a wrong number. The money stays in
  their Stripe balance until they fix it in their dashboard; the failure is kept so both they and an
  administrator see it, and cleared by the next payout that arrives. `at` is when it happened, so the
  same failure reported twice is the same row.
*/
export const recordPayoutFailure = (account, message, at = new Date()) => commit(account, { payoutFailure: String(message || 'A payout failed').slice(0, 500), payoutFailedAt: at });

export const clearPayoutFailure = account => account.payoutFailure ? commit(account, { payoutFailure: null, payoutFailedAt: null }) : [null, { account, changed: false }];
