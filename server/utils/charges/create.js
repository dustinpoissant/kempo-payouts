import { cancelPayment, createPayment, getClientSecret, isValidAmount } from 'kempo-payments/sdk';
import { accountForUser } from '../accounts/store.js';
import { canReceive } from '../accounts/status.js';
import { readConfig } from '../config.js';
import { availableCountries, countryName } from '../countries.js';
import { OWNER } from '../owner.js';
import { cleanAmount, cleanKey, cleanReference, cleanText, cleanUserId, hasNulByte } from '../validate.js';
import { policyFee } from './fees.js';
import { chargeForKey, feesUsed, releaseCharge, reserveCharge, updateCharge } from './store.js';

/*
  Charging somebody's payout account: a guest tipping a DJ.

  The charge is a Stripe Connect *direct charge* — the payment is made on the recipient's own account,
  with the site's fee as the application fee. kempo-payments creates and records the payment; this
  adds who it was for, which reference it counts against, and the fee.
*/

/*
  The fee the site's policy would take on a charge of `amount` to this recipient for this reference:
  the fee percentage, held under the per-reference cap by what has already been kept. What
  `createConnectedPayment` uses when the caller names no fee, and what a consumer shows a payer
  before they pay.
*/
export const feeFor = async ({ amount, recipientUserId, reference } = {}) => {
  const [amountError, cleanedAmount] = cleanAmount(amount);
  if(amountError) return [amountError, null];
  const [userError, recipient] = cleanUserId(recipientUserId, 'A recipient');
  if(userError) return [userError, null];
  const [referenceError, cleanedReference] = cleanReference(reference);
  if(referenceError) return [referenceError, null];

  const config = await readConfig();
  const [usedError, used] = config.feeCap ? await feesUsed({ recipientUserId: recipient, owner: cleanedReference.owner, ref: cleanedReference.ref }) : [null, 0];
  if(usedError) return [usedError, null];

  const result = policyFee({ amount: cleanedAmount, currency: config.currency, percent: config.feePercent, cap: config.feeCap, used });
  return [null, { ...result, currency: config.currency, percent: config.feePercent, cap: config.feeCap || null, used }];
};

/*
  Starts a payment to a user. Hand `clientSecret` and `connectedAccount` to the browser's
  `<k-pay-form>`, and listen for `payouts:charge-succeeded` rather than trusting the browser.

  - `amount` is in the site's currency (`currency`, if passed, must be that one).
  - `reference` is `{ owner, ref }` — required; it is what the fee cap counts against.
  - `feeAmount` overrides the policy: a consumer's own rule, such as Crowd Pulse's charity events
    paying no fee. 0 takes none. It must be less than the amount.
  - `idempotencyKey` is required. The same key again returns the same charge and a fresh client
    secret instead of a second payment — a guest double-tapping "Tip" is charged once.

  Refused before any processor is asked: a recipient who cannot receive, a recipient in a country the
  site has since stopped allowing, and anything malformed.
*/
export const createConnectedPayment = async ({
  recipientUserId,
  amount,
  currency,
  reference,
  feeAmount,
  idempotencyKey,
  description = null,
  payerUserId = null,
  customerEmail = null,
  metadata = null,
} = {}) => {
  const [amountError, cleanedAmount] = cleanAmount(amount);
  if(amountError) return [amountError, null];
  const [userError, recipient] = cleanUserId(recipientUserId, 'A recipient');
  if(userError) return [userError, null];
  const [referenceError, cleanedReference] = cleanReference(reference);
  if(referenceError) return [referenceError, null];
  const [keyError, key] = cleanKey(idempotencyKey);
  if(keyError) return [keyError, null];
  const [descriptionError, cleanedDescription] = cleanText(description, 'A description');
  if(descriptionError) return [descriptionError, null];
  if(hasNulByte(payerUserId, customerEmail, metadata)) return [{ code: 400, msg: 'Payment details cannot contain null characters' }, null];
  if(metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) return [{ code: 400, msg: 'Metadata is an object of short strings' }, null];

  const config = await readConfig();
  if(currency !== undefined && currency !== null && String(currency).trim().toLowerCase() !== config.currency){
    return [{ code: 400, msg: `Payments to users are made in the site’s currency, ${config.currency.toUpperCase()}` }, null];
  }
  if(!isValidAmount(cleanedAmount, config.currency)) return [{ code: 400, msg: `${cleanedAmount} is not a chargeable amount in ${config.currency.toUpperCase()}` }, null];

  if(feeAmount !== undefined && feeAmount !== null){
    if(!Number.isSafeInteger(feeAmount) || feeAmount < 0) return [{ code: 400, msg: 'A fee is a whole number of the currency’s smallest unit, zero or more' }, null];
    if(feeAmount >= cleanedAmount) return [{ code: 400, msg: 'The fee has to be less than the payment' }, null];
    if(feeAmount && !isValidAmount(feeAmount, config.currency)) return [{ code: 400, msg: `${feeAmount} is not a valid fee in ${config.currency.toUpperCase()}` }, null];
  }

  /* A retry: the same charge again, with a fresh secret for the form. */
  const [, earlier] = await chargeForKey(key);
  if(earlier) return resume(earlier);

  const [accountError, account] = await accountForUser(recipient);
  if(accountError?.code === 404 || (account && !canReceive(account))){
    return [{ code: 409, msg: 'This person cannot be paid yet — they have not finished connecting a payout account' }, null];
  }
  if(accountError) return [accountError, null];

  /*
    The site may have narrowed its countries after this recipient connected. Charges stop for them
    from then on; they keep everything already paid.
  */
  const [countriesError, countries] = await availableCountries({ fetch: false });
  if(!countriesError && countries.all.length && !countries.countries.some(country => country.code === account.country)){
    return [{ code: 409, msg: `This site no longer offers payouts to ${countryName(account.country)}` }, null];
  }

  let fee = feeAmount;
  let feeSource = 'caller';
  if(fee === undefined || fee === null){
    const [usedError, used] = config.feeCap ? await feesUsed({ recipientUserId: recipient, owner: cleanedReference.owner, ref: cleanedReference.ref }) : [null, 0];
    if(usedError) return [usedError, null];
    fee = policyFee({ amount: cleanedAmount, currency: config.currency, percent: config.feePercent, cap: config.feeCap, used }).fee;
    feeSource = 'policy';
  }

  const [reserveError, charge] = await reserveCharge({
    idempotencyKey: key,
    recipientUserId: recipient,
    accountId: account.providerAccountId,
    referenceOwner: cleanedReference.owner,
    referenceId: cleanedReference.ref,
    payerUserId: payerUserId || null,
    amount: cleanedAmount,
    currency: config.currency,
    feeAmount: fee,
    feeSource,
    feeCap: feeSource === 'policy' && config.feeCap ? config.feeCap : null,
    description: cleanedDescription,
  });
  if(reserveError?.duplicate){
    const [, raced] = await chargeForKey(key);
    return raced ? resume(raced) : [{ code: 409, msg: 'That payment is already being started — try again in a moment' }, null];
  }
  if(reserveError) return [reserveError, null];

  const [paymentError, created] = await createPayment({
    amount: cleanedAmount,
    currency: config.currency,
    captureMethod: 'automatic',
    owner: OWNER,
    reference: charge.id,
    userId: payerUserId || null,
    customerEmail: customerEmail || null,
    description: cleanedDescription,
    metadata: {
      ...(metadata || {}),
      kempoPayoutCharge: charge.id,
      recipientUserId: recipient,
      referenceOwner: cleanedReference.owner,
      referenceId: cleanedReference.ref,
    },
    connectedAccount: account.providerAccountId,
    applicationFee: fee,
  });
  if(paymentError){
    await releaseCharge(charge.id);
    return [paymentError, null];
  }

  const [updateError, recorded] = await updateCharge(charge.id, { paymentId: created.payment.id, status: created.payment.status });
  if(updateError){
    /*
      A payment with no charge row would be paid to the recipient with nothing here knowing about it.
      Cancelling it is best-effort; it is logged either way so it can be found.
    */
    const [cancelError] = await cancelPayment(created.payment.id);
    console.error(`[kempo-payouts] Payment ${created.payment.id} could not be recorded as charge ${charge.id}${cancelError ? ', and could not be cancelled' : '; it was cancelled'}`);
    await releaseCharge(charge.id);
    return [updateError, null];
  }

  return [null, { charge: recorded, payment: created.payment, clientSecret: created.clientSecret, connectedAccount: account.providerAccountId }];
};

const resume = async charge => {
  if(!charge.paymentId) return [{ code: 409, msg: 'That payment is already being started — try again in a moment' }, null];
  const [error, result] = await getClientSecret(charge.paymentId);
  if(error) return [error, null];
  return [null, { charge, payment: result.payment, clientSecret: result.clientSecret, connectedAccount: result.connectedAccount || charge.accountId, resumed: true }];
};
