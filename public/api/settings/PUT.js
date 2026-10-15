import { setSetting } from 'kempo/server/sdk.js';
import { parseCountries, parseFeeCap, parseFeePercent, readConfig } from '../../../server/utils/config.js';
import { listCachedCountries } from '../../../server/utils/countries.js';
import { DECLARED_SETTINGS, descriptionOf, typeOf } from '../../../server/utils/declared.js';
import { OWNER } from '../../../server/utils/owner.js';
import { gate, refuse, wholeNumber } from '../../../server/http/gate.js';

/*
  Saves the settings, one kempo setting per field, after validating each. These are ordinary kempo
  settings and also appear under /admin/settings; what this route adds is the validation and its own
  permission, `payouts:settings`.

  **Blank means unchanged** for the webhook secret, which is never sent to the browser — saving the
  form after changing the fee must not wipe it. An explicit `null` clears it.

  `allowed_countries` can only narrow Stripe's list: every code has to be one Stripe lists, so a typo
  is refused rather than quietly allowing nobody.
*/

/* Exported so a static test can check every name here is declared in kempo-config.json. */
export const SAVEABLE = ['fee_percent', 'fee_cap', 'allowed_countries', 'connect_webhook_secret'];

export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:settings');
  if(gateError) return refuse(response, gateError);

  const body = request.body || {};
  const updates = {};

  if(body.fee_percent !== undefined){
    const percent = parseFeePercent(body.fee_percent);
    if(percent === null) return refuse(response, { code: 400, msg: 'The fee is a percentage from 0 to just under 100, with at most two decimal places' });
    updates.fee_percent = percent;
  }

  if(body.fee_cap !== undefined){
    const cap = parseFeeCap(wholeNumber(body.fee_cap));
    if(cap === null) return refuse(response, { code: 400, msg: 'The fee cap is a whole number of the currency’s smallest unit — 5000 is 50.00 — or 0 for no cap' });
    updates.fee_cap = cap;
  }

  if(body.allowed_countries !== undefined){
    const codes = parseCountries(body.allowed_countries);
    if(codes === null) return refuse(response, { code: 400, msg: 'Allowed countries are two-letter country codes, such as US, GB, CA' });
    if(codes.length){
      const [error, rows] = await listCachedCountries();
      if(error) return refuse(response, error);
      if(!rows.length) return refuse(response, { code: 409, msg: 'Fetch Stripe’s list of countries first, so the codes can be checked against it' });
      const known = new Set(rows.map(row => row.country));
      const unknown = codes.filter(code => !known.has(code));
      if(unknown.length) return refuse(response, { code: 400, msg: `Stripe does not support payouts to ${unknown.join(', ')} — the allowed countries can only narrow Stripe’s list` });
    }
    updates.allowed_countries = codes.join(',');
  }

  if(body.connect_webhook_secret !== undefined){
    if(body.connect_webhook_secret === null){
      updates.connect_webhook_secret = '';
    } else {
      const secret = String(body.connect_webhook_secret).trim();
      if(secret && !secret.startsWith('whsec_')) return refuse(response, { code: 400, msg: 'A webhook signing secret begins with whsec_ — it is shown on the endpoint’s page in Stripe, not under API keys' });
      if(secret) updates.connect_webhook_secret = secret;
    }
  }

  if(!Object.keys(updates).length) return refuse(response, { code: 400, msg: 'Nothing to save' });
  if('connect_webhook_secret' in updates && !process.env.SETTINGS_ENCRYPTION_KEY){
    return refuse(response, { code: 500, msg: 'SETTINGS_ENCRYPTION_KEY is not set on this server, so the webhook secret cannot be stored. Add it to the environment and restart.' });
  }

  for(const [name, value] of Object.entries(updates)){
    if(!SAVEABLE.includes(name) || !DECLARED_SETTINGS.has(name)) continue;
    const [error] = await setSetting(OWNER, name, value, typeOf(name), false, descriptionOf(name));
    if(error) return refuse(response, error);
  }

  response.json({ settings: await readConfig() });
};
