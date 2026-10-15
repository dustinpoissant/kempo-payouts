import { eq, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { getPayment } from 'kempo-payments/sdk';
import { kempoPayoutCharge } from '../../db/schema.js';
import { getProvider } from '../../providers/index.js';
import { fire } from '../events.js';
import { OWNER } from '../owner.js';
import { capExcess, proportionalFeeRefund } from './fees.js';
import { chargeForPayment, feesUsed, updateCharge } from './store.js';

/*
  How a charge follows its payment. kempo-payments owns payment state and fires `payment:*` hooks when
  it changes — from its own webhook, from the Connect webhook this extension forwards to it, from an
  administrator's refund. The handlers in hooks/ call these, and these bring the charge row up to date
  and fire this extension's own hooks.

  Every function here is safe to run twice: a hook can be re-fired, and each writes only what differs.
*/

const ours = payment => payment?.owner === OWNER;

const find = async payment => {
  if(!ours(payment)) return [null, null];
  const [error, charge] = await chargeForPayment(payment.id);
  if(error?.code === 404) return [null, null];
  return [error, charge];
};

/*
  The application fee as Stripe has it now — taken, and given back — written onto the charge. Asked
  rather than worked out, because Stripe decides how a partial refund's share of the fee rounds.
  Returns the processor's error when it cannot be asked, and changes nothing.
*/
export const syncFee = async charge => {
  const [providerError, provider] = getProvider();
  if(providerError) return [providerError, null];
  const [paymentError, payment] = await getPayment(charge.paymentId);
  if(paymentError) return [paymentError, null];

  const [error, fee] = await provider.applicationFee({ connectedAccount: charge.accountId, paymentRef: payment.providerRef });
  if(error) return [error, null];
  if(!fee) return [null, charge];
  if(fee.amount === charge.feeAmount && fee.amountRefunded === charge.feeRefunded) return [null, charge];
  return updateCharge(charge.id, { feeAmount: fee.amount, feeRefunded: fee.amountRefunded });
};

/*
  Keeps the site within its cap for a reference once a charge has succeeded — see `capExcess`.

  Worked out under a lock on the recipient and reference, so two charges succeeding at once are
  corrected one after the other and the second sees the first. What is to be given back is written
  down (`feeCapPending`) inside the lock, then given back through the processor; if the processor
  cannot be reached it stays pending, still counted as given back for the cap, and the next
  "Check with Stripe" on the charge retries it.
*/
export const correctForCap = async charge => {
  if(charge.feeSource !== 'policy' || !charge.feeCap || charge.status !== 'succeeded') return [null, charge];

  let pending = charge.feeCapPending;
  try {
    pending = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${OWNER}:cap:${charge.recipientUserId}:${charge.referenceOwner}:${charge.referenceId}`}, 0))`);
      const [current] = await tx.select().from(kempoPayoutCharge).where(eq(kempoPayoutCharge.id, charge.id)).limit(1);
      if(current.feeCapPending > 0) return current.feeCapPending;

      const [error, usedBefore] = await feesUsed({ recipientUserId: charge.recipientUserId, owner: charge.referenceOwner, ref: charge.referenceId, excludeId: charge.id }, tx);
      if(error) throw new Error(error.msg);
      const excess = capExcess({ fee: current.feeAmount - current.feeRefunded, cap: charge.feeCap, usedBefore });
      if(excess > 0) await updateCharge(charge.id, { feeCapPending: excess }, tx);
      return excess;
    });
  } catch(error) {
    console.warn(`[${OWNER}] Could not work out the fee cap for charge ${charge.id}: ${error.message}`);
    return [{ code: 500, msg: 'Could not check the fee against the cap' }, null];
  }

  if(!pending) return [null, charge];
  return returnPendingFee({ ...charge, feeCapPending: pending });
};

/* Gives back a fee correction that has been worked out but not yet made at the processor. */
export const returnPendingFee = async charge => {
  if(!(charge.feeCapPending > 0)) return [null, charge];

  const [providerError, provider] = getProvider();
  if(providerError) return [providerError, null];
  const [paymentError, payment] = await getPayment(charge.paymentId);
  if(paymentError) return [paymentError, null];

  const [feeError, fee] = await provider.applicationFee({ connectedAccount: charge.accountId, paymentRef: payment.providerRef });
  if(feeError) return [feeError, charge];
  if(!fee) return [{ code: 502, msg: 'Stripe has no fee on this charge to give back' }, charge];

  const [refundError] = await provider.refundApplicationFee({ feeId: fee.id, amount: charge.feeCapPending, idempotencyKey: `kempo-payouts-cap:${charge.id}:${fee.amountRefunded}` });
  if(refundError) return [refundError, charge];

  console.log(`[${OWNER}] Gave back ${charge.feeCapPending} of the fee on charge ${charge.id} to keep within the cap for ${charge.referenceOwner}/${charge.referenceId}`);
  return updateCharge(charge.id, { feeRefunded: fee.amountRefunded + charge.feeCapPending, feeCapPending: 0 });
};

export const onPaymentSucceeded = async payment => {
  const [error, charge] = await find(payment);
  if(error || !charge) return [error, null];
  if(charge.status === 'succeeded') return [null, charge];

  const [updateError, updated] = await updateCharge(charge.id, { status: 'succeeded', succeededAt: charge.succeededAt || new Date() });
  if(updateError) return [updateError, null];

  const [capError, corrected] = await correctForCap(updated);
  if(capError) console.warn(`[${OWNER}] The fee on charge ${charge.id} is over the cap and could not be given back yet: ${capError.msg}`);
  const current = corrected || updated;

  await fire('payouts:charge-succeeded', { charge: current, payment });
  return [null, current];
};

/*
  A refund, from anywhere — this extension's refund function, kempo-payments' admin screen, or the
  recipient's own Stripe dashboard. The refunded amount comes from the payment. The fee given back is
  asked of Stripe; when it cannot be asked, the share Stripe would return is used if this extension
  issued the refund with the fee (`feeHint`), and otherwise left alone until "Check with Stripe".
*/
export const onPaymentRefunded = async (payment, refund, { feeHint } = {}) => {
  const [error, charge] = await find(payment);
  if(error || !charge) return [error, null];

  let current = charge;
  if(payment.amountRefunded !== charge.amountRefunded){
    const [updateError, updated] = await updateCharge(charge.id, { amountRefunded: payment.amountRefunded });
    if(updateError) return [updateError, null];
    current = updated;
  }

  const [feeError, synced] = await syncFee(current);
  if(!feeError) current = synced;
  else if(feeHint?.refundApplicationFee){
    const estimate = proportionalFeeRefund({ fee: current.feeAmount, amount: current.amount, refunded: current.amountRefunded });
    if(estimate > current.feeRefunded){
      const [, estimated] = await updateCharge(current.id, { feeRefunded: estimate });
      current = estimated || current;
    }
  }

  await fire('payouts:charge-refunded', { charge: current, payment, refund: refund || null });
  return [null, current];
};

export const onPaymentDisputed = async (payment, { disputed, reason } = {}) => {
  const [error, charge] = await find(payment);
  if(error || !charge) return [error, null];
  if(charge.disputed === !!disputed) return [null, charge];

  const [updateError, updated] = await updateCharge(charge.id, { disputed: !!disputed });
  if(updateError) return [updateError, null];
  await fire('payouts:charge-disputed', { charge: updated, payment, disputed: !!disputed, reason: reason || null });
  return [null, updated];
};

export const onPaymentCanceled = async payment => {
  const [error, charge] = await find(payment);
  if(error || !charge || charge.status === 'canceled') return [error, charge || null];
  return updateCharge(charge.id, { status: 'canceled' });
};

/* A payment's status copied onto its charge, for the states that have no hook of their own. */
export const followStatus = async payment => {
  const [error, charge] = await find(payment);
  if(error || !charge || charge.status === payment.status) return [error, charge || null];
  if(payment.status === 'succeeded') return onPaymentSucceeded(payment);
  return updateCharge(charge.id, { status: payment.status });
};
