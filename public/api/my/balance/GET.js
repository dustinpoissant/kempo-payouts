import { getBalance } from '../../../../server/utils/accounts/connect.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/* The signed-in user's balance at Stripe, asked live — where a negative balance after a dispute shows. */
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:connect');
  if(gateError) return refuse(response, gateError);

  const [error, balance] = await getBalance({ userId: session.user.id });
  if(error) return refuse(response, error);
  response.json({ balance });
};
