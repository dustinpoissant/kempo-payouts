import { listCharges, summary } from '../../../../server/utils/charges/store.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  The charges made to the signed-in user, newest first, with what the site kept and what was
  refunded. Read-only: a recipient sees their charges and refunds but cannot refund one (decision 3).
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:connect');
  if(gateError) return refuse(response, gateError);

  const query = request.query || {};
  const [error, list] = await listCharges({ recipientUserId: session.user.id, limit: query.limit, offset: query.offset });
  if(error) return refuse(response, error);
  const [, totals] = await summary({ recipientUserId: session.user.id });

  response.json({
    ...list,
    charges: list.charges.map(({ payerUserId, recipient, idempotencyKey, ...charge }) => charge),
    totals: totals?.totals || [],
  });
};
