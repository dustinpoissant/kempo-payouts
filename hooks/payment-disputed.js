import { onPaymentDisputed } from '../server/utils/charges/apply.js';

/*
  kempo-payments says a chargeback was opened or closed. If it is one of this extension's charges,
  the charge shows it and `payouts:charge-disputed` is fired. On a direct charge the disputed amount
  comes out of the recipient's own balance first — see the README for who carries what is left.
*/
export default async ({ payment, disputed, reason }) => {
  await onPaymentDisputed(payment, { disputed, reason });
};
