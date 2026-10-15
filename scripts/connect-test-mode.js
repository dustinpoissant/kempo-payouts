import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/*
  The manual procedure for kempo-payouts against Stripe's **test mode** — the Definition of Done that
  `npm test` cannot reach, because `npm test` never talks to Stripe.

  It builds a throwaway kempo site with kempo-payments and this extension installed through kempo's
  own route, on its own database, connects it to Stripe test mode, and forwards Stripe's webhooks to
  it with the Stripe CLI. Then a person (or an agent driving a browser) onboards a recipient through
  Stripe's hosted pages, and the rest is checked against Stripe itself.

  Needs: Docker's kempo-payouts-test-db (docker compose up -d), the Stripe CLI, and test keys:

    STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_PUBLISHABLE_KEY=pk_test_… node scripts/connect-test-mode.js <phase>

  Phases:

    start      Builds the site in tests/.tmp-procedure, starts it (detached — it keeps running), starts
               `stripe listen` forwarding to it, and prints the address and the recipient's sign-in.
               Then: sign in as the recipient, open /payouts/, choose United States, and complete
               Stripe's onboarding with its test values (test phone number, code 000000, SSN 0000,
               "Use test account" for the bank).
    charges    Waits for the webhook to make the recipient payable, then charges tips with the fee,
               refunds with and without the fee, holds the fee to the cap across tips (including two
               paid at once), and takes a payment with Stripe's dispute test card. Checks every
               figure against Stripe.
    countries  Tries to open an account in a list of countries and reports which Stripe refuses.
    stop       Stops the `stripe listen` it started. The site's server is left for whoever started it
               to stop (its process id is printed).

  Anything that is not a test key is refused before a single call is made. Every Stripe object it
  makes is a test-mode object.
*/

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'tests', '.tmp-procedure');
const stateFile = path.join(dir, 'state.json');
const phase = process.argv[2];

const secretKey = process.env.STRIPE_TEST_SECRET_KEY || '';
const publishableKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY || '';
if(!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')){
  console.error('Set STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PUBLISHABLE_KEY to test-mode keys. Live keys are refused.');
  process.exit(2);
}
if(!['start', 'charges', 'countries', 'stop'].includes(phase)){
  console.error('Usage: node scripts/connect-test-mode.js <start|charges|countries|stop>');
  process.exit(2);
}

const DATABASE = 'kempo_payouts_procedure_test';
const DATABASE_URL = `postgresql://kempo:kempo@localhost:5451/${DATABASE}`;
const RECIPIENT = { name: 'Test DJ', email: 'test-dj@payouts-procedure.test', password: 'TestDj12345!' };
const ADMIN = { name: 'Procedure Admin', email: 'admin@payouts-procedure.test', password: 'Admin12345!' };

const readState = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
const writeState = state => writeFileSync(stateFile, JSON.stringify(state, null, 2));

/*
  Every kempo module this process loads reads its database and encryption key on first import, so
  both are set here, before anything imports one: the procedure's own database, and the key the
  site's server was started with (a new one only when there is no site yet).
*/
const saved = readState();
process.env.DATABASE_URL = DATABASE_URL;
process.env.SETTINGS_ENCRYPTION_KEY = saved?.encryptionKey || crypto.randomBytes(32).toString('hex');
delete process.env.KEMPO_DB;

const answers = async base => {
  try {
    await fetch(`${base}/login`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
};

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const finish = () => {
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed} of ${results.length} passed`);
  process.exit(failed ? 1 : 0);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/*
  The kempo modules, loaded against the procedure's own database with the site's encryption key, so
  this process reads and writes exactly what the site's server does.
*/
const connect = async state => {
  process.chdir(state.dir);
  const { default: Stripe } = await import('stripe');
  return {
    stripe: new Stripe(secretKey),
    kempo: await import('kempo/server/sdk.js'),
    payouts: await import('../sdk.js'),
    payments: await import('kempo-payments/sdk'),
  };
};

/*
  A site that is already running is used as it is — one throwaway server, never a second. Only when
  there is none is a database made and a site built and started.
*/
const startPhase = async () => {
  const { buildSite, startServer, login, call } = await import('../tests/helpers/site.js');
  const reuse = !!saved?.base && await answers(saved.base);
  const state = reuse ? saved : { dir, encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY, startedAt: new Date().toISOString() };

  if(reuse){
    console.log(`Using the site already running at ${state.base} (process ${state.serverPid}).`);
  } else {
    execFileSync('docker', ['exec', 'kempo-payouts-test-db', 'psql', '-U', 'kempo', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`], { stdio: 'ignore' });
    execFileSync('docker', ['exec', 'kempo-payouts-test-db', 'psql', '-U', 'kempo', '-d', 'postgres', '-c', `CREATE DATABASE ${DATABASE}`], { stdio: 'ignore' });
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], { cwd: root, env: { ...process.env, DATABASE_URL }, stdio: 'ignore', shell: true });
    await buildSite({ own: 'kempo-payouts', others: ['kempo-payments'], dir });
  }
  writeState(state);

  const { kempo } = await connect(state);
  const { default: seedDatabase } = await import('kempo/server/utils/setup/seedDatabase.js');
  await seedDatabase({ log: () => {} });
  for(const person of [ADMIN, RECIPIENT]){
    const [, existing] = await kempo.getUserByEmail(person.email);
    const [error, created] = existing ? [null, { user: existing }] : await kempo.createUser({ ...person, emailVerified: true });
    if(error) throw new Error(`could not create ${person.email}: ${error.msg}`);
    if(person === ADMIN) await kempo.addUserToGroup(created.user.id, 'system:Administrators');
    if(person === RECIPIENT) state.recipientId = created.user.id;
  }

  if(!reuse){
    const server = await startServer({ dir, detached: true, log: path.join(dir, 'server.log'), env: { DATABASE_URL, SETTINGS_ENCRYPTION_KEY: state.encryptionKey } });
    state.base = server.base;
    state.serverPid = server.child.pid;
  }
  writeState(state);

  const token = await login(state.base, ADMIN);
  if(!token) throw new Error('the administrator could not sign in to the site');
  for(const name of ['kempo-payments', 'kempo-payouts']){
    const installed = await call(state.base, 'POST', '/kempo/api/extensions', { token, body: { name } });
    if(installed.status !== 200 && installed.status !== 409) throw new Error(`installing ${name}: ${installed.status} ${JSON.stringify(installed.data)}`);
  }

  const webhookSecret = execFileSync('stripe', ['listen', '--api-key', secretKey, '--print-secret'], { encoding: 'utf8' }).trim();
  await kempo.setSetting('kempo-payments', 'stripe_secret_key', secretKey, 'secret', false, 'test-mode procedure');
  await kempo.setSetting('kempo-payments', 'stripe_publishable_key', publishableKey, 'string', false, 'test-mode procedure');
  await kempo.setSetting('kempo-payments', 'stripe_webhook_secret', webhookSecret, 'secret', false, 'test-mode procedure');
  await kempo.setSetting('kempo-payouts', 'connect_webhook_secret', webhookSecret, 'secret', false, 'test-mode procedure');

  const listener = spawn('stripe', ['listen', '--api-key', secretKey,
    '--forward-to', `${state.base}/payments/api/webhooks/stripe`,
    '--forward-connect-to', `${state.base}/payouts/api/webhooks/stripe`,
  ], { detached: true, stdio: ['ignore', openSync(path.join(dir, 'stripe-listen.log'), 'a'), openSync(path.join(dir, 'stripe-listen.log'), 'a')] });
  listener.unref();
  state.listenerPid = listener.pid;
  writeState(state);

  const { payouts } = await connect(state);
  const [countryError, countries] = await payouts.refreshCountries();
  console.log(countryError ? `Could not fetch Stripe's countries: ${countryError.msg}` : `Stripe's country list: ${countries.count} countries; the platform is in ${countries.platformCountry}.`);

  console.log(`\nThe site: ${state.base} (process ${state.serverPid}, left running)`);
  console.log(`Sign in as ${RECIPIENT.email} / ${RECIPIENT.password}, open ${state.base}/payouts/, choose United States and finish Stripe's onboarding.`);
  console.log(`Then: node scripts/connect-test-mode.js charges`);
  process.exit(0);
};

/*
  A tip: a payment to the recipient made through the SDK, then paid with one of Stripe's test cards
  on the recipient's account — what a guest's browser does through <k-pay-form>.
*/
const tip = async (env, { amount, ref, feeAmount, key = crypto.randomUUID() }) => {
  const [error, created] = await env.payouts.createConnectedPayment({ recipientUserId: env.state.recipientId, amount, reference: { owner: 'procedure', ref }, feeAmount, idempotencyKey: key, description: `Test tip ${ref}` });
  if(error) throw new Error(`creating a tip: ${error.msg}`);
  return created;
};

const pay = (env, created, card = 'pm_card_visa') => env.stripe.paymentIntents.confirm(created.payment.providerRef, { payment_method: card, return_url: 'https://example.com/return' }, { stripeAccount: created.connectedAccount });

const settle = async (env, chargeId, test, tries = 30) => {
  for(let attempt = 0; attempt < tries; attempt++){
    const [, charge] = await env.payouts.getCharge(chargeId);
    if(charge && test(charge)) return charge;
    await wait(1000);
  }
  const [, charge] = await env.payouts.getCharge(chargeId);
  return charge;
};

const feeAtStripe = async (env, created) => {
  const intent = await env.stripe.paymentIntents.retrieve(created.payment.providerRef, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: created.connectedAccount });
  const feeId = typeof intent.latest_charge?.application_fee === 'string' ? intent.latest_charge.application_fee : intent.latest_charge?.application_fee?.id;
  const fee = feeId ? await env.stripe.applicationFees.retrieve(feeId) : null;
  return { fee, charge: intent.latest_charge };
};

const chargesPhase = async () => {
  const state = readState();
  if(!state?.base) throw new Error('Run the start phase first.');
  const env = { state, ...await connect(state) };

  /*
    Without a person to complete Stripe's hosted onboarding, STRIPE_TEST_CONNECTED_ACCOUNT=acct_… adopts
    a connected account the platform already has that can take charges: the recipient is recorded as
    connected to it, as "pending", and the account is touched at Stripe so that the account.updated
    webhook — not a sync — is what makes it payable. Everything after that is identical.
  */
  const adopt = process.env.STRIPE_TEST_CONNECTED_ACCOUNT;
  const [, existing] = await env.payouts.getAccount({ userId: state.recipientId });
  if(adopt && !existing){
    const { reserveAccount, updateAccount } = await import('../server/utils/accounts/store.js');
    const [reserveError, reserved] = await reserveAccount({ userId: state.recipientId, provider: 'stripe', country: 'US' });
    if(reserveError) throw new Error(reserveError.msg);
    const [updateError] = await updateAccount(reserved.id, { providerAccountId: adopt, status: 'pending', livemode: false });
    if(updateError) throw new Error(updateError.msg);
    await env.stripe.accounts.update(adopt, { metadata: { kempoPayoutsProcedure: new Date().toISOString() } });
    console.log(`Adopted ${adopt}; touched it at Stripe so its account.updated webhook arrives.`);
  }

  // 1. Onboarding finished, and the webhook — not a sync — made the recipient payable.
  let account = null;
  for(let attempt = 0; attempt < 60; attempt++){
    [, account] = await env.payouts.getAccount({ userId: state.recipientId });
    if(account?.canReceive) break;
    if(attempt === 0) console.log('Waiting for Stripe to say the recipient can be paid (finish onboarding in the browser)…');
    await wait(5000);
  }
  check('the webhook made the recipient payable (canReceive)', !!account?.canReceive, account ? `${account.status}, synced ${account.syncedAt}` : 'no account');
  if(!account?.canReceive) return finish();
  check('the account was set up as ACCOUNT_SETUP says', !!account.dashboard && !!account.feesCollector, `${account.dashboard} dashboard, fees collected by ${account.feesCollector}, losses carried by ${account.lossesCollector}`);
  const [linkError, link] = await env.payouts.createDashboardLink({ userId: state.recipientId });
  if(/not completed onboarding/i.test(linkError?.msg || '')){
    // An adopted account that never went through Stripe's hosted onboarding: Stripe will not make its login link. Not a pass, not a failure.
    console.log('SKIP  the recipient gets a link into their Stripe dashboard — this account never completed hosted onboarding, so Stripe will not make a login link for it; onboard a recipient through /payouts/ to cover it');
  } else {
    check('the recipient gets a link into their Stripe dashboard', !linkError && /^https:\/\//.test(link?.url || ''), linkError?.msg || link.url.replace(/\/[^/]*$/, '/…'));
  }

  // 2. A $20.00 tip at 5%: the site's fee is $1.00, on Stripe as well as here.
  await env.kempo.setSetting('kempo-payouts', 'fee_percent', 5, 'number', false, null);
  await env.kempo.setSetting('kempo-payouts', 'fee_cap', 0, 'number', false, null);
  const first = await tip(env, { amount: 2000, ref: `tip-${Date.now()}` });
  await pay(env, first);
  const paid = await settle(env, first.charge.id, charge => charge.status === 'succeeded');
  check('a tip paid with a test card is marked paid from the webhook', paid?.status === 'succeeded', paid?.status);
  const atStripe = await feeAtStripe(env, first);
  check('Stripe took the site’s fee as the application fee', atStripe.fee?.amount === 100 && paid.feeAmount === 100, `fee ${atStripe.fee?.amount} at Stripe, ${paid?.feeAmount} here`);
  const processing = atStripe.charge?.balance_transaction;
  console.log(`      on the recipient's account: charge ${atStripe.charge?.amount}, Stripe's fees ${processing?.fee ?? '?'} (${(processing?.fee_details || []).map(detail => `${detail.type} ${detail.amount}`).join(', ')}), net ${processing?.net ?? '?'}`);

  // 3. Refund part with the fee (the default), then part without it.
  const [refundError] = await env.payouts.refundCharge({ chargeId: first.charge.id, amount: 1000, reason: 'procedure: with fee', idempotencyKey: crypto.randomUUID() });
  const afterFee = await settle(env, first.charge.id, charge => charge.amountRefunded === 1000);
  const feeNow = (await feeAtStripe(env, first)).fee;
  check('a refund gives the fee back in proportion by default', !refundError && feeNow?.amount_refunded === 50 && afterFee.feeRefunded === 50, refundError?.msg || `fee refunded ${feeNow?.amount_refunded} at Stripe, ${afterFee?.feeRefunded} here`);
  const [keepError] = await env.payouts.refundCharge({ chargeId: first.charge.id, amount: 500, refundApplicationFee: false, idempotencyKey: crypto.randomUUID() });
  const afterKeep = await settle(env, first.charge.id, charge => charge.amountRefunded === 1500);
  const feeKept = (await feeAtStripe(env, first)).fee;
  check('refundApplicationFee: false keeps the fee', !keepError && feeKept?.amount_refunded === 50 && afterKeep.feeRefunded === 50, keepError?.msg || `fee refunded ${feeKept?.amount_refunded} at Stripe, ${afterKeep?.feeRefunded} here`);

  // 4. The cap: 5% up to $1.50 for one reference. In turn: $1.00, then $0.50, then nothing.
  await env.kempo.setSetting('kempo-payouts', 'fee_cap', 150, 'number', false, null);
  const event = `event-${Date.now()}`;
  const fees = [];
  for(let index = 0; index < 3; index++){
    const created = await tip(env, { amount: 2000, ref: event });
    fees.push(created.charge.feeAmount);
    await pay(env, created);
    await settle(env, created.charge.id, charge => charge.status === 'succeeded');
  }
  check('the cap holds across tips paid one after another', fees.join() === '100,50,0', `fees ${fees.join(', ')}`);

  // Two tips started together before either is paid both see the whole cap; the second paid gives its excess back at Stripe.
  const together = `event-${Date.now()}-together`;
  const raced = [await tip(env, { amount: 2000, ref: together }), await tip(env, { amount: 2000, ref: together })];
  await pay(env, raced[0]);
  await settle(env, raced[0].charge.id, charge => charge.status === 'succeeded');
  await pay(env, raced[1]);
  const corrected = await settle(env, raced[1].charge.id, charge => charge.status === 'succeeded' && charge.feeRefunded === 50);
  const racedFee = (await feeAtStripe(env, raced[1])).fee;
  check('two tips paid together keep the site within the cap — the excess fee goes back at Stripe', corrected?.feeRefunded === 50 && corrected.feeCapPending === 0 && racedFee?.amount_refunded === 50, `fees ${raced.map(entry => entry.charge.feeAmount).join(' + ')}, given back ${racedFee?.amount_refunded} at Stripe`);
  await env.kempo.setSetting('kempo-payouts', 'fee_cap', 0, 'number', false, null);

  // 5. A charity event: the calling code's own fee — none.
  const waived = await tip(env, { amount: 1000, ref: `charity-${Date.now()}`, feeAmount: 0 });
  await pay(env, waived);
  await settle(env, waived.charge.id, charge => charge.status === 'succeeded');
  check('a fee of 0 from the calling code takes no fee at Stripe', !(await feeAtStripe(env, waived)).fee);

  // 6. The same idempotency key twice is one payment.
  const key = crypto.randomUUID();
  const once = await tip(env, { amount: 700, ref: `retry-${Date.now()}`, key });
  const twice = await tip(env, { amount: 700, ref: `retry-${Date.now()}`, key });
  check('a retried request with the same key is the same payment', once.payment.id === twice.payment.id && twice.resumed === true);

  // 7. A dispute: Stripe's test card that is always disputed as fraudulent.
  const disputed = await tip(env, { amount: 1500, ref: `dispute-${Date.now()}` });
  await pay(env, disputed, 'pm_card_createDispute');
  const flagged = await settle(env, disputed.charge.id, charge => charge.disputed, 60);
  check('a dispute on the recipient’s account reaches the charge from the webhook', !!flagged?.disputed, flagged ? `${flagged.status}, disputed ${flagged.disputed}` : 'no charge');
  const [balanceError, balance] = await env.payouts.getBalance({ userId: state.recipientId });
  console.log(`      the recipient's balance after the dispute: available ${balance?.available.map(entry => `${entry.amount} ${entry.currency}`).join(', ')}, pending ${balance?.pending.map(entry => `${entry.amount} ${entry.currency}`).join(', ')}${balance?.negative ? ' — NEGATIVE' : ''}${balanceError ? ` (${balanceError.msg})` : ''}`);

  const [, summary] = await env.payouts.summary();
  console.log(`      fees collected: ${summary.totals.map(total => `${total.fees} ${total.currency} from ${total.count} payments`).join('; ')}`);
  finish();
};

/*
  Which countries Stripe will open an account in for this platform, by trying: each attempt is a new
  test user asking for an onboarding link, exactly as the Get paid page does.
*/
const countriesPhase = async () => {
  const state = readState();
  if(!state?.base) throw new Error('Run the start phase first.');
  const env = { state, ...await connect(state) };
  const codes = (process.argv[3] || 'GB,CA,AU,DE,FR,JP,MX,SG,IN,AE,TH,MY,BR,NZ,IE').split(',');
  const [, offered] = await env.payouts.availableCountries();
  console.log(`Offered on the Get paid page: ${offered.countries.length} countries (site currency ${offered.currency.toUpperCase()}).`);
  console.log(`Not offered: ${offered.all.filter(country => !country.available).map(country => `${country.code} (${country.reason})`).join('; ') || 'none'}`);

  for(const code of codes){
    const [userError, created] = await env.kempo.createUser({ name: `Country ${code}`, email: `country-${code.toLowerCase()}-${Date.now()}@payouts-procedure.test`, password: 'Country12345!', emailVerified: true });
    if(userError){
      console.log(`${code}: could not make a test user (${userError.msg})`);
      continue;
    }
    const [error, link] = await env.payouts.createOnboardingLink({ userId: created.user.id, country: code, returnUrl: `${state.base}/payouts/`, refreshUrl: `${state.base}/payouts/` });
    console.log(`${code}: ${error ? `refused — ${error.msg}` : `account ${link.account.providerAccountId}, ${link.account.defaultCurrency?.toUpperCase()}, ${link.account.dashboard} dashboard`}`);
  }
  process.exit(0);
};

const stopPhase = () => {
  const state = readState();
  if(state?.listenerPid){
    try {
      process.kill(state.listenerPid);
      console.log(`Stopped stripe listen (${state.listenerPid}).`);
    } catch {
      console.log('stripe listen was not running.');
    }
  }
  if(state?.serverPid) console.log(`The site's server is process ${state.serverPid}, at ${state.base}. Stop it when you are done with it.`);
  process.exit(0);
};

try {
  if(phase === 'start') await startPhase();
  if(phase === 'charges') await chargesPhase();
  if(phase === 'countries') await countriesPhase();
  if(phase === 'stop') stopPhase();
} catch(error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
