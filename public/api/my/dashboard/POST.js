import { createDashboardLink } from '../../../../server/utils/accounts/connect.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  A link into the signed-in user's own Stripe dashboard. A POST because the Express Dashboard link is
  a one-time login made on request, and should never be fetched by a prefetching browser.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:connect');
  if(gateError) return refuse(response, gateError);

  const [error, link] = await createDashboardLink({ userId: session.user.id });
  if(error) return refuse(response, error);
  response.json(link);
};
