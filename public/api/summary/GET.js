import { countAccounts } from '../../../server/utils/accounts/store.js';
import { summary } from '../../../server/utils/charges/store.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  The numbers across the top of the admin screen: fees collected per currency (net of fees given
  back), the money paid to recipients, the top recipients by fee, and how many accounts are in each
  state. Per currency because adding amounts across currencies means nothing.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await summary();
  if(error) return refuse(response, error);
  const [, accounts] = await countAccounts();
  response.json({ ...result, accounts: accounts || {} });
};
