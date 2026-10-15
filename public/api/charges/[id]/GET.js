import { getUserById } from 'kempo/server/sdk.js';
import { getPayment, listRefunds, refundableAmount } from 'kempo-payments/sdk';
import { chargeById } from '../../../../server/utils/charges/store.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  One charge with everything an administrator looking at it needs: the payment behind it (its status
  and refunds are kempo-payments'), who it was paid to, and how much can still be refunded.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const [error, charge] = await chargeById(request.params?.id);
  if(error) return refuse(response, error);

  const [, payment] = charge.paymentId ? await getPayment(charge.paymentId) : [null, null];
  const [, refunds] = payment ? await listRefunds(payment.id) : [null, []];
  const [, recipient] = await getUserById(charge.recipientUserId);
  const [, payer] = charge.payerUserId ? await getUserById(charge.payerUserId) : [null, null];

  response.json({
    charge,
    payment,
    refunds: refunds || [],
    refundable: payment ? refundableAmount(payment) : 0,
    recipient: recipient ? { id: recipient.id, name: recipient.name, email: recipient.email } : null,
    payer: payer ? { id: payer.id, name: payer.name, email: payer.email } : null,
  });
};
