import { onPaymentSucceeded } from '../server/utils/charges/apply.js';

/*
  kempo-payments says a payment succeeded. If it is one of this extension's charges, the charge is
  marked paid, its fee is checked against the cap, and `payouts:charge-succeeded` is fired. Anybody
  else's payment is ignored.
*/
export default async ({ payment }) => {
  await onPaymentSucceeded(payment);
};
