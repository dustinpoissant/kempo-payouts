import { onPaymentRefunded } from '../server/utils/charges/apply.js';

/*
  kempo-payments says some or all of a payment was given back — from an administrator, calling code,
  or the recipient's own Stripe dashboard. If it is one of this extension's charges, the refunded
  amount and the fee given back are brought up to date and `payouts:charge-refunded` is fired.
*/
export default async ({ payment, refund }) => {
  await onPaymentRefunded(payment, refund);
};
