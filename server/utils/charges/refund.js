import { refundPayment, syncPayment } from 'kempo-payments/sdk';
import { cleanAmount, cleanKey, cleanText } from '../validate.js';
import { followStatus, onPaymentRefunded, returnPendingFee, syncFee } from './apply.js';
import { chargeById } from './store.js';

/*
  Refunding a charge — for administrators (the admin screen) and for calling code (a consumer decides
  who may ask; Crowd Pulse might let a host refund a guest's tip). A recipient has no refund button
  of their own here: decision 3 in PLAN.md.

  The refund is kempo-payments', on the recipient's account. By default the site's fee goes back too,
  in proportion — refunding a $10 tip at 5% returns the 50¢ as well. `refundApplicationFee: false`
  keeps the fee, and the recipient's account pays the whole refund.
*/
export const refundCharge = async ({ chargeId, amount, reason = null, refundApplicationFee = true, issuedBy = null, idempotencyKey } = {}) => {
  const [chargeError, charge] = await chargeById(chargeId);
  if(chargeError) return [chargeError, null];
  if(amount !== undefined && amount !== null){
    const [amountError] = cleanAmount(amount, 'A refund amount');
    if(amountError) return [amountError, null];
  }
  if(typeof refundApplicationFee !== 'boolean') return [{ code: 400, msg: 'Whether to give back the site’s fee is true or false' }, null];
  const [reasonError, cleanedReason] = cleanText(reason, 'A reason');
  if(reasonError) return [reasonError, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  if(!charge.paymentId || charge.status !== 'succeeded') return [{ code: 409, msg: 'Only a charge that has been paid can be refunded' }, null];

  const [refundError, result] = await refundPayment(charge.paymentId, {
    amount: amount ?? undefined,
    reason: cleanedReason,
    issuedBy,
    refundApplicationFee,
    idempotencyKey: `kempo-payouts-refund:${charge.id}:${key}`,
  });
  if(refundError) return [refundError, null];

  /*
    kempo-payments has already fired payment:refunded, which brought the charge up to date. This is
    the same again with the one thing that hook could not know — whether the fee went back — so the
    fee is right even when Stripe cannot be asked for it straight away.
  */
  const [applyError, updated] = await onPaymentRefunded(result.payment, result.refunds?.[0] || null, { feeHint: { refundApplicationFee } });
  if(applyError) return [applyError, null];
  return [null, { charge: updated, payment: result.payment, refunds: result.refunds }];
};

/*
  "Check with Stripe" for one charge: the payment from kempo-payments, the fee from Stripe, and any
  fee correction for the cap that could not be made earlier.
*/
export const syncCharge = async ({ chargeId } = {}) => {
  const [chargeError, charge] = await chargeById(chargeId);
  if(chargeError) return [chargeError, null];
  if(!charge.paymentId) return [{ code: 409, msg: 'This charge never became a payment' }, null];

  const [paymentError, synced] = await syncPayment(charge.paymentId);
  if(paymentError) return [paymentError, null];

  /* The hooks have usually done this already; a charge whose hook never ran is caught up here. */
  await followStatus(synced.payment);
  const [, afterHooks] = await chargeById(chargeId);
  if(synced.payment.amountRefunded !== afterHooks.amountRefunded) await onPaymentRefunded(synced.payment, null);
  const [, current] = await chargeById(chargeId);
  const [feeError, feeSynced] = await syncFee(current);
  if(feeError) return [feeError, null];
  const [pendingError, finished] = await returnPendingFee(feeSynced);
  if(pendingError) return [pendingError, null];
  return [null, finished];
};
