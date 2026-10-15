/*
  What a caller hands this extension, checked before anything is written or any processor is asked.
  Every one of these refuses rather than coerces: an amount of 12.5 is a caller that passed dollars
  where cents were meant, and rounding it would charge somebody an amount nobody intended.

  Postgres cannot store a NUL byte in text, so one anywhere in what is about to be written is
  refused up front rather than surfacing as a failed insert after a payment already exists.
*/

/* In the currency's smallest unit: 99,999,999 is just under a million dollars — far more than a tip. */
export const MAX_AMOUNT = 99999999;

const TEXT_MAX = 500;
const KEY_MAX = 200;

export const hasNulByte = (...values) => values.some(value => JSON.stringify(value ?? null)?.includes('\\u0000'));

export const cleanUserId = (userId, label = 'A user id') => {
  if(typeof userId !== 'string' || !userId.trim()) return [{ code: 400, msg: `${label} is required` }, null];
  if(userId.length > KEY_MAX || hasNulByte(userId)) return [{ code: 400, msg: `${label} is not valid` }, null];
  return [null, userId.trim()];
};

export const cleanAmount = (amount, label = 'Amount') => {
  if(!Number.isSafeInteger(amount) || amount <= 0){
    return [{ code: 400, msg: `${label} must be a whole number of the currency’s smallest unit (cents), more than zero` }, null];
  }
  if(amount > MAX_AMOUNT) return [{ code: 400, msg: `${label} cannot be more than ${MAX_AMOUNT}` }, null];
  return [null, amount];
};

/*
  The key a caller retries under: the same on a second attempt, different for the next real
  request — a form's own id, an order id.
*/
export const cleanKey = key => {
  const value = typeof key === 'number' && Number.isSafeInteger(key) ? String(key) : key;
  if(typeof value !== 'string' || !value.trim()) return [{ code: 400, msg: 'An idempotency key is required — the same value on a retry, a new one for a new request' }, null];
  if(value.length > KEY_MAX) return [{ code: 400, msg: `An idempotency key is at most ${KEY_MAX} characters` }, null];
  if(hasNulByte(value)) return [{ code: 400, msg: 'An idempotency key cannot contain null characters' }, null];
  return [null, value.trim()];
};

export const cleanText = (value, label, { required = false, max = TEXT_MAX } = {}) => {
  if(value === undefined || value === null || (typeof value === 'string' && !value.trim())){
    return required ? [{ code: 400, msg: `${label} is required` }, null] : [null, null];
  }
  if(typeof value !== 'string') return [{ code: 400, msg: `${label} must be text` }, null];
  if(value.length > max) return [{ code: 400, msg: `${label} is at most ${max} characters` }, null];
  if(hasNulByte(value)) return [{ code: 400, msg: `${label} cannot contain null characters` }, null];
  return [null, value.trim()];
};

/*
  `{ owner, ref }`: which extension is asking, and its own id for what the money is for — Crowd
  Pulse and an event id. Required on a charge, because it is what the fee cap counts against.
*/
export const cleanReference = reference => {
  if(!reference || typeof reference !== 'object' || Array.isArray(reference)) return [{ code: 400, msg: 'A reference is required: { owner, ref } — who is asking, and their id for what the money is for' }, null];

  const ref = typeof reference.ref === 'number' && Number.isSafeInteger(reference.ref) ? String(reference.ref) : reference.ref;
  const [ownerError, owner] = cleanText(reference.owner, 'A reference owner', { required: true, max: KEY_MAX });
  if(ownerError) return [ownerError, null];
  const [refError, cleanRef] = cleanText(ref, 'A reference ref', { required: true, max: KEY_MAX });
  if(refError) return [refError, null];

  return [null, { owner, ref: cleanRef }];
};
