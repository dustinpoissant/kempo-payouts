/*
  What an account's state means, in one place. Pure functions over a row, so the rule "who can be
  paid" is tested without a processor and read the same way by every route, hook and page.
*/

export const STATUSES = ['pending', 'restricted', 'enabled', 'disconnected'];

/*
  `enabled` only when the processor says both halves work: a charge can be made on the account, and
  the money can leave it for the recipient's bank. Charges without payouts would take a guest's money
  into a balance the recipient cannot reach.

  `restricted` once the recipient has been through onboarding but the processor still wants something
  (or has switched something off); `pending` before they have finished. `disconnected` is sticky — an
  account disconnected from the site never becomes usable again through a status update, only through
  connecting afresh.
*/
export const statusOf = (snapshot, current = null) => {
  if(current === 'disconnected') return 'disconnected';
  if(snapshot.chargesEnabled && snapshot.payoutsEnabled) return 'enabled';
  if(snapshot.detailsSubmitted || snapshot.disabledReason) return 'restricted';
  return 'pending';
};

export const canReceive = account => !!account && account.status === 'enabled' && !!account.chargesEnabled && !!account.payoutsEnabled;

/*
  The account as anybody outside this extension sees it: no processor internals beyond the id, and
  `canReceive` worked out so no caller has to know the rule.
*/
export const toPublic = account => account ? {
  id: account.id,
  userId: account.userId,
  provider: account.provider,
  providerAccountId: account.providerAccountId,
  status: account.status,
  canReceive: canReceive(account),
  chargesEnabled: account.chargesEnabled,
  payoutsEnabled: account.payoutsEnabled,
  detailsSubmitted: account.detailsSubmitted,
  country: account.country,
  defaultCurrency: account.defaultCurrency,
  dashboard: account.dashboard,
  feesCollector: account.feesCollector,
  lossesCollector: account.lossesCollector,
  requirementsDue: account.requirementsDue || [],
  requirementsDeadline: account.requirementsDeadline,
  disabledReason: account.disabledReason,
  payoutFailure: account.payoutFailure,
  payoutFailedAt: account.payoutFailedAt,
  livemode: account.livemode,
  disconnectedAt: account.disconnectedAt,
  syncedAt: account.syncedAt,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
} : null;
