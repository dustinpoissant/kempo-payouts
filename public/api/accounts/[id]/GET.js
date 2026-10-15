import { getUserById } from 'kempo/server/sdk.js';
import { accountById } from '../../../../server/utils/accounts/store.js';
import { toPublic } from '../../../../server/utils/accounts/status.js';
import { listCharges, summary } from '../../../../server/utils/charges/store.js';
import { countryName } from '../../../../server/utils/countries.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/* One payout account: its status at Stripe, the user it belongs to, and the charges made to it. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const [error, account] = await accountById(request.params?.id);
  if(error) return refuse(response, error);

  const [, owner] = await getUserById(account.userId);
  const [, charges] = await listCharges({ recipientUserId: account.userId, limit: 50 });
  const [, totals] = await summary({ recipientUserId: account.userId });

  response.json({
    account: toPublic(account),
    countryName: countryName(account.country),
    user: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    charges: charges?.charges || [],
    totals: totals?.totals || [],
  });
};
