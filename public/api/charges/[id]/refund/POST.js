import { refundCharge } from '../../../../../server/utils/charges/refund.js';
import { gate, refuse, wholeNumber } from '../../../../../server/http/gate.js';

/*
  Refunds a charge, in full (no amount) or in part. `refundApplicationFee` defaults to true — the
  site's fee goes back with it, in proportion. `idempotencyKey` is required, so a double-submitted form
  refunds once. `issuedBy` is the signed-in administrator, never anything in the body.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:refund');
  if(gateError) return refuse(response, gateError);

  const body = request.body || {};
  const [error, result] = await refundCharge({
    chargeId: request.params?.id,
    amount: wholeNumber(body.amount),
    reason: body.reason || null,
    refundApplicationFee: body.refundApplicationFee ?? true,
    issuedBy: session.user.id,
    idempotencyKey: body.idempotencyKey,
  });
  if(error) return refuse(response, error);
  response.json(result);
};
