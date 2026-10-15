import { getUserById } from 'kempo/server/sdk.js';
import { DEFAULT_PROVIDER, getProvider } from '../../providers/index.js';
import { checkCountry, countryName, recordRefusal } from '../countries.js';
import { cleanUserId } from '../validate.js';
import { canReceive as accountCanReceive, toPublic } from './status.js';
import { accountForUser, deleteAccountRow, reclaimDisconnected, releaseAccount, reserveAccount, restoreDisconnected, updateAccount } from './store.js';
import { applySnapshot, commit, syncAccount } from './sync.js';

/*
  A user connecting the account other people pay them into — what the SDK and the Get paid page call.

  Identity and bank details are given to the processor on its own hosted pages; nothing of the kind
  ever reaches this site. What this site keeps is the processor's account id and its own copy of the
  account's status.
*/

const isWebUrl = value => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/* The user's account, or null when they have never connected one. */
export const getAccount = async ({ userId } = {}) => {
  const [idError, id] = cleanUserId(userId);
  if(idError) return [idError, null];

  const [error, account] = await accountForUser(id);
  if(error?.code === 404) return [null, null];
  if(error) return [error, null];
  return [null, account.status === 'creating' ? null : toPublic(account)];
};

/*
  True only when the processor has said both that a charge can be made on the account and that money
  can leave it for the recipient's bank. A consumer checks this before offering anybody the chance to
  pay the user — Crowd Pulse does before switching an event's Tips feature on.
*/
export const canReceive = async ({ userId } = {}) => {
  const [error, account] = await getAccount({ userId });
  if(error) return [error, null];
  return [null, accountCanReceive(account)];
};

/*
  "Check with Stripe" for one user's account: asks the processor now and writes the answer down.
  What the Get paid page does when somebody comes back from onboarding, since the webhook saying
  they are ready can arrive a few seconds after they do.
*/
export const refreshAccount = async ({ userId } = {}) => {
  const [idError, id] = cleanUserId(userId);
  if(idError) return [idError, null];
  const [error, account] = await accountForUser(id);
  if(error) return [error, null];
  const [syncError, synced] = await syncAccount(account);
  if(syncError) return [syncError, null];
  return [null, toPublic(synced.account)];
};

/*
  Sends the user to the processor's onboarding, creating their account first if they have none.

  A new account needs a country, and it is checked before anybody is sent anywhere: it has to be one
  the processor supports for this and this site allows (see server/utils/countries.js). If the
  processor then refuses the country anyway, that is recorded so nobody else is offered it, and the
  person is told in a sentence rather than shown the processor's error.

  An existing account ignores `country` — it is fixed once the account exists. A disconnected one is
  replaced by a fresh processor account on the same row.
*/
export const createOnboardingLink = async ({ userId, returnUrl, refreshUrl, country } = {}) => {
  const [idError, id] = cleanUserId(userId);
  if(idError) return [idError, null];
  if(!isWebUrl(returnUrl) || !isWebUrl(refreshUrl)) return [{ code: 400, msg: 'The return and refresh addresses must be full http(s) URLs' }, null];

  const [loadError, existing] = await accountForUser(id);
  if(loadError && loadError.code !== 404) return [loadError, null];

  let account = existing;
  let created = false;
  if(!existing || existing.status === 'disconnected'){
    const [countryError, chosen] = await checkCountry(country);
    if(countryError) return [countryError, null];

    const [userError, owner] = await getUserById(id);
    if(userError) return [{ code: userError.code === 404 ? 404 : 500, msg: userError.code === 404 ? 'No such user' : 'Could not load the user' }, null];

    const [claimError, claimed] = existing ? await reclaimDisconnected(existing.id, chosen.code) : await reserveAccount({ userId: id, provider: DEFAULT_PROVIDER, country: chosen.code });
    if(claimError) return [claimError, null];
    const undo = () => existing ? restoreDisconnected(claimed.id) : releaseAccount(claimed.id);

    const [providerError, provider] = getProvider(claimed.provider);
    if(providerError){
      await undo();
      return [providerError, null];
    }

    const [createError, snapshot] = await provider.createAccount({ email: owner.email, displayName: owner.name, country: chosen.code, userId: id, idempotencyKey: `kempo-payouts:${claimed.id}:${claimed.providerAccountId}` });
    if(createError){
      await undo();
      if(createError.refused === 'country'){
        await recordRefusal(chosen.code, createError.msg);
        return [{ code: 400, msg: `Stripe does not support payouts to ${countryName(chosen.code)} yet` }, null];
      }
      return [createError, null];
    }

    const [statusError, status] = await provider.status();
    const [commitError, committed] = await commit(claimed, {
      providerAccountId: snapshot.providerAccountId,
      status: 'pending',
      livemode: !statusError && status.livemode,
      disconnectedAt: null,
      payoutFailure: null,
      payoutFailedAt: null,
    });
    if(commitError){
      console.error(`[kempo-payouts] Created ${snapshot.providerAccountId} for user ${id} but could not record it`);
      return [commitError, null];
    }
    const [applyError, applied] = await applySnapshot(committed.account, snapshot);
    account = applyError ? committed.account : applied.account;
    created = true;
  }

  if(account.status === 'creating') return [{ code: 409, msg: 'A payout account is already being set up for you — try again in a moment' }, null];

  const [providerError, provider] = getProvider(account.provider);
  if(providerError) return [providerError, null];
  const [linkError, link] = await provider.onboardingLink({ accountId: account.providerAccountId, returnUrl, refreshUrl });

  /*
    Stripe made the account and then would not onboard it — a country Connect Onboarding does not
    support. Nobody could ever finish it, so it is undone: deleted at Stripe, and this user put back
    as they were (no account, or their old disconnected one), with the country recorded as refused.
  */
  if(linkError?.refused === 'country'){
    await recordRefusal(account.country, linkError.msg);
    if(created){
      await provider.deleteAccount(account.providerAccountId);
      if(existing) await updateAccount(account.id, { providerAccountId: existing.providerAccountId, status: 'disconnected', country: existing.country, chargesEnabled: false, payoutsEnabled: false, disconnectedAt: existing.disconnectedAt });
      else await deleteAccountRow(account.id);
    }
    return [{ code: 400, msg: `Stripe does not support payouts to ${countryName(account.country)} yet` }, null];
  }
  if(linkError) return [linkError, null];

  return [null, { url: link.url, expiresAt: link.expiresAt, account: toPublic(account) }];
};

/*
  A link into the recipient's own processor dashboard, where they see their balance and payouts and
  can change their bank details. Only once they have finished onboarding: before that there is
  nothing there for them, and the processor refuses the link anyway.
*/
export const createDashboardLink = async ({ userId } = {}) => {
  const [error, account] = await getAccount({ userId });
  if(error) return [error, null];
  if(!account) return [{ code: 404, msg: 'Connect a payout account first' }, null];
  if(account.status === 'disconnected') return [{ code: 409, msg: 'This payout account was disconnected from the site' }, null];
  if(!account.detailsSubmitted) return [{ code: 409, msg: 'Finish setting up with Stripe first' }, null];

  const [providerError, provider] = getProvider(account.provider);
  if(providerError) return [providerError, null];
  return provider.dashboardLink({ accountId: account.providerAccountId, dashboard: account.dashboard });
};

/*
  The account's balance at the processor, asked live. Where a negative balance shows — a dispute
  lost, a refund larger than what was there — which the recipient and the administrators both need to
  see, because the processor takes it from the recipient's next payments.
*/
export const getBalance = async ({ userId } = {}) => {
  const [error, account] = await getAccount({ userId });
  if(error) return [error, null];
  if(!account) return [{ code: 404, msg: 'No payout account' }, null];

  const [providerError, provider] = getProvider(account.provider);
  if(providerError) return [providerError, null];
  const [balanceError, balance] = await provider.balance({ accountId: account.providerAccountId });
  if(balanceError) return [balanceError, null];

  const negative = [...balance.available, ...balance.pending].some(entry => entry.amount < 0);
  return [null, { ...balance, negative }];
};
