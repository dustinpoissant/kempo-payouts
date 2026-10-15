import { getSetting } from 'kempo/server/sdk.js';
import { isValidCurrency, normaliseCurrency } from 'kempo-payments/sdk';
import { MAX_AMOUNT } from './validate.js';
import { OWNER } from './owner.js';

/*
  The settings, read and validated in one place. Every value the rest of the extension sees has been
  through a parser here and is known-good, with a working default behind it: a fee that is not a
  number must never reach a charge.

  Read fresh on every call rather than cached, so a change on the settings screen applies to the next
  charge without a restart.
*/

export const DEFAULTS = {
  feePercent: 5,
  feeCap: 0,
};

/*
  A percentage, 0 to just under 100, to at most two decimal places — 2.5 is fine, 2.555 is not.
  Returns null for anything else so a caller that was *handed* the value can refuse it. 100 is out:
  Stripe takes a fee only when it is less than the payment.
*/
export const parseFeePercent = value => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  if(typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number >= 100) return null;
  if(Math.abs(Math.round(number * 100) - number * 100) > 1e-9) return null;
  return number;
};

/* A whole number of the currency's smallest unit, 0 (no cap) or more. */
export const parseFeeCap = value => {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if(!Number.isSafeInteger(number) || number < 0 || number > MAX_AMOUNT) return null;
  return number;
};

/*
  Country codes from a setting or a form: "us, GB ,ca" is [US, GB, CA]. Empty means no narrowing.
  Anything that is not two letters makes the whole value null — the settings route refuses it, and a
  stored value that is somehow malformed is treated as "no countries" rather than "all of them",
  because quietly widening what an administrator narrowed is the wrong way to fail.
*/
export const parseCountries = value => {
  if(value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const codes = list.map(entry => String(entry).trim().toUpperCase()).filter(Boolean);
  if(codes.some(code => !/^[A-Z]{2}$/.test(code))) return null;
  return [...new Set(codes)];
};

const read = async (owner, name, fallback) => {
  const [error, value] = await getSetting(owner, name, fallback);
  return error ? fallback : value;
};

/*
  The site's currency, which every charge is made in: kempo-products' `currency` setting, then
  kempo-payments' own default currency, then usd. One currency for the whole site is what lets the
  fee cap be one number whatever country a recipient is in.
*/
export const siteCurrency = async () => {
  for(const owner of ['kempo-products', 'kempo-payments']){
    const code = normaliseCurrency(await read(owner, 'currency', ''));
    if(isValidCurrency(code)) return code;
  }
  return 'usd';
};

export const readConfig = async () => {
  const [feePercent, feeCap, allowed, currency] = await Promise.all([
    read(OWNER, 'fee_percent', DEFAULTS.feePercent),
    read(OWNER, 'fee_cap', DEFAULTS.feeCap),
    read(OWNER, 'allowed_countries', ''),
    siteCurrency(),
  ]);

  const percent = parseFeePercent(feePercent) ?? DEFAULTS.feePercent;
  const allowedCountries = parseCountries(allowed);

  return {
    feePercent: percent,
    feeCap: parseFeeCap(feeCap) ?? DEFAULTS.feeCap,
    allowedCountries: allowedCountries ?? [],
    allowedCountriesInvalid: allowedCountries === null,
    currency,
  };
};
