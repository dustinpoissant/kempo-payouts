# kempo-payouts — PLAN

> Status: **planned, nothing built.** This file is the brief. Build exactly what it describes and
> raise disagreements here rather than improvising.

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
  kempo user. Express: Stripe hosts onboarding and the recipient dashboard. Confirm in Stripe's
  current docs that Express is still the right type and what it implies for who issues tax forms
  and who is liable for disputes and negative balances.
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
- A **maximum fee per recipient per reference** option (Crowd Pulse: 5% up to $1,000 of tips per
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
- Public scope `payouts`. Custom elements prefixed **`k-out-`**. `<k-icon>`, never entities.
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

## Open questions for the owner (do not guess)

- **Tips → credits.** Crowd Pulse wants a DJ to turn tip earnings into credits to avoid fees. With
  direct charges the money is in the DJ's Stripe balance, which the platform cannot simply debit.
  Options: a per-recipient "keep as credits" mode that routes the tip to the platform and grants
  credits instead (platform pays processing; needs a bonus rate to be attractive), or no
  conversion in v1. Needs the owner's decision *and* a tax and legal read. Do not build until decided.
- Which countries to allow recipients from (Connect is not available everywhere).
- Instant payouts: offer, and who pays Stripe's fee for them?
