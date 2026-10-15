import { accountById } from '../../../../../server/utils/accounts/store.js';
import { toPublic } from '../../../../../server/utils/accounts/status.js';
import { syncAccount } from '../../../../../server/utils/accounts/sync.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  "Check with Stripe" for one account. A repair tool: the webhook is the normal path, and this is what
  fixes an account whose webhook never arrived — and shows that it did not.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const [error, account] = await accountById(request.params?.id);
  if(error) return refuse(response, error);

  const [syncError, synced] = await syncAccount(account);
  if(syncError) return refuse(response, syncError);
  response.json({ account: toPublic(synced.account), changed: synced.changed });
};
