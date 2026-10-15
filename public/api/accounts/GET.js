import { listAccounts } from '../../../server/utils/accounts/store.js';
import { canReceive } from '../../../server/utils/accounts/status.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  Every connected payout account, newest first. `status` takes a comma-separated list; `search`
  matches the user's name or email or the Stripe account id.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const query = request.query || {};
  const status = query.status ? String(query.status).split(',').map(value => value.trim()).filter(Boolean) : undefined;
  const [error, result] = await listAccounts({ status, search: query.search, limit: query.limit, offset: query.offset });
  if(error) return refuse(response, error);

  response.json({ ...result, accounts: result.accounts.map(account => ({ ...account, canReceive: canReceive(account) })) });
};
