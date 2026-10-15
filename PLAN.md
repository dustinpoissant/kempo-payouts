# kempo-payouts — PLAN

> Status: **built 2026-10-15, committed locally, not pushed or published.** Unit 61, integration 70,
> and the test-mode procedure (`scripts/connect-test-mode.js`) passed against Stripe. **Decision 1 needs
> the owner again — read "Findings while building" before anything else.** Not done: a person
> completing Stripe's hosted onboarding in a browser; installing into kempo-demo. See the README.

## Decisions made (owner, 2026-10-14)

These close questions the rest of this file raised. They are rules, not defaults.

1. **Account type: Express.** The platform carries chargebacks and negative balances on a recipient's
   account, as Stripe's current docs describe for Express with direct charges. **Confirm that
   against the current docs while building and write the real position in the README** — who is
   liable, for what, and what the site's exposure is on a lost dispute. If the docs show something
   different from what this file assumes, stop and write it up here; do not quietly switch type.
2. **Countries: any country Stripe supports for Express — and no others.** The list is **Stripe's,
   never typed in here**: take the countries from Stripe's country specs API, cache them, and
   check them against where Express accounts are actually available (country specs describes Stripe
   accounts in general, which may be wider than Connect Express — verify, and let Stripe's own
   refusal to create the account be the final word, turned into a plain message such as "Stripe
   does not support payouts to <country> yet"). A country Stripe does not support can never be
   selected or onboarded. The *setting* (`allowed_countries`) can only **narrow** that list, defaults
   to all of it, and an unknown value is rejected on save. Onboarding refuses an unsupported country
   before sending anyone to Stripe. Consequences, which the build must handle and test rather than
   assume away:
   - A recipient settles in **their own** currency. Charges are made in the **site's currency**
     (kempo-products' `currency` setting) and Stripe converts for the recipient, who bears
     conversion. Verify in Stripe's docs that a direct charge in a currency other than the connected
     account's default is allowed for the countries on the list, and drop (and document) any country
     where it is not.
   - **The fee and the per-reference cap are in the charge currency**, which is always the site's
     currency, so the cap is one number whatever the recipient's country.
   - The application fee is taken in the charge currency. Check that Stripe's own minimums and
     zero-decimal currencies are respected (kempo-payments' `money` rules apply).
   - Onboarding must show the recipient's country and what it means for them (currency conversion,
     payout timing) before they start.
3. **Refunds: administrators and calling code only.** An admin screen, and a refund function in the
   SDK for consumers (Crowd Pulse decides who may ask). A recipient has **no** refund button on
   their Get paid page. They can see their charges and refunds, read-only.
4. **Scope of the build: kempo-payments' Connect support first, then this, both committed locally
   and nothing pushed or published.** The owner reviews and releases, in order: kempo-payments
   (a minor), then kempo-payouts. See "Order of work".

### Defaults the build applies without asking (change them here if they are wrong)

- **Instant payouts are not offered by this extension.** Stripe's payout schedule applies. A
  recipient who wants an instant payout can request one in their Express dashboard and pays
  Stripe's fee themselves. Nothing in this extension charges or absorbs it.
- **Tips → credits is not built.** See the last section; nothing in v1 depends on it.
- **`payouts:connect` is held by `system:Users` from the first install only**, like other
  extensions' "buy" permissions: an update never gives it back to a site that took it away.
- **The Connect webhook secret** is a `secret` setting; the platform's Stripe key is
  kempo-payments' and is not duplicated here.
- **Stripe test mode has Connect enabled** on the owner's account (checked 2026-10-14: the Connect
  API answers). Test-mode procedures can use the demo's encrypted test keys the way earlier
  extensions' suites did — read through kempo's settings, never printed, refused unless they begin
  `sk_test_`.

## Findings while building (2026-10-15) — decision 1 needs the owner again

Decision 1 said to stop and write it up here if Stripe differs from what this file assumes. It does,
and the most important part was found by calling Stripe's **test mode**, not by reading the docs.
**Nothing was switched.** The build creates accounts with the Express Dashboard as decided, and the
choice lives in one place (`ACCOUNT_SETUPS` / `ACCOUNT_SETUP` in `server/providers/stripe.js`) with
the alternative below implemented and tested next to it, so changing it is one word.

### What Stripe actually does (test mode, 2026-10-15, on the owner's platform `acct_1U8s88…`, US)

1. **Legacy Express accounts cannot be created any more.** `POST /v1/accounts` with `type=express`
   (and every other v1 account creation) answers 400: "Stripe no longer recommends Accounts v1 for new
   Connect integrations. Create connected accounts with POST /v2/core/accounts instead." Accounts are
   created with **Accounts v2**; everything else (retrieve, onboarding links, Express login links,
   payment intents with `Stripe-Account`) still takes the v2 account's `acct_…` id on v1 endpoints, and
   v2 accounts still send v1 `account.updated` events to a Connect-scope webhook
   ([Accounts v2](https://docs.stripe.com/connect/accounts-v2)).
2. **The Express Dashboard forces the platform to pay Stripe's fees and carry the losses.** Asking for
   `stripe_dashboard=express` with the connected account paying fees answers 400: "When
   `stripe_dashboard[type]=express`, your platform must collect fees and be liable for negative
   balances or refunds and chargebacks." In v2 terms: `dashboard: 'express'` needs
   `fees_collector: 'application'` and `losses_collector: 'application'`.
3. **With `fees_collector: 'application'`, the site pays the card processing fee on every direct
   charge** — not the recipient. Stripe: "If you set the fee collector to application, you collect the
   payment and fees, then pay Stripe its processing fee. Set the application fee amount to include both
   your fee and the Stripe processing fee"
   ([connected account configuration](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration)).
   That is the exact thing "How a tip is charged" below exists to avoid: at 5% of a $1 tip the site
   receives 5¢ and Stripe bills it ~33¢. Dispute fees are the site's too
   ([fee behavior](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior)).
4. **The site pays Connect fees on Express:** $2 per monthly active account (a payout was sent that
   month) plus 0.25% + 25¢ per payout ([Connect pricing](https://stripe.com/connect/pricing)). When
   Stripe collects the fees there are no Connect fees.
5. **The site files the 1099s on Express, not Stripe.** "Stripe doesn't issue a 1099-K to your
   connected account … where controller.fees.payer equals application" — the platform files, at $2.99
   per IRS e-file and $1.49 per state ([tax reporting](https://docs.stripe.com/connect/tax-reporting)).
   "Concepts" and "Tax" below assumed Stripe issues them; that holds only when Stripe collects fees.

What this file assumed and Stripe confirms: on Express the **site is liable** when a recipient's
balance goes negative; Stripe first takes a dispute from the recipient's own balance.

### The two ways to set an account up

| | **Express Dashboard** (as decided) | **Full Stripe Dashboard** |
|---|---|---|
| v2 `dashboard` / `fees_collector` / `losses_collector` | `express` / `application` / `application` | `full` / `stripe` / `stripe` |
| Onboarding | Stripe-hosted (account link) | Stripe-hosted (account link) — asks a little more, since it opens a full Stripe account |
| Recipient's dashboard | Express Dashboard, opened with a one-time login link from the Get paid page | dashboard.stripe.com, signed into with their own Stripe login |
| Card processing fee on a tip | **The site** (unless the fee is raised to cover it) | The recipient |
| Dispute fee | **The site** | The recipient |
| Connect fees | **The site**: $2/active account/month + 0.25% + 25¢ per payout | None |
| 1099-K | **The site** files and pays per form | Stripe |
| Negative balance the recipient cannot repay | **The site** | Stripe |
| Stripe's advice for direct charges | Not its recommendation | Its recommendation ("We recommend using direct charges for connected accounts that have access to the full Stripe Dashboard") |

**Recommendation: the full Stripe Dashboard.** It is the only setup in which the plan's own premise —
the recipient bears processing, the site keeps only its cut — is true, and it also removes the
Connect fees, the 1099 filing and the liability. The cost is a less hand-held recipient experience: a
DJ gets a real Stripe account. A third option, no Stripe dashboard at all with Connect *embedded
components* on the Get paid page, could keep recipients on the site with Stripe collecting fees; it
is not built and would need its own plan.

To switch: set `ACCOUNT_SETUP = 'full'` in `server/providers/stripe.js`, and change the README's
"Who pays and who is liable" section to say so. Accounts already created keep the setup they were
created with — Stripe does not allow changing a dashboard or fee collector later — and each account
row records its own `dashboard`, `feesCollector` and `lossesCollector`, which the admin screen shows.

### Also found, and handled without needing a decision

- **Brazil.** "Platforms based outside of Brazil with Brazilian connected accounts can't collect
  application fees through Stripe" ([direct charges](https://docs.stripe.com/connect/direct-charges)).
  BR is left off the list on a platform outside Brazil, with that reason.
- **Currency.** A country is offered only when Stripe's country spec lists the site's currency among
  its `supported_payment_currencies` — Stripe's own answer to "can this account take a charge in this
  currency", so no list is typed in. The fee is named in the charge currency; Stripe converts the tip
  into the recipient's currency and the fee into the platform's.
- **Refunding the fee.** Stripe's default is *not* to refund the application fee; this extension
  passes `refund_application_fee: true` unless told otherwise, as planned.

> **Upstream changes are allowed.** Every dependency with `kempo` in its name (kempo, kempo-ui,
> kempo-css, kempo-server, kempo-payments, kempo-media, and the rest) is owned by the same person, and
> the goal of this project is to keep improving all of them. If the work here needs a change in one of
> them — a UI component, a payment call, a CMS hook — **make it, in that repository, without asking
> and without deferring it to a later step.** Do it the normal way there: tests, README and CHANGELOG,
> a backwards-compatible change where other packages depend on it, and the dependency order when
> publishing. Never commit a `file:` specifier.

## What it is

Lets users of a kempo site **receive money** from other users, with the site taking an optional fee,
using **Stripe Connect**. A user connects a payout account once; payments made *to* them are charged
on their account; the site keeps an application fee; Stripe pays out to their bank.

## Why it exists

[crowd-pulse.app](../crowd-pulse.app/PLAN.md) lets guests tip a DJ and take a 5% commission. Taking
tips on the site's own Stripe account and sending money on would make the site a **money
transmitter** — regulated, with licensing and compliance obligations a small team cannot carry.
Connect moves that role to Stripe: Stripe verifies each recipient's identity, holds their funds in
their own balance, pays them out and issues their tax forms. The site never holds the money.

It is a separate extension, not part of Crowd Pulse and not folded into kempo-payments, because:

- *Would anything other than this app use it?* Yes: any creator site, marketplace, or
  donation-to-an-organiser site.
- It is a different job from kempo-payments. Payments moves money **into the site's account**;
  payouts moves it **to other people**. They also have different failure modes (onboarding,
  verification, negative balances) and different admin screens.

## Not in scope

- **Custody.** The site never holds recipient funds. No wallet, no internal "withdraw".
- **Other processors.** Stripe Connect only, behind the same provider seam as kempo-payments.
- **Manual payouts / scheduling beyond what Stripe offers.** Stripe's payout schedule applies.
- **Tax calculation.** Tips and donations are generally not taxable sales; the platform fee is not
  run through kempo-tax. See "Tax" below.
- **Turning tips into credits.** An open design problem — see the last section.

## Concepts

- **Connected account** — one Stripe **Express** account per recipient user (`acct_…`), linked to a
  kempo user. Express: Stripe hosts onboarding and the recipient dashboard. Decision 1 above: verify
  in the current docs and write down who issues tax forms and who is liable for disputes and
  negative balances.
- **Onboarding** — a Stripe-hosted flow (account link). The recipient enters identity and bank
  details **at Stripe**; this site never sees or stores them.
- **Capabilities** — `charges_enabled` and `payouts_enabled`. A recipient cannot be paid until both
  are true, and this must be visible to the consumer so it can block a feature.
- **Application fee** — the site's cut, set per charge.

## How a tip is charged

Use **direct charges**: the PaymentIntent is created **on the recipient's connected account** with
`application_fee_amount` set. This means the *recipient* bears Stripe's processing fee and the
site receives only the application fee — which is what makes a 5% cut on a $1 tip viable at all
(5¢ against ~33¢ of processing; with destination charges the platform would lose money on every
small tip). Do **not** switch to destination charges to make the code simpler.

kempo-payments does not support this yet. See `../kempo-payments/PLAN.md`; that work comes first
and this extension depends on it.

## Fees

- A **fee percent** setting, default 5.
- A **maximum fee per recipient per reference** option, in the charge (site) currency, (Crowd Pulse: 5% up to $1,000 of tips per
  event, so at most $50). This needs the running total already charged against that reference, so
  this extension records every charge it creates in `kempoPayoutCharge`.
- A fee must be **computable by the caller**: `createConnectedPayment` accepts an explicit
  `feeAmount` which overrides the percentage, so a consumer can implement waivers (Crowd Pulse
  charity events pay no fee) without this extension knowing what a charity event is.
- Stripe charges platforms for Connect on top of processing. **Look up current Connect pricing before
  fixing defaults and document the real numbers in the README.** Do not guess.

## Data

Tables: `kempoPayoutAccount` (userId, stripeAccountId, status, chargesEnabled, payoutsEnabled,
country, requirements summary, timestamps) and `kempoPayoutCharge` (paymentId, recipientUserId,
reference `{ owner, ref }`, amount, feeAmount, currency, status).

Unique index on `kempoPayoutAccount.userId` and on `stripeAccountId`, and on
`kempoPayoutCharge.paymentId` — create them in `install.js` by hand, as kempo-payments does.

## SDK

| Function | Does |
|---|---|
| `getAccount({ userId })` | Connection status for a user, or `null` |
| `createOnboardingLink({ userId, returnUrl, refreshUrl })` | Creates the Stripe account if needed, returns the hosted link |
| `createDashboardLink({ userId })` | Login link to the recipient's Express dashboard |
| `canReceive({ userId })` | `true` only when `charges_enabled && payouts_enabled` |
| `createConnectedPayment({ recipientUserId, amount, currency, reference, feeAmount?, … })` | Charge **on** the recipient's account, via kempo-payments |
| `feeFor({ amount, recipientUserId, reference })` | The fee the default policy would take, with cap |
| `listCharges()`, `summary()` | Fees collected, per recipient and in total |

Hooks: `payouts:account-updated`, `payouts:charge-succeeded`, `payouts:charge-refunded`.

## Webhooks

Connect events arrive on a **separate endpoint with its own signing secret** (Stripe distinguishes
"Account" and "Connect" webhooks). Needed at least: `account.updated`, `capability.updated`,
`account.application.deauthorized`, `payout.failed`, and the payment/refund/dispute events for
connected accounts, which carry an `account` field.

Payment events for direct charges must reach kempo-payments so the payment row updates — forward
them via the entry point added in `../kempo-payments/PLAN.md` rather than reimplementing payment
state here. Verify the signature **before** anything else, on the raw body, as kempo-payments does.

## Refunds, disputes, negative balances

- Refunding a tip refunds the application fee too (`refund_application_fee`), by default. Make it a
  parameter, not a hard-code.
- A dispute on a connected account's charge can drive their balance negative. Surface the status to
  the recipient and to administrators; define who is liable *per Stripe's account type docs* and
  state it in the README. Do not leave this implied.
- A recipient who disconnects (`deauthorized`) must have `canReceive` become false immediately.

## Tax

- The **tip** is not a taxable sale; it passes between users and never becomes site revenue.
- The **fee** is the site's revenue. Whether a platform fee charged to a business is taxable is a
  state-by-state question the owner must answer; this extension does **not** call kempo-tax for it.
- Stripe issues recipient tax forms (e.g. 1099-K) for Express accounts — **verify** in the docs for
  the account type chosen, and document it.

## Dependencies

`kempo-payments` — **hard**, and it must be a version containing the connected-account support
described in its PLAN.md. Declare it in `kempo-config.json` `dependencies` and in `peerDependencies`.

## Admin

Under the **Commerce** nav group: connected accounts (status, requirements outstanding, country),
charges and fees collected, settings (fee percent, cap, webhook secret and endpoint to paste into
Stripe). Plus a **recipient-facing** page — "Get paid": connect, see status, open the Stripe
dashboard — usable by a non-admin user.

## Permissions and groups

`payouts:view`, `payouts:settings`, `payouts:connect` (a user managing their *own* account — the one
a normal signed-in user holds). Groups `kempo-payouts:administrator`, `kempo-payouts:viewer`.

## Conventions an agent must follow

Follow `~/dev/kempo/AGENTS.md` and copy the structure of `~/dev/kempo-payments`. Specifically:

- `server/utils/**` is HTTP-agnostic, returns `[error, data]` tuples, never throws.
- Public scope `payouts`. Custom elements prefixed **`k-payouts-`**. `<k-icon>`, never entities.
- Credentials are `secret` settings, declared in `kempo-config.json`, saved with their declared
  type. Blank means unchanged, an explicit `null` clears — see kempo-payments' settings route.
- Provider seam from the first commit, as in kempo-payments, even though only Stripe ships.
- Tests with `kempo-test`, PGlite unit tier; no mocking; **never call the live Stripe API from the
  default test run.** A separate documented manual procedure covers test-mode Connect.
- Update README and CHANGELOG with every behaviour change. Never start/stop dev servers.

## Definition of done

- Onboard a test recipient in Stripe **test mode**, see `canReceive` flip to true from the webhook.
- Charge a tip on the recipient's account with a fee; both sides correct in the Stripe dashboard.
- Refund it with and without the fee; dispute path observed in test mode.
- Fee cap across multiple tips for one reference, tested.
- Recipient page and admin screens loaded and checked in a browser.
- README documents real Connect pricing, liability, and the tax position. CHANGELOG written.

## Order of work

1. **kempo-payments first**, in its own repository, exactly as `../kempo-payments/PLAN.md`
   describes: the columns and `update.js` migration, the provider options, refunds with
   `refundApplicationFee`, the browser form's connected-account attribute, `receiveVerifiedEvent`.
   Its existing suite must pass **unmodified**. Commit there; do not push or publish.
2. **Then this extension**, against that local kempo-payments. Install it for development by
   copying the sibling's published `files` into `node_modules` (not a symlink, and never a `file:`
   specifier in package.json; `peerDependencies` names the minor that will contain Connect support).
3. Keep the two repositories' CHANGELOGs honest about what is unreleased.

## Conventions added since this plan was written

On top of the list above (these came out of building the credits, store credit and commerce plans):

- A field's hint or footnote goes in a muted `<small>` **inside its `<label>`, above the input**.
  Give fields and blocks an `mb` class. A detail view is a **page of its own** (its own address, so
  the back button works), not content swapped in place.
- New columns on an existing table are added in `update.js` **and** `install.js` with
  `IF NOT EXISTS`; kempo's installer only creates tables that are missing. Unique indexes are created
  by hand in `install.js`.
- Money is a whole number of the currency's smallest unit; a caller names an amount, not a price.
  Every write that can be retried takes an idempotency key.
- Optional extensions are found with `getExtension` and imported on demand; a disabled one counts as
  absent. This extension's one hard dependency is kempo-payments.
- Test tiers: unit on PGlite (`npm test`), integration on a real Postgres with a Playwright browser
  suite that builds a throwaway site and installs through kempo's own route. Mutation-check the tests
  that guard money (remove the guard, watch the test fail). Stripe test-mode flows run only when test
  keys are present and are skipped with a message otherwise.
- Test database port: pick the next free one in the repos' docker-compose files (5451 is free as of
  2026-10-14), name `kempo_payouts_test`.

## Open questions for the owner (do not guess)

- **Tips → credits.** Crowd Pulse wants a DJ to turn tip earnings into credits to avoid fees. With
  direct charges the money is in the DJ's Stripe balance, which the platform cannot simply debit.
  Options: a per-recipient "keep as credits" mode that routes the tip to the platform and grants
  credits instead (platform pays processing; needs a bonus rate to be attractive), or no
  conversion in v1. Needs the owner's decision *and* a tax and legal read. Do not build until decided.
- ~~Which countries to allow recipients from.~~ **Decided: any country Stripe supports for Express**,
  as a narrowable setting (decision 2).
- ~~Instant payouts.~~ **Decided: not offered here**; Stripe's schedule applies (defaults above).
