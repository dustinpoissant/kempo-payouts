import { refreshAccount } from '../../../../../server/utils/accounts/connect.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  Asks Stripe about the signed-in user's own account now. The Get paid page calls it when somebody
  comes back from onboarding, because Stripe's webhook saying they are ready can arrive a few seconds
  after they do. A POST because it writes, and can fire `payouts:account-updated`.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:connect');
  if(gateError) return refuse(response, gateError);

  const [error, account] = await refreshAccount({ userId: session.user.id });
  if(error) return refuse(response, error);
  response.json({ account, canReceive: account.canReceive });
};
