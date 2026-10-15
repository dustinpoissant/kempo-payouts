import { eq } from 'drizzle-orm';
import { kempoPayoutAccount, kempoPayoutCountry } from '../server/db/schema.js';
import { canReceive, createDashboardLink, createOnboardingLink, getAccount } from '../server/utils/accounts/connect.js';
import { canReceive as accountCanReceive, statusOf } from '../server/utils/accounts/status.js';
import { applySnapshot, clearPayoutFailure, markDisconnected, recordPayoutFailure } from '../server/utils/accounts/sync.js';
import { availableCountries, checkCountry, classifyCountries, clearRefusal, ensureCountries, recordRefusal } from '../server/utils/countries.js';
import { db, seedDatabase } from './helpers/db.js';
import { COUNTRIES, freshUser, heard, listen, purge, resetSettings, seedAccount, seedCountries, setSettings } from './helpers/fixtures.js';
import { setSetting } from 'kempo/server/sdk.js';

/*
  Who can be paid, and how somebody becomes payable: the account's status rules, the country rules,
  and onboarding up to the point it would send somebody to Stripe. Stripe is not connected here, so
  every path that gets that far stops with "Stripe is not connected" — which is how these tests tell
  a request refused *before* Stripe from one that reached it.
*/

const returnUrl = 'https://site.test/payouts/?onboarding=return';
const refreshUrl = 'https://site.test/payouts/?onboarding=refresh';
const notConnected = error => /not connected/i.test(error?.msg || '');

const ready = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: [], requirementsDeadline: null, disabledReason: null };

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await resetSettings();
  await purge();
};

export default {
  'an account can be paid only when Stripe says both charges and payouts work': async ({ pass, fail }) => {
    if(statusOf({ chargesEnabled: true, payoutsEnabled: true }) !== 'enabled') return fail('both enabled is not enabled');
    if(statusOf({ chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true }) !== 'restricted') return fail('payouts off is not restricted');
    if(statusOf({ chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false }) !== 'pending') return fail('nothing submitted is not pending');
    if(statusOf({ chargesEnabled: true, payoutsEnabled: true }, 'disconnected') !== 'disconnected') return fail('a disconnected account came back to life');

    if(!accountCanReceive({ status: 'enabled', chargesEnabled: true, payoutsEnabled: true })) return fail('a ready account cannot receive');
    for(const account of [
      { status: 'enabled', chargesEnabled: true, payoutsEnabled: false },
      { status: 'restricted', chargesEnabled: true, payoutsEnabled: true },
      { status: 'disconnected', chargesEnabled: true, payoutsEnabled: true },
      null,
    ]){
      if(accountCanReceive(account)) return fail(`${JSON.stringify(account)} can receive`);
    }
    pass('');
  },

  'a user with no account gets null and cannot receive': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('Nobody');
    const [error, account] = await getAccount({ userId: person.id });
    if(error || account !== null) return fail(`got ${JSON.stringify(error || account)}`);
    const [, can] = await canReceive({ userId: person.id });
    if(can !== false) return fail('a user with no account can receive');
    const [missing] = await getAccount({});
    if(missing?.code !== 400) return fail('no user id was not refused');
    pass('');
  },

  'Stripe saying an account is ready makes it payable, once, and announces it': async ({ pass, fail }) => {
    await purge();
    await listen('payouts:account-updated');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id, status: 'pending' });

    const [error, first] = await applySnapshot(account, ready, { at: new Date() });
    if(error || first.account.status !== 'enabled') return fail(`after the snapshot: ${JSON.stringify(error || first.account.status)}`);
    const [, can] = await canReceive({ userId: person.id });
    if(!can) return fail('canReceive is still false');

    await applySnapshot(first.account, ready, { at: new Date() });
    const announced = heard('payouts:account-updated');
    if(announced.length !== 1) return fail(`the hook fired ${announced.length} times for one change`);
    if(!announced[0].data.canReceive || announced[0].data.previous.status !== 'pending') return fail(`the hook said ${JSON.stringify(announced[0].data)}`);

    const [, stale] = await applySnapshot(first.account, { ...ready, chargesEnabled: false }, { at: new Date(Date.now() - 60000) });
    if(!stale.stale) return fail('an older snapshot was applied over a newer one');
    pass('');
  },

  'a disconnected account can never be paid, from that moment': async ({ pass, fail }) => {
    await purge();
    await listen('payouts:account-updated');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });

    const [error, result] = await markDisconnected(account);
    if(error) return fail(error.msg);
    const [, can] = await canReceive({ userId: person.id });
    if(can) return fail('a disconnected account can still receive');
    if(heard('payouts:account-updated')[0]?.data.canReceive !== false) return fail('nobody was told it can no longer receive');

    const [, revived] = await applySnapshot(result.account, ready, { at: new Date() });
    if(revived.account.status !== 'disconnected') return fail('a later "ready" brought a disconnected account back');
    pass('');
  },

  'a failed payout is recorded once, and cleared by the next one that arrives': async ({ pass, fail }) => {
    await purge();
    await listen('payouts:account-updated');
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    const at = new Date();

    const [, failed] = await recordPayoutFailure(account, 'The bank account is closed', at);
    await recordPayoutFailure(failed.account, 'The bank account is closed', at);
    if(heard('payouts:account-updated').length !== 1) return fail('the same failure was announced twice');
    if(failed.account.payoutFailure !== 'The bank account is closed') return fail('the failure was not kept');

    const [, cleared] = await clearPayoutFailure(failed.account);
    if(cleared.account.payoutFailure !== null) return fail('a paid payout did not clear it');
    pass('');
  },

  'countries: Stripe’s list, the site’s currency, Brazil, refusals, and the setting that narrows them': async ({ pass, fail }) => {
    const rows = COUNTRIES.map(row => ({ ...row, isPlatform: !!row.isPlatform, refusedAt: null, fetchedAt: new Date() }));
    const all = classifyCountries(rows, { currency: 'usd' });
    const by = code => all.find(country => country.code === code);

    if(!by('US').available || by('US').converts) return fail('the US is not offered plainly');
    if(!by('GB').available || !by('GB').converts) return fail('the UK is not offered with conversion to GBP');
    if(by('XQ').available || !/cannot charge in USD/.test(by('XQ').reason)) return fail(`a country that cannot take USD: ${by('XQ').reason}`);
    if(by('BR').available || !/Brazil/.test(by('BR').reason)) return fail(`Brazil on a US platform: ${by('BR').reason}`);

    const brazilian = classifyCountries(rows.map(row => ({ ...row, isPlatform: row.country === 'BR' })), { currency: 'usd' });
    if(!brazilian.find(country => country.code === 'BR').available) return fail('Brazil is refused even to a Brazilian platform');

    const refused = classifyCountries(rows.map(row => row.country === 'CA' ? { ...row, refusedAt: new Date(), refusedReason: 'no' } : row), { currency: 'usd' });
    if(refused.find(country => country.code === 'CA').available) return fail('a country Stripe refused is still offered');

    const narrowed = classifyCountries(rows, { currency: 'usd', allowedCountries: ['US'] });
    if(narrowed.filter(country => country.available).map(country => country.code).join() !== 'US') return fail('the setting did not narrow the list');
    const invalid = classifyCountries(rows, { currency: 'usd', allowedCountriesInvalid: true });
    if(invalid.some(country => country.available)) return fail('a malformed setting widened the list instead of closing it');

    const canadian = classifyCountries(rows, { currency: 'cad' });
    if(canadian.find(country => country.code === 'GB').available) return fail('a site in CAD offers the UK, which cannot take CAD');
    pass('');
  },

  'a country is checked, with a sentence, before anybody is sent anywhere': async ({ pass, fail }) => {
    await purge();
    await seedCountries();
    await setSettings({ allowed_countries: 'US,CA' });

    const [unknown] = await checkCountry('ZZ');
    if(unknown?.msg !== 'Stripe does not support payouts to ZZ yet' && !/Stripe does not support payouts to/.test(unknown?.msg || '')) return fail(`an unknown country: ${unknown?.msg}`);
    const [brazil] = await checkCountry('br');
    if(!/Stripe does not support payouts to Brazil yet/.test(brazil?.msg || '')) return fail(`Brazil: ${brazil?.msg}`);
    const [narrowed] = await checkCountry('GB');
    if(!/does not offer payouts to United Kingdom/.test(narrowed?.msg || '')) return fail(`a country the site left out: ${narrowed?.msg}`);
    const [blank] = await checkCountry('');
    if(blank?.code !== 400) return fail('no country was not refused');
    const [, ok] = await checkCountry('ca');
    if(ok?.code !== 'CA' || !ok.converts) return fail(`Canada: ${JSON.stringify(ok)}`);

    await recordRefusal('CA', 'Stripe would not');
    const [refused] = await checkCountry('CA');
    if(!/Stripe does not support payouts to Canada yet/.test(refused?.msg || '')) return fail(`a refused country: ${refused?.msg}`);
    await clearRefusal('CA');
    const [, again] = await checkCountry('CA');
    if(!again) return fail('trying a refused country again did not offer it again');
    await resetSettings();
    pass('');
  },

  'the cached list is used when Stripe cannot be asked, and nobody is offered anything without one': async ({ pass, fail }) => {
    await purge();
    const [noList] = await checkCountry('US');
    if(noList?.code !== 409 && noList?.code !== 503) return fail(`with no list and no Stripe: ${JSON.stringify(noList)}`);

    await seedCountries();
    await db.update(kempoPayoutCountry).set({ fetchedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) });
    const [error, rows] = await ensureCountries();
    if(error || rows.length !== COUNTRIES.length) return fail(`a stale list Stripe could not refresh: ${JSON.stringify(error)}`);
    const [, offered] = await availableCountries();
    if(!offered.countries.some(country => country.code === 'US')) return fail('the stale list was not used');
    pass('');
  },

  'onboarding refuses a bad country or address before Stripe is asked, and leaves nothing behind': async ({ pass, fail }) => {
    await purge();
    await seedCountries();
    const person = await freshUser('DJ');

    const [badUrl] = await createOnboardingLink({ userId: person.id, country: 'US', returnUrl: 'javascript:alert(1)', refreshUrl });
    if(badUrl?.code !== 400) return fail(`a javascript: return address gave ${JSON.stringify(badUrl)}`);
    const [badCountry] = await createOnboardingLink({ userId: person.id, country: 'XQ', returnUrl, refreshUrl });
    if(badCountry?.code !== 400 || notConnected(badCountry)) return fail(`an unsupported country gave ${JSON.stringify(badCountry)}`);

    const [reached] = await createOnboardingLink({ userId: person.id, country: 'US', returnUrl, refreshUrl });
    if(!notConnected(reached)) return fail(`a valid request did not reach Stripe: ${JSON.stringify(reached)}`);

    const rows = await db.select().from(kempoPayoutAccount).where(eq(kempoPayoutAccount.userId, person.id));
    if(rows.length) return fail(`a failed onboarding left a ${rows[0].status} account row behind`);
    pass('');
  },

  'an existing account goes straight to Stripe for a new link; a disconnected one is put back if that fails': async ({ pass, fail }) => {
    await purge();
    await seedCountries();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id, status: 'restricted' });

    const [continuing] = await createOnboardingLink({ userId: person.id, returnUrl, refreshUrl });
    if(!notConnected(continuing)) return fail(`continuing onboarding gave ${JSON.stringify(continuing)}`);

    await db.update(kempoPayoutAccount).set({ status: 'disconnected' }).where(eq(kempoPayoutAccount.id, account.id));
    const [needsCountry] = await createOnboardingLink({ userId: person.id, returnUrl, refreshUrl });
    if(needsCountry?.code !== 400) return fail('reconnecting without a country was not refused');
    const [reconnect] = await createOnboardingLink({ userId: person.id, country: 'US', returnUrl, refreshUrl });
    if(!notConnected(reconnect)) return fail(`reconnecting gave ${JSON.stringify(reconnect)}`);
    const [row] = await db.select().from(kempoPayoutAccount).where(eq(kempoPayoutAccount.id, account.id));
    if(row.status !== 'disconnected' || row.providerAccountId !== account.providerAccountId) return fail(`a failed reconnect left the account ${row.status}, ${row.providerAccountId}`);
    pass('');
  },

  'the dashboard link needs a finished, connected account': async ({ pass, fail }) => {
    await purge();
    const nobody = await freshUser('Nobody');
    const [none] = await createDashboardLink({ userId: nobody.id });
    if(none?.code !== 404) return fail(`no account gave ${JSON.stringify(none)}`);

    const starting = await freshUser('Starting');
    await seedAccount({ userId: starting.id, status: 'pending' });
    const [early] = await createDashboardLink({ userId: starting.id });
    if(early?.code !== 409) return fail(`an unfinished account gave ${JSON.stringify(early)}`);

    const gone = await freshUser('Gone');
    await seedAccount({ userId: gone.id, status: 'disconnected' });
    const [disconnected] = await createDashboardLink({ userId: gone.id });
    if(disconnected?.code !== 409) return fail(`a disconnected account gave ${JSON.stringify(disconnected)}`);

    const full = await freshUser('Full');
    await seedAccount({ userId: full.id, dashboard: 'full', feesCollector: 'stripe', lossesCollector: 'stripe' });
    const [, link] = await createDashboardLink({ userId: full.id });
    if(link?.url !== 'https://dashboard.stripe.com/') return fail(`a full-dashboard account gave ${JSON.stringify(link)}`);

    const express = await freshUser('Express');
    await seedAccount({ userId: express.id });
    const [reached] = await createDashboardLink({ userId: express.id });
    if(!notConnected(reached)) return fail(`an Express account did not reach Stripe for its login link: ${JSON.stringify(reached)}`);
    pass('');
  },

  'the site’s currency is kempo-products’, then kempo-payments’, then USD': async ({ pass, fail }) => {
    await purge();
    const { siteCurrency } = await import('../server/utils/config.js');
    if(await siteCurrency() !== 'usd') return fail('the default is not usd');
    await setSetting('kempo-payments', 'currency', 'eur', 'string', false, null);
    if(await siteCurrency() !== 'eur') return fail('kempo-payments’ currency was not used');
    await setSetting('kempo-products', 'currency', 'GBP', 'string', false, null);
    if(await siteCurrency() !== 'gbp') return fail('kempo-products’ currency did not come first');
    await purge();
    pass('');
  },
};
