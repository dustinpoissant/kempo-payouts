import { decimalsFor } from 'kempo-payments/sdk';

/*
  The site's fee, as arithmetic. Everything here is a pure function of numbers, so the rules that
  decide how much of a tip the site keeps are tested exactly, without a database or a processor.

  All amounts are whole numbers of the charge currency's smallest unit. The charge currency is always
  the site's, so the percentage and the cap mean the same thing whichever country a recipient is in.
*/

/*
  A percentage of an amount, rounded **down** to the smallest unit: the site never takes more than
  the percentage it advertises. Worked in basis points so 2.5% is exact rather than a float.

  In the three-decimal currencies (KWD, BHD, …) Stripe only accepts amounts in whole hundredths, the
  same rule kempo-payments applies to payments, so the fee is rounded down to a multiple of ten there.
*/
export const percentOf = (amount, percent, currency) => {
  const basisPoints = Math.round(percent * 100);
  const fee = Math.floor(amount * basisPoints / 10000);
  return decimalsFor(currency) === 3 ? fee - (fee % 10) : fee;
};

/*
  The fee the policy takes on one charge.

  `used` is what the site has already kept from this recipient for this reference — the net fees of
  their charges that succeeded. With a cap, the fee is never more than what is left under it; with no
  cap (`cap` 0) the percentage applies on its own.

  Stripe also needs the fee to be less than the payment, which a percentage under 100 guarantees.
*/
export const policyFee = ({ amount, currency, percent, cap = 0, used = 0 }) => {
  const full = percentOf(amount, percent, currency);
  if(!cap) return { fee: full, full, capped: false, remaining: null };

  const remaining = Math.max(0, cap - used);
  const room = decimalsFor(currency) === 3 ? remaining - (remaining % 10) : remaining;
  const fee = Math.min(full, room);
  return { fee, full, capped: fee < full, remaining };
};

/*
  How much of one charge's fee has to be given back, once it has succeeded, to keep the site within
  its cap for that reference.

  The fee is fixed when the payment is created, from the charges that had succeeded by then. Two tips
  started at the same moment near the cap both see the same room, and the second to succeed can take
  the total past it. This is the correction: when a charge succeeds, everything that succeeded before
  it is counted (`usedBefore`, net of anything already given back), and whatever of this charge's fee
  does not fit under the cap is returned to the recipient. Charges are corrected one at a time per
  reference, so each one sees the ones before it.
*/
export const capExcess = ({ fee, cap, usedBefore }) => {
  if(!cap || fee <= 0) return 0;
  return Math.max(0, Math.min(fee, usedBefore + fee - cap));
};

/*
  What Stripe gives back of the fee when a payment is refunded with `refund_application_fee`: all of
  it for a full refund, otherwise the same share as the refund. Used only as an estimate when the
  processor cannot be asked — the processor's own figure replaces it as soon as it can.
*/
export const proportionalFeeRefund = ({ fee, amount, refunded }) => {
  if(!fee || !amount) return 0;
  if(refunded >= amount) return fee;
  return Math.floor(fee * refunded / amount);
};
