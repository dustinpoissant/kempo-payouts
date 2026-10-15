/*
  Browser client, served at /payouts/sdk.js. The same [error, data] tuples as the rest of kempo.

  Nothing here starts a payment to a user — a consumer does that on its own server through the
  server SDK, because only it knows what the payment is for — and nothing here confirms one: that is
  kempo-payments' <k-pay-form>.
*/

const BASE = '/payouts/api';

const request = async (path, options = {}) => {
  try {
    const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) return [{ code: response.status, msg: data.error || response.statusText }, null];
    return [null, data];
  } catch(error) {
    return [{ code: 0, msg: error.message }, null];
  }
};

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const query = params => {
  const search = new URLSearchParams();
  for(const [key, value] of Object.entries(params || {})){
    if(value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

/* A fresh key for one submission, so a double click does one thing. */
export const newKey = () => crypto.randomUUID();

/*
  The signed-in user's own payout account.
*/
export const getMyAccount = () => request('/my/account');
export const refreshMyAccount = () => request('/my/account/sync', json('POST'));
export const startOnboarding = ({ country } = {}) => request('/my/onboarding', json('POST', { country }));
export const openDashboard = () => request('/my/dashboard', json('POST'));
export const getMyBalance = () => request('/my/balance');
export const listMyCharges = (params = {}) => request(`/my/charges${query(params)}`);

/*
  Administration.
*/
export const listAccounts = (params = {}) => request(`/accounts${query(params)}`);
export const getAccount = id => request(`/accounts/${encodeURIComponent(id)}`);
export const syncAccount = id => request(`/accounts/${encodeURIComponent(id)}/sync`, json('POST'));
export const getAccountBalance = id => request(`/accounts/${encodeURIComponent(id)}/balance`);

export const listCharges = (params = {}) => request(`/charges${query(params)}`);
export const getCharge = id => request(`/charges/${encodeURIComponent(id)}`);
export const syncCharge = id => request(`/charges/${encodeURIComponent(id)}/sync`, json('POST'));
export const refundCharge = (id, { amount, reason, refundApplicationFee = true, idempotencyKey } = {}) => request(`/charges/${encodeURIComponent(id)}/refund`, json('POST', { amount, reason, refundApplicationFee, idempotencyKey }));

export const getSummary = () => request('/summary');

export const getSettings = () => request('/settings');
export const saveSettings = body => request('/settings', json('PUT', body));
export const getCountries = () => request('/countries');
export const refreshCountries = () => request('/countries/refresh', json('POST'));
export const retryCountry = code => request(`/countries/${encodeURIComponent(code)}/retry`, json('POST'));
