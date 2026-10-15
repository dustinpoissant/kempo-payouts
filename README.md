# kempo-payouts

Lets users of a kempo site **receive money from other users** — a guest tipping a DJ, a donation to an
organiser — through [Stripe Connect](https://stripe.com/connect), with an optional fee for the site.

Each recipient has their **own Stripe account**. Payments to them are charged *on* that account (a
Connect *direct charge*), Stripe pays them out to their bank, and the site keeps only its fee. **The
site never holds the money**, so it is not a money transmitter: Stripe verifies each recipient's
identity, holds their balance, and pays them out.

It is a separate extension from [kempo-payments](https://github.com/dustinpoissant/kempo-payments)
because they are different jobs. kempo-payments moves money *into the site's own account*; this moves
it *to other people*, and has its own failure modes (onboarding, verification, negative balances) and
screens. Payments themselves are still kempo-payments' — there is one payment record, one set of
hooks, one refund path — and this extension adds *who was paid and for what*, and *what the site kept*.

> **Read [Who pays and who is liable](#who-pays-and-who-is-liable) before going live.** What Stripe
> allows changed under the original plan, and the setup chosen decides who pays card processing fees.

## Requirements

- kempo ≥ 4.5.8, kempo-server, kempo-ui
- **kempo-payments ≥ 0.2.0** (the version with connected-account support), installed and with a Stripe
  secret key saved. This extension uses that same key and never stores a copy of it.
- A Stripe account with **Connect enabled**.
- `SETTINGS_ENCRYPTION_KEY` set on the server, as for kempo-payments: the Connect webhook secret is an
  encrypted `secret` setting.

## Install

```bash
npm install kempo-payouts
```

Install **kempo-payments first**, then this, from `/admin/extensions` (this one refuses to install
without it). The first install gives the `payouts:connect` permission to every signed-in user, so
anybody can connect their own payout account at `/payouts/`.

Then, once:

1. In Stripe, **Developers → Webhooks → Add endpoint**, choose **events on connected accounts**, point it
   at `https://your-site/payouts/api/webhooks/stripe`, and send it the events listed on the Settings
   tab (account, payout, payment, refund and dispute events).
2. Paste that endpoint's **signing secret** (`whsec_…`) into **Payouts → Settings**. This is a
   *different* secret from kempo-payments'. Without it no recipient ever becomes ready to be paid.
3. On the same tab, **Fetch Stripe's list again** if the countries are empty.

## How it works

1. A user opens **`/payouts/`** ("Get paid"), chooses the country they live in, is told what that means
   for them (see [Countries](#countries)), and is sent to **Stripe's hosted onboarding**. Identity and
   bank details are entered at Stripe; this site never sees or stores them.
2. Stripe tells this site (the Connect webhook) when the account can take charges and send payouts.
   `canReceive` is true only when **both** are true.
3. The consuming code (Crowd Pulse's Tips feature) checks `canReceive`, then calls
   `createConnectedPayment`, and hands the returned `clientSecret` and `connectedAccount` to
   kempo-payments' `<k-pay-form connected-account="…">`.
4. The guest pays. Stripe takes the site's **application fee** and puts the rest in the recipient's
   Stripe balance. The `payouts:charge-succeeded` hook fires from the webhook, not from the browser.

## Server SDK

```js
import { canReceive, createConnectedPayment, feeFor, refundCharge } from 'kempo-payouts/sdk';

const [, ready] = await canReceive({ userId: event.hostId });   // before offering "Tip"

const [error, { charge, clientSecret, connectedAccount }] = await createConnectedPayment({
  recipientUserId: event.hostId,
  amount: 500,                                  // $5.00, minor units, in the site's currency
  reference: { owner: 'crowd-pulse', ref: event.id },   // what the fee cap counts against
  feeAmount: event.charity ? 0 : undefined,     // your own rule; undefined uses the site's policy
  idempotencyKey: form.id,                      // the same key again is the same payment
  payerUserId: guest?.id,
  description: `Tip at ${event.name}`,
});
```

| Function | Does |
|---|---|
| `getAccount({ userId })` | The user's payout account and its status, or `null` |
| `canReceive({ userId })` | `true` only when Stripe says charges **and** payouts are enabled. Becomes false the moment the account is disconnected |
| `createOnboardingLink({ userId, returnUrl, refreshUrl, country })` | Creates the Stripe account if there is none and returns Stripe's hosted onboarding address |
| `refreshAccount({ userId })` | Asks Stripe now and updates the account |
| `createDashboardLink({ userId })` | A link into the recipient's Stripe dashboard |
| `getBalance({ userId })` | Their balance at Stripe, live, with `negative: true` when it is below zero |
| `createConnectedPayment({ … })` | Charge **on** the recipient's account, through kempo-payments. Returns the charge, the payment, `clientSecret` and `connectedAccount` |
| `feeFor({ amount, recipientUserId, reference })` | The fee the site's policy would take, cap included — to show a payer before they pay |
| `refundCharge({ chargeId, amount?, reason?, refundApplicationFee?, issuedBy?, idempotencyKey })` | Refund, giving the site's fee back by default |
| `syncCharge({ chargeId })` | "Check with Stripe": the payment, the fee as Stripe has it, and any fee still owed back for the cap |
| `listCharges()`, `summary()` | Charges, and the fees collected per currency and per recipient |
| `availableCountries()`, `refreshCountries()` | The countries a recipient can choose, and a refetch of Stripe's list |

Every function returns `[error, data]` and none throws. They are data operations with no permission
checks — the HTTP routes decide who may do what. **There is no HTTP route that starts a payment**: the
amount would come from the request, and only the consumer's own server knows what a payment is for.

`createConnectedPayment` refuses, before Stripe is asked: a recipient who cannot receive; a recipient
in a country the site no longer offers; an amount that is not whole minor units; a `currency` other than
the site's; a fee that is not less than the payment; a missing reference or idempotency key.

### Hooks

Register handlers in your own `kempo-config.json` `hooks`.

| Hook | Data |
|---|---|
| `payouts:account-updated` | `{ account, previous, canReceive }` — connected, set up, restricted, disconnected |
| `payouts:charge-succeeded` | `{ charge, payment }` — the money is in the recipient's account |
| `payouts:charge-refunded` | `{ charge, payment, refund }` |
| `payouts:charge-disputed` | `{ charge, payment, disputed, reason }` — a chargeback opened (true) or closed |

They fire after the change is written and only when something actually changed, so a redelivered
webhook announces nothing twice.

## Fees

- **`fee_percent`** (default **5**): the site's cut of each payment, up to two decimals, rounded **down**
  to the smallest unit — the site never takes more than it advertises.
- **`fee_cap`** (default 0 = none): the most fee kept from **one recipient for one reference**, in the
  site's currency. Crowd Pulse's 5% up to $1,000 of tips per event is `fee_percent 5`, `fee_cap 5000`.
  The reference is `{ owner, ref }` on each charge; a different event, or a different recipient, starts
  from nothing.
- **An explicit `feeAmount`** overrides the percentage for one charge — the consumer's own rule (charity
  events pay no fee) without this extension knowing what a charity event is. It is not subject to the cap.
- **The cap is exact even when tips are paid at once.** A fee is fixed when a payment is created, from
  the tips already paid by then, so two tips started together near the cap both see the same room. When
  one succeeds and takes the total past the cap, the excess is given back to the recipient at Stripe
  (an application fee refund). Tested against real parallel connections and against Stripe.
- The fee and the cap are in the **site's currency**, which is also the charge currency, so the cap is
  one number whatever country a recipient is in. Stripe converts the tip into the recipient's currency
  and the fee into the platform's.
- Three-decimal currencies (KWD, BHD…) take fees in whole hundredths, as Stripe requires of amounts.

## Refunds, disputes and negative balances

- **Who may refund:** administrators with `payouts:refund`, and calling code through `refundCharge`.
  **A recipient has no refund button** — their Get paid page shows charges and refunds read-only.
- **Refunding a tip gives the site's fee back too**, in proportion (all of it on a full refund), by
  default. `refundApplicationFee: false` keeps it, and then the recipient's account pays the whole
  refund. Stripe's own default is the opposite, so one or the other is always sent explicitly.
- A refund carries an idempotency key, so a double-submitted form refunds once.
- **A dispute** on a charge is debited from the recipient's own Stripe balance first. The charge shows
  *disputed* to the recipient and to administrators, and `payouts:charge-disputed` fires. If it takes the
  balance below zero, Stripe takes it from the recipient's next payments and holds their payouts until
  it is back above zero; the Get paid page and the account screen both say so. **Who carries what is
  left if the recipient cannot repay it depends on how accounts are set up — see below.**
- **A recipient who disconnects** (`account.application.deauthorized`) cannot receive from that moment.
  Their charges, refunds and fees are kept.
- **A failed payout** to the recipient's bank is shown to them and to administrators until the next
  payout is paid. The money stays in their Stripe balance.

## Who pays and who is liable

Stripe fixes three things when an account is created, and they cannot be changed afterwards: which
dashboard the recipient gets, **who pays Stripe's fees** on a direct charge, and **who is liable** when
the account's balance goes negative. This was checked against Stripe's documentation and, because the
documentation did not match what the API did, against Stripe's test mode on 2026-10-15.

Stripe no longer creates legacy `type: express` accounts: account creation is Accounts v2
(`POST /v2/core/accounts`), and the Express Dashboard is only allowed when the platform collects fees and
carries losses ("When `stripe_dashboard[type]=express`, your platform must collect fees and be liable for
negative balances or refunds and chargebacks"). So there are two real setups, chosen by `ACCOUNT_SETUP`
in `server/providers/stripe.js`:

| | **Express Dashboard** (`express`, as decided) | **Full Stripe Dashboard** (`full`) |
|---|---|---|
| Recipient's experience | Stripe-hosted onboarding, Express Dashboard via a one-time login link | Stripe-hosted onboarding, then their own Stripe login |
| Card processing fee on a tip | **The site** — billed to the platform; the recipient receives amount − fee | The recipient |
| Dispute fee | **The site** | The recipient |
| Connect fees | **The site**: $2 per monthly active account + 0.25% + 25¢ per payout | None |
| 1099-K filing (US) | **The site** files, and pays $2.99 per form e-filed with the IRS, $1.49 per state form | Stripe |
| Negative balance a recipient cannot repay | **The site** | Stripe |

Test mode confirmed the first row: a $20.00 tip on an Express-Dashboard account with a $1.00 fee
produced Stripe fees on the recipient's charge of exactly the application fee (100) and a recipient net
of $19.00 — the card processing fee is billed to the platform separately.

**What this means for the numbers.** With the Express Dashboard the plan's premise — "the recipient
bears the processing fee, the site keeps only its cut, which is what makes 5% on $1 viable" — does not
hold: at 5% of a $1 tip the site receives 5¢ and Stripe bills it about 33¢ (2.9% + 30¢). To make that
work the fee must cover Stripe's processing fee as well, or the setup must be `full`. **The build keeps
`express`, as decided, and recommends `full`; see PLAN.md's findings.** The recipient's own Stripe
processing fee on the full-dashboard setup is the 2.9% + 30¢ the plan expected.

Stripe also says "We don't recommend using direct charges with this legacy setting" for accounts made
the old Express way, and recommends direct charges "for connected accounts that have access to the full
Stripe Dashboard".

## Tax

- **The tip** is not a taxable sale; it passes between users and never becomes site revenue.
- **The fee** is the site's revenue. Whether a platform fee charged to a business is taxable is a
  state-by-state question for the owner; this extension does not call kempo-tax for it.
- **1099-K forms** (US recipients over $20,000 and 200 transactions in a year) are issued by Stripe only
  when Stripe collects the fees (`full` above). On the Express Dashboard setup **the site is responsible
  for filing**.

## Countries

The list of countries a recipient can choose is **Stripe's, fetched and cached — never typed in here**:

1. **Stripe's country specs** give each country and the currencies an account there can be charged in.
   A country is offered only if the **site's currency** is among them.
2. **Brazil** is left off unless the site's own Stripe account is in Brazil: Stripe "can't collect
   application fees" for a platform outside Brazil.
3. **Stripe's refusal is the last word.** Some countries are on the specs list but Stripe will not
   create an account there for a US platform (India: "Connected accounts in IN cannot be created by
   platforms in US") or will create it and then refuse onboarding (Malaysia: "Connect Onboarding does
   not yet support"). Both are turned into *"Stripe does not support payouts to India yet"*, the
   country is recorded as refused and not offered again until an administrator presses **Try again**,
   and an account made for nobody to finish is deleted.
4. **`allowed_countries`** can only narrow what is left (empty = all of it). A code Stripe does not list
   is refused on save.

On a US platform with USD, test mode listed **59 countries** as offered, and accounts were opened in
the US, GB, CA, AU, DE, FR, JP, MX, SG, AE, TH, NZ, IE, HK and CH; India and Malaysia were refused as
above. Your list depends on your Stripe account's country and your site's currency.

**What it means for a recipient**, shown before they start: people pay in the site's currency; Stripe
converts it into the recipient's currency and charges a conversion fee that comes out of what they
receive; Stripe pays out on its own schedule for their country; Stripe will ask for identity and bank
details. A country cannot be changed once the account exists.

Instant payouts are **not offered** here: Stripe's payout schedule applies, and a recipient who wants
an instant payout asks in their Stripe dashboard and pays Stripe's fee themselves.

## Admin

Under **Commerce → Payouts**:

- **Accounts** — fees collected (per currency), accounts by state, and every connected account with its
  status, country and Stripe id. An account's page shows what Stripe still needs, its balance (live),
  failed payouts, who pays Stripe's fees on it and who is liable, and the charges made to it.
- **Payments** — every payment to a user, filterable by status and by reference. A payment's page shows
  who paid whom, the fee kept, refunds, and — with `payouts:refund` — the refund form.
- **Settings** — the fee, the cap, the countries, and the Connect webhook endpoint, its events and secret.

## Permissions

| Permission | Allows |
|---|---|
| `payouts:connect` | Connect your own payout account, see your charges and balance, open your Stripe dashboard. **Given to every signed-in user on a site's first install only**; an update or reinstall never gives it back to a site that took it away |
| `payouts:view` | See every account, charge and the fees collected |
| `payouts:refund` | Refund a charge |
| `payouts:settings` | Change the fee, cap, countries and webhook secret |

Groups: **`kempo-payouts:viewer`** (`payouts:view`) and **`kempo-payouts:administrator`** (view,
refund, settings).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `fee_percent` | 5 | The site's fee, a percentage under 100 with up to two decimals |
| `fee_cap` | 0 | Most fee per recipient per reference, in the smallest unit; 0 = none |
| `allowed_countries` | empty | Comma-separated country codes; empty = every country Stripe supports |
| `connect_webhook_secret` | — | The Connect endpoint's `whsec_…`; encrypted at rest, never shown |

## Data

Three tables: `kempoPayoutAccount` (user, Stripe account, status, capabilities, how it was set up),
`kempoPayoutCharge` (payment, recipient, reference, amount, fee, fee refunded, status) and
`kempoPayoutCountry` (Stripe's list, cached). Unique indexes — one account per user and per Stripe
account, one charge per payment and per idempotency key — are created by `install.js`, since kempo's
installer makes columns and primary keys only.

## Not in scope

- **Custody.** The site never holds recipient funds: no wallet, no internal "withdraw".
- **Other processors.** Stripe Connect only, behind the same provider seam as kempo-payments.
- **Tips → credits.** An open design problem (see PLAN.md); nothing here depends on it.
- **Tax calculation**, and the recipient's tax forms beyond the note above.
- **Manual payouts or scheduling** beyond what Stripe offers.

## Proving it against Stripe

`npm test` never calls Stripe. The parts that only mean something at Stripe are proved in **test
mode** by `scripts/connect-test-mode.js`, which builds a throwaway kempo site with both extensions,
connects it to Stripe, forwards Stripe's webhooks with the Stripe CLI, and checks every figure against
Stripe itself:

```bash
docker compose up -d
STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_PUBLISHABLE_KEY=pk_test_… node scripts/connect-test-mode.js start
# sign in as the recipient it prints, open /payouts/, choose United States, finish Stripe's onboarding
node scripts/connect-test-mode.js charges
node scripts/connect-test-mode.js countries GB,CA,IN,MY
node scripts/connect-test-mode.js stop
```

With no one to complete Stripe's hosted onboarding, `STRIPE_TEST_CONNECTED_ACCOUNT=acct_…` adopts a
connected account the platform already has, and touches it at Stripe so that the **webhook** makes it
payable. Anything but test keys is refused. Last run, 2026-10-15, on an Express-Dashboard sample account:

| Checked | Result |
|---|---|
| `account.updated` webhook flips `canReceive` to true | ✅ |
| A tip paid with a test card is marked paid from the webhook | ✅ |
| Stripe took the site's fee as the application fee (100 at Stripe, 100 here) | ✅ |
| Refund with the fee returns it in proportion (50 at Stripe, 50 here) | ✅ |
| `refundApplicationFee: false` keeps it | ✅ |
| Cap across tips paid one after another (100, 50, 0) | ✅ |
| Two tips paid together: excess fee given back at Stripe | ✅ |
| A fee of 0 takes no application fee at Stripe | ✅ |
| Same idempotency key twice is one payment | ✅ |
| A dispute (Stripe's dispute test card) reaches the charge from the webhook | ✅ |
| Express login link for the recipient | ⚠️ not covered: the sample account never completed hosted onboarding, so Stripe will not make a link. Onboard a recipient through `/payouts/` |
| A person completing Stripe's hosted onboarding in a browser | ⚠️ not run — needs a person; the account, link and webhook paths around it are covered above |

## Development

```bash
npm install
npm run link:local        # copies the sibling kempo-payments checkout into node_modules
docker compose up -d      # test database on port 5451
DATABASE_URL=postgresql://kempo:kempo@localhost:5451/kempo_payouts_test npx drizzle-kit push --force
npm test                  # unit tier: in-memory Postgres, nothing external
npm run test:integration  # real Postgres + a Chromium browser suite on a throwaway site
```

`link:local` copies rather than symlinks: a symlinked package resolves its own copy of kempo and
drizzle, and with it a second database. Never commit a `file:` specifier.

## License

MIT
