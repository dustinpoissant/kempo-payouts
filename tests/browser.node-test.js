import path from 'path';
import { eq } from 'drizzle-orm';
import { setting } from 'kempo/server/db/schema.js';
import { db, integrationOnly, integrationTier } from './helpers/db.js';
import { COUNTRIES, purge, seedAccount, seedCharge, seedCountries } from './helpers/fixtures.js';
import { kempoPayoutCharge } from '../server/db/schema.js';
import { buildSite, call, joinExtensionGroups, login, purgeSite, screensDir, seedPeople, startServer, stopServer } from './helpers/site.js';

/*
  The extension in a real browser, on a real kempo site, through every screen.

  A throwaway site is built and served by this suite (helpers/site.js); kempo-payments and this
  extension are installed into it through kempo's own install route, the way an administrator would.
  Chromium is driven by Playwright; each screen is opened, used, checked for console errors, and
  screenshotted into tests/.tmp-site/screens.

  Stripe is not connected on this site, so the screens are shown with accounts and payments written
  into the database the way Stripe's answers would have left them, and anything that would send
  somebody to Stripe is checked to stop with a sentence rather than an error page. The Stripe parts
  are proved against its test mode by scripts/connect-test-mode.js.

  Integration tier only: it needs a real Postgres and a second server process.
*/

const USERS = {
  admin: { name: 'Payouts Admin', email: 'payouts-admin@test.local', password: 'PayoutsAdmin123!', groups: ['system:Administrators'] },
  manager: { name: 'Payouts Manager', email: 'payouts-manager@test.local', password: 'PayoutsManager123!', groups: ['kempo-payouts:administrator'] },
  viewer: { name: 'Payouts Viewer', email: 'payouts-viewer@test.local', password: 'PayoutsViewer123!', groups: ['kempo-payouts:viewer'] },
  dj: { name: 'DJ Recipient', email: 'payouts-dj@test.local', password: 'PayoutsDj123!', groups: [] },
  guest: { name: 'New Member', email: 'payouts-member@test.local', password: 'PayoutsMember123!', groups: [] },
};

const EXTENSIONS = ['kempo-payouts', 'kempo-payments'];

const state = { server: null, browser: null, tokens: {}, ids: {}, errors: [], page: null, charge: null, account: null };

/*
  Console errors on our pages are failures. A missing icon is not (k-icon looks in several places in
  turn), and neither is a request this suite expects to be refused — Stripe is not connected here.
*/
const IGNORED = [/Failed to load resource.*404/, /icons\//, /favicon/, /Failed to load resource.*409/];

const newPage = async who => {
  const context = await state.browser.newContext({ viewport: { width: 1280, height: 900 } });
  if(who) await context.addCookies([{ name: 'session_token', value: state.tokens[who], url: state.server.base }]);
  const page = await context.newPage();
  state.page = page;
  page.on('console', message => {
    if(message.type() === 'error' && !IGNORED.some(pattern => pattern.test(message.text()))) state.errors.push(`${who || 'anonymous'} ${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', error => state.errors.push(`${who || 'anonymous'} ${page.url()}: ${error.message}`));
  return page;
};

const shot = (page, name) => page.screenshot({ path: path.join(screensDir, `${name}.png`), fullPage: true });

const clean = start => {
  const errors = state.errors.slice(start);
  return errors.length ? `\n    ${errors.join('\n    ')}` : null;
};

const tests = {
  'a site boots, and kempo-payments then kempo-payouts install through kempo’s own route': async ({ pass, fail }) => {
    await purgeSite({ users: USERS, extensions: EXTENSIONS });
    await purge();
    await buildSite({ own: 'kempo-payouts', others: ['kempo-payments'] });
    state.ids = await seedPeople(USERS);
    state.server = await startServer();

    state.tokens.admin = await login(state.server.base, USERS.admin);
    if(!state.tokens.admin) return fail('the administrator could not sign in');

    const refusedFirst = await call(state.server.base, 'POST', '/kempo/api/extensions', { token: state.tokens.admin, body: { name: 'kempo-payouts' } });
    if(refusedFirst.status !== 409) return fail(`installing payouts before payments gave ${refusedFirst.status}`);

    for(const name of ['kempo-payments', 'kempo-payouts']){
      const installed = await call(state.server.base, 'POST', '/kempo/api/extensions', { token: state.tokens.admin, body: { name } });
      if(installed.status !== 200) return fail(`installing ${name}: ${installed.status} ${JSON.stringify(installed.data)}`);
    }

    await joinExtensionGroups(USERS, state.ids);
    for(const who of ['manager', 'viewer', 'dj', 'guest']){
      state.tokens[who] = await login(state.server.base, USERS[who]);
      if(!state.tokens[who]) return fail(`${who} could not sign in`);
    }

    // What Stripe's answers would have left: its country list, a DJ who finished onboarding, and some tips.
    await seedCountries();
    state.account = await seedAccount({ userId: state.ids.dj, country: 'US' });
    state.charge = (await seedCharge({ account: state.account, amount: 2500, fee: 125, status: 'succeeded', ref: 'wedding' })).charge;
    const refunded = await seedCharge({ account: state.account, amount: 1000, fee: 50, status: 'succeeded', ref: 'wedding' });
    await db.update(kempoPayoutCharge).set({ amountRefunded: 1000, feeRefunded: 50 }).where(eq(kempoPayoutCharge.id, refunded.charge.id));
    const disputed = await seedCharge({ account: state.account, amount: 500, fee: 25, status: 'succeeded', ref: 'bar-night' });
    await db.update(kempoPayoutCharge).set({ disputed: true }).where(eq(kempoPayoutCharge.id, disputed.charge.id));

    const { chromium } = await import('playwright');
    state.browser = await chromium.launch();
    pass(state.server.base);
  },

  'every route answers each audience as it should': async ({ pass, fail }) => {
    if(!state.server) return fail('no site');
    const charge = state.charge.id;
    const account = state.account.id;
    const contract = [
      ['GET', '/payouts/', null, 200],
      ['GET', '/payouts/api/my/account', null, 401],
      ['GET', '/payouts/api/my/account', 'guest', 200],
      ['GET', '/payouts/api/my/account', 'dj', 200],
      ['GET', '/payouts/api/my/charges', 'dj', 200],
      ['POST', '/payouts/api/my/onboarding', null, 401],
      ['POST', '/payouts/api/my/onboarding', 'guest', 400],
      ['POST', '/payouts/api/my/dashboard', 'guest', 404],
      ['GET', '/payouts/api/accounts', null, 401],
      ['GET', '/payouts/api/accounts', 'dj', 403],
      ['GET', '/payouts/api/accounts', 'viewer', 200],
      ['GET', '/payouts/api/accounts', 'manager', 200],
      ['GET', `/payouts/api/accounts/${account}`, 'viewer', 200],
      ['GET', '/payouts/api/charges', 'dj', 403],
      ['GET', '/payouts/api/charges', 'viewer', 200],
      ['GET', `/payouts/api/charges/${charge}`, 'viewer', 200],
      ['POST', `/payouts/api/charges/${charge}/refund`, 'dj', 403],
      ['POST', `/payouts/api/charges/${charge}/refund`, 'viewer', 403],
      ['POST', `/payouts/api/charges/${charge}/refund`, 'manager', 400],
      ['GET', '/payouts/api/summary', 'viewer', 200],
      ['GET', '/payouts/api/settings', 'viewer', 403],
      ['GET', '/payouts/api/settings', 'manager', 200],
      ['PUT', '/payouts/api/settings', 'viewer', 403],
      ['GET', '/payouts/api/countries', 'manager', 200],
      ['POST', '/payouts/api/webhooks/stripe', null, 409],
      ['POST', '/payouts/api/webhooks/paypal', null, 404],
      ['GET', '/admin/extension/kempo-payouts/', 'dj', 302],
      ['GET', '/admin/extension/kempo-payouts/', 'viewer', 200],
      ['GET', '/admin/extension/kempo-payouts/', 'manager', 200],
    ];

    const wrong = [];
    for(const [method, url, who, expected] of contract){
      const { status } = await call(state.server.base, method, url, { token: who ? state.tokens[who] : null, body: method === 'GET' ? undefined : {} });
      if(status !== expected) wrong.push(`${method} ${url} as ${who || 'nobody'}: expected ${expected}, got ${status}`);
    }
    if(wrong.length) return fail(`\n    ${wrong.join('\n    ')}`);
    pass(`${contract.length} route/audience pairs`);
  },

  'every signed-in user may connect: payouts:connect came with the first install': async ({ pass, fail }) => {
    const { status, data } = await call(state.server.base, 'GET', '/payouts/api/my/account', { token: state.tokens.guest });
    if(status !== 200 || data.account !== null) return fail(`a member with no account: ${status} ${JSON.stringify(data)}`);
    if(data.countries.map(country => country.code).join() !== 'CA,GB,US') return fail(`offered ${data.countries.map(country => country.code).join()}`);
    pass('offered Canada, the UK and the US — not Brazil, not a country that cannot take USD');
  },

  'the nav links to the screen, under Payments': async ({ pass, fail }) => {
    const page = await newPage('admin');
    await page.goto(`${state.server.base}/admin/`);
    const link = page.locator('k-aside-item[href="/admin/extension/kempo-payouts/"]');
    if(!await link.count()) return fail('no Payouts entry in the admin nav');
    if(await link.getAttribute('group') !== 'Payments') return fail('the link is not in the Payments group');
    await page.context().close();
    pass('');
  },

  'a member chooses a country, is told what it means, and is stopped with a sentence when Stripe is not connected': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('guest');
    await page.goto(`${state.server.base}/payouts/`);
    const getPaid = page.locator('k-payouts-get-paid');
    await getPaid.getByText('Get paid by other people on this site').waitFor();
    await getPaid.getByText('This site keeps 5% of each payment').waitFor();
    await shot(page, 'get-paid-new');

    await getPaid.getByLabel('Where you live').selectOption('CA');
    await getPaid.getByText('What this means in Canada').waitFor();
    await getPaid.getByText('converts it into CAD').waitFor();
    await shot(page, 'get-paid-country');

    await getPaid.getByRole('button', { name: 'Set up payouts with Stripe' }).click();
    await getPaid.getByRole('alert').getByText('Stripe is not connected').waitFor();
    await shot(page, 'get-paid-no-stripe');
    await page.context().close();

    const errors = clean(start);
    if(errors) return fail(errors);
    pass('');
  },

  'a recipient sees they can be paid and their payments, and cannot refund one': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('dj');
    await page.goto(`${state.server.base}/payouts/`);
    const getPaid = page.locator('k-payouts-get-paid');
    await getPaid.getByText('Ready to be paid').waitFor();
    await getPaid.getByRole('button', { name: 'Open your Stripe dashboard' }).waitFor();
    await getPaid.locator('td', { hasText: '$25.00' }).waitFor();
    await getPaid.getByText('Paid · disputed').waitFor();
    if(await getPaid.getByRole('button', { name: /refund/i }).count()) return fail('a recipient has a refund button');
    await shot(page, 'get-paid-ready');
    await page.context().close();

    const errors = clean(start);
    if(errors) return fail(errors);
    pass('');
  },

  'an administrator finds the account and its payments': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('manager');
    await page.goto(`${state.server.base}/admin/extension/kempo-payouts/`);
    const accounts = page.locator('k-payouts-accounts');
    await accounts.getByText('Fees collected').waitFor();
    await accounts.getByText('$1.50').first().waitFor();
    await shot(page, 'admin-accounts');

    await accounts.getByRole('link', { name: 'DJ Recipient' }).click();
    await page.waitForURL(/\/account\/\?id=/);
    const account = page.locator('k-payouts-account');
    await account.getByText('Ready to be paid').waitFor();
    await account.getByText('This site — Stripe bills the site').waitFor();
    await shot(page, 'admin-account');

    await page.goBack();
    await page.locator('k-payouts-accounts').getByRole('link', { name: 'DJ Recipient' }).waitFor();
    await page.context().close();

    const errors = clean(start);
    if(errors) return fail(errors);
    pass('');
  },

  'an administrator opens a payment and sees the refund form, a viewer does not': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('manager');
    await page.goto(`${state.server.base}/admin/extension/kempo-payouts/?tab=charges`);
    const charges = page.locator('k-payouts-charges');
    await charges.locator('td', { hasText: '$25.00' }).first().click();
    await page.waitForURL(/\/charge\/\?id=/);
    const charge = page.locator('k-payouts-charge');
    await charge.getByText('$25.00 to DJ Recipient').waitFor();
    await charge.getByText('Give back the site’s fee too').waitFor();
    await shot(page, 'admin-charge');

    await charge.getByLabel(/^Amount/).fill('5.00');
    await charge.getByRole('button', { name: 'Refund' }).click();
    await charge.getByRole('alert').getByText('Stripe is not connected').waitFor();
    await page.context().close();

    const viewer = await newPage('viewer');
    await viewer.goto(`${state.server.base}/admin/extension/kempo-payouts/charge/?id=${state.charge.id}`);
    await viewer.locator('k-payouts-charge').getByText('$25.00 to DJ Recipient').waitFor();
    if(await viewer.locator('k-payouts-charge').getByRole('button', { name: 'Refund' }).count()) return fail('a viewer has the refund form');
    await viewer.context().close();

    const errors = clean(start);
    if(errors) return fail(errors);
    pass('');
  },

  'an administrator sets the fee, the cap and the countries': async ({ pass, fail }) => {
    const start = state.errors.length;
    const page = await newPage('manager');
    await page.goto(`${state.server.base}/admin/extension/kempo-payouts/?tab=settings`);
    const settings = page.locator('k-payouts-settings');
    await settings.getByText('Connect webhook').waitFor();
    if(!(await settings.getByLabel(/^Endpoint URL/).inputValue()).endsWith('/payouts/api/webhooks/stripe')) return fail('the endpoint URL is not shown');

    await settings.getByLabel(/^Fee/).fill('2.5');
    await settings.getByLabel(/^Most per recipient/).fill('50.00');
    await settings.getByLabel('Only the countries selected below').check();
    await settings.getByLabel('United States').check();
    await shot(page, 'admin-settings');
    await settings.getByRole('button', { name: 'Save' }).click();
    await settings.getByRole('status').getByText('Saved.').waitFor();
    await page.context().close();

    const saved = Object.fromEntries((await db.select().from(setting)).filter(row => row.name.startsWith('kempo-payouts:')).map(row => [row.name.split(':')[1], row.value]));
    if(saved.fee_percent !== '2.5' || saved.fee_cap !== '5000' || saved.allowed_countries !== 'US') return fail(`stored ${JSON.stringify(saved)}`);

    const { data } = await call(state.server.base, 'GET', '/payouts/api/my/account', { token: state.tokens.guest });
    if(data.countries.map(country => country.code).join() !== 'US') return fail(`after narrowing, a member is offered ${data.countries.map(country => country.code).join()}`);

    const refused = await call(state.server.base, 'PUT', '/payouts/api/settings', { token: state.tokens.manager, body: { allowed_countries: 'US,ZZ' } });
    if(refused.status !== 400) return fail(`a country Stripe does not list was saved: ${refused.status}`);

    const errors = clean(start);
    if(errors) return fail(errors);
    pass(`fee 2.5%, cap 50.00, US only; ${COUNTRIES.length} countries on Stripe’s list`);
  },

  'the browser is closed and the suite’s own processes stopped': async ({ pass }) => {
    await state.browser?.close();
    stopServer(state.server);
    await purgeSite({ users: USERS, extensions: EXTENSIONS });
    await purge();
    pass(`screenshots in ${screensDir}`);
  },
};

/*
  A case that throws — a locator that timed out, usually — leaves a screenshot of where it got to,
  named after the case, and its page is closed so the next case starts clean.
*/
const guarded = Object.fromEntries(Object.entries(tests).map(([name, run], index) => [name, async helpers => {
  try {
    return await run(helpers);
  } catch(error) {
    if(state.page && !state.page.isClosed()){
      await shot(state.page, `failed-${index + 1}`).catch(() => {});
      await state.page.context().close().catch(() => {});
    }
    return helpers.fail(`${error.message.split('\n')[0]} — screenshot: failed-${index + 1}.png`);
  }
}]));

export default integrationTier ? guarded : integrationOnly('browser');
