import { asc, eq, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { kempoPayoutCountry } from '../db/schema.js';
import { getProvider } from '../providers/index.js';
import { readConfig } from './config.js';

/*
  Which countries a recipient can connect from. The list is the processor's — Stripe's country
  specs, cached in kempoPayoutCountry — and is never typed in here. On top of it, four rules, each
  one Stripe's or the site's, never a guess:

  1. **The site's currency.** Every charge is made in the site's currency, so a country is offered
     only when its spec lists that currency among the ones an account there can be charged in. The
     recipient's money is then converted into their own currency by Stripe.
  2. **Brazil, on a platform outside it.** "Platforms based outside of Brazil with Brazilian connected
     accounts can't collect application fees through Stripe" (Stripe's direct charges guide). The
     site could not take its fee, so BR is left off unless the platform is itself in Brazil.
  3. **Stripe's refusal.** When Stripe declines to open an account in a country after all, that is
     recorded and the country is not offered again until an administrator says to try it again.
  4. **The site's setting.** `allowed_countries` can only narrow what is left; empty means all of it.
*/

const STALE_AFTER = 7 * 24 * 60 * 60 * 1000;

const names = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export const countryName = code => {
  try {
    return names?.of(code) || code;
  } catch {
    return code;
  }
};

export const listCachedCountries = async () => {
  try {
    const rows = await db.select().from(kempoPayoutCountry).orderBy(asc(kempoPayoutCountry.country));
    return [null, rows];
  } catch {
    return [{ code: 500, msg: 'Could not load the list of countries' }, null];
  }
};

/*
  Asks Stripe for its list again and stores it. Refusals Stripe made when an account was actually
  attempted are kept — the country specs describe Stripe accounts in general, and a refusal is the
  more specific answer.
*/
export const refreshCountries = async () => {
  const [providerError, provider] = getProvider();
  if(providerError) return [providerError, null];

  const [error, result] = await provider.listCountries();
  if(error) return [error, null];
  if(!result.countries.length) return [{ code: 502, msg: 'Stripe returned no countries' }, null];

  const now = new Date();
  try {
    await db.transaction(async tx => {
      for(const entry of result.countries){
        const values = {
          country: entry.country,
          defaultCurrency: entry.defaultCurrency,
          supportedPaymentCurrencies: entry.supportedPaymentCurrencies,
          isPlatform: entry.country === result.platformCountry,
          fetchedAt: now,
        };
        await tx.insert(kempoPayoutCountry).values(values).onConflictDoUpdate({
          target: kempoPayoutCountry.country,
          set: { defaultCurrency: values.defaultCurrency, supportedPaymentCurrencies: values.supportedPaymentCurrencies, isPlatform: values.isPlatform, fetchedAt: now },
        });
      }
      /* A country Stripe no longer lists is not offered: it has gone from Stripe's list, so it goes from this one. */
      await tx.delete(kempoPayoutCountry).where(sql`${kempoPayoutCountry.fetchedAt} < ${now}`);
    });
  } catch {
    return [{ code: 500, msg: 'Could not store the list of countries' }, null];
  }
  return [null, { count: result.countries.length, platformCountry: result.platformCountry, fetchedAt: now }];
};

/*
  The cached list, fetched first if there is none or it is more than a week old. A failed fetch is
  not an error when there is a list to fall back on — Stripe being briefly unreachable should not stop
  somebody choosing their country.
*/
export const ensureCountries = async () => {
  const [error, rows] = await listCachedCountries();
  if(error) return [error, null];

  const newest = rows.reduce((latest, row) => Math.max(latest, new Date(row.fetchedAt).getTime()), 0);
  if(rows.length && Date.now() - newest < STALE_AFTER) return [null, rows];

  const [refreshError] = await refreshCountries();
  if(refreshError) return rows.length ? [null, rows] : [refreshError, null];
  return listCachedCountries();
};

/*
  Every cached country, each with whether it can be offered and, if not, why. The settings screen
  shows all of it; the Get paid page shows only `available`.
*/
export const classifyCountries = (rows, { currency, allowedCountries = [], allowedCountriesInvalid = false }) => {
  const platform = rows.find(row => row.isPlatform)?.country || null;
  const allowed = new Set(allowedCountries);

  return rows.map(row => {
    const supported = (row.supportedPaymentCurrencies || []).includes(currency);
    const reason = row.refusedAt ? `Stripe would not open an account there: ${row.refusedReason || 'no reason given'}`
      : !supported ? `Stripe cannot charge in ${currency.toUpperCase()} on an account there`
      : row.country === 'BR' && platform !== 'BR' ? 'Stripe cannot collect a fee for this site on a Brazilian account unless the site’s own Stripe account is in Brazil'
      : allowedCountriesInvalid ? 'The allowed countries setting is not a list of country codes'
      : allowed.size && !allowed.has(row.country) ? 'Not one of the countries this site allows'
      : null;

    return {
      code: row.country,
      name: countryName(row.country),
      defaultCurrency: row.defaultCurrency,
      converts: !!row.defaultCurrency && row.defaultCurrency !== currency,
      stripeSupports: supported && !row.refusedAt && !(row.country === 'BR' && platform !== 'BR'),
      available: !reason,
      reason,
      refused: !!row.refusedAt,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
};

export const availableCountries = async ({ fetch = true } = {}) => {
  const [error, rows] = fetch ? await ensureCountries() : await listCachedCountries();
  if(error) return [error, null];
  const config = await readConfig();
  const countries = classifyCountries(rows, config);
  return [null, { currency: config.currency, countries: countries.filter(country => country.available), all: countries, fetchedAt: rows[0]?.fetchedAt || null }];
};

/*
  Whether one country can be onboarded right now, with a sentence for the person if not. Asked before
  anybody is sent to Stripe.
*/
export const checkCountry = async code => {
  const country = String(code || '').trim().toUpperCase();
  if(!/^[A-Z]{2}$/.test(country)) return [{ code: 400, msg: 'Choose the country you live in' }, null];

  const [error, result] = await availableCountries();
  if(error) return [{ code: error.code === 409 ? 409 : 503, msg: 'The list of countries Stripe supports could not be loaded, so nobody can be connected yet. Try again shortly.' }, null];

  const found = result.all.find(entry => entry.code === country);
  if(!found || !found.stripeSupports) return [{ code: 400, msg: `Stripe does not support payouts to ${countryName(country)} yet` }, null];
  if(!found.available) return [{ code: 400, msg: `This site does not offer payouts to ${found.name}` }, null];
  return [null, { ...found, currency: result.currency }];
};

export const recordRefusal = async (code, reason) => {
  try {
    await db.update(kempoPayoutCountry).set({ refusedAt: new Date(), refusedReason: String(reason || '').slice(0, 300) || null }).where(eq(kempoPayoutCountry.country, code));
  } catch {
    // The refusal itself already reached the person; failing to remember it only means they can try again.
  }
};

export const clearRefusal = async code => {
  try {
    const [row] = await db.update(kempoPayoutCountry).set({ refusedAt: null, refusedReason: null }).where(eq(kempoPayoutCountry.country, String(code || '').toUpperCase())).returning();
    if(!row) return [{ code: 404, msg: 'That country is not on Stripe’s list' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not update the country' }, null];
  }
};
