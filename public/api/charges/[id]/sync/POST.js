import { syncCharge } from '../../../../../server/utils/charges/refund.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  "Check with Stripe" for one charge: the payment, the fee as Stripe has it, and any part of the fee
  still owed back to keep within the cap. A POST because it writes and can move money back.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const [error, charge] = await syncCharge({ chargeId: request.params?.id });
  if(error) return refuse(response, error);
  response.json({ charge });
};
