/*
  Money, statuses and Stripe's requirement codes in words, served at /payouts/utils/format.js.

  Money is a whole number of the currency's smallest unit. Which currencies have no minor unit or
  three of them is kempo-payments' list, imported from its own browser copy so the two can never
  disagree about whether ¥1,200 is ¥1,200 or ¥12.00.
*/
import { decimalsFor, formatAmount } from '/payments/utils/money.js';

export { decimalsFor };

export const formatMoney = (minor, currency = 'usd') => {
  const amount = Number(minor) || 0;
  const text = formatAmount(Math.abs(amount), currency);
  return amount < 0 ? `−${text}` : text;
};

/* What a person typed ("25", "25.50") as the smallest unit, or null when it is not an amount. */
export const parseMoney = (text, currency = 'usd') => {
  const decimals = decimalsFor(currency);
  const match = String(text ?? '').trim().replace(/,/g, '').match(/^(\d+)?(?:\.(\d+))?$/);
  if(!match || (match[1] === undefined && match[2] === undefined)) return null;
  const fraction = match[2] || '';
  if(fraction.length > decimals) return null;
  const minor = Number(match[1] || 0) * 10 ** decimals + Number(fraction.padEnd(decimals, '0') || 0);
  return Number.isSafeInteger(minor) ? minor : null;
};

export const toMajor = (minor, currency = 'usd') => {
  const decimals = decimalsFor(currency);
  return (Number(minor || 0) / 10 ** decimals).toFixed(decimals);
};

export const formatDateTime = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

export const formatDate = value => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';

export const ACCOUNT_STATUS = {
  pending: { label: 'Setup not finished', tone: 'muted' },
  restricted: { label: 'Stripe needs more information', tone: 'warning' },
  enabled: { label: 'Ready to be paid', tone: 'success' },
  disconnected: { label: 'Disconnected', tone: 'danger' },
};

export const accountStatus = status => ACCOUNT_STATUS[status] || { label: status, tone: 'muted' };

export const CHARGE_STATUS = {
  requires_payment_method: 'Waiting for the payer',
  requires_confirmation: 'Waiting for the payer',
  requires_action: 'Waiting for the payer’s bank',
  processing: 'Processing',
  requires_capture: 'Authorised',
  succeeded: 'Paid',
  canceled: 'Abandoned',
  failed: 'Failed',
};

export const chargeStatus = status => CHARGE_STATUS[status] || status;

/* A charge in words: its status, whether it was refunded, and whether it is disputed. */
export const chargeLabel = charge => {
  const refunded = charge.status === 'succeeded' && charge.amountRefunded > 0
    ? (charge.amountRefunded >= charge.amount ? 'Refunded' : 'Partly refunded')
    : chargeStatus(charge.status);
  return charge.disputed ? `${refunded} · disputed` : refunded;
};

export const chargeTone = charge => {
  if(charge.disputed) return 'danger';
  if(charge.status === 'succeeded') return charge.amountRefunded >= charge.amount ? 'muted' : 'success';
  if(charge.status === 'failed' || charge.status === 'canceled') return 'muted';
  return 'warning';
};

/*
  Stripe's requirement codes ("individual.verification.document") are not for people. The common
  ones get a phrase; anything else is shown as Stripe wrote it, with the dots turned into spaces.
*/
const REQUIREMENTS = [
  [/external_account/, 'a bank account to be paid into'],
  [/verification\.document/, 'a photo of an identity document'],
  [/verification\.additional_document/, 'another identity document'],
  [/tos_acceptance/, 'agreement to Stripe’s terms'],
  [/\.dob\./, 'date of birth'],
  [/ssn_last_4|id_number/, 'tax identification number'],
  [/address/, 'an address'],
  [/phone/, 'a phone number'],
  [/email/, 'an email address'],
  [/first_name|last_name|\.name/, 'a name'],
  [/business_profile\.(url|product_description)/, 'what you do or a website'],
  [/business_profile\.mcc/, 'the kind of business'],
  [/business_type/, 'whether you are an individual or a business'],
];

export const requirementLabel = code => {
  for(const [pattern, label] of REQUIREMENTS) if(pattern.test(code)) return label;
  return String(code).replace(/[._]/g, ' ');
};

export const requirementLabels = codes => [...new Set((codes || []).map(requirementLabel))];
