import { onPaymentCanceled } from '../server/utils/charges/apply.js';

/* kempo-payments says a payment was abandoned or released. If it is one of this extension's charges, the charge says so. */
export default async ({ payment }) => {
  await onPaymentCanceled(payment);
};
