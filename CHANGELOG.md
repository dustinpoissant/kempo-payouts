# Changelog

All notable changes to `kempo-payouts` are documented in this file.

## [Unreleased]

First real release (built 2026-10-15; committed locally, **not pushed or published**). The package on
npm is a placeholder carrying the plan. Release **after kempo-payments 0.2.0**, which this requires.

### Added

- **Connected payout accounts.** A user connects a Stripe account at `/payouts/` (Stripe-hosted
  onboarding — this site never sees identity or bank details); `canReceive` is true only when Stripe
  says charges **and** payouts are enabled, and is false the instant the account is disconnected.
  Accounts are created through Stripe's Accounts v2 API.
- **`createConnectedPayment`** — a Connect direct charge on the recipient's account through
  kempo-payments, with the site's fee as the application fee. Idempotent on a required key; refuses a
  recipient who cannot receive, a malformed amount, another currency, or a fee not less than the payment.
- **Fee policy:** a percentage (default 5, rounded down) with an optional cap per recipient per
  reference, an explicit `feeAmount` override for the caller's own rules, and an exact correction when
  tips paid at once would take the total past the cap (the excess is refunded at Stripe).
- **Refunds** for administrators and calling code, giving the site's fee back by default, with an
  idempotency key. Recipients see their charges and refunds read-only.
- **Connect webhook** with its own signing secret: verified first on the raw body, account and payout
  events handled here, payment/refund/dispute events handed to kempo-payments.
- **Countries** are Stripe's list, cached, narrowed by the site's currency, by Brazil's rule and by
  Stripe's own refusals (both forms seen in test mode — at creation and at the onboarding link), and by
  an `allowed_countries` setting that can only narrow.
- **Hooks:** `payouts:account-updated`, `payouts:charge-succeeded`, `payouts:charge-refunded`,
  `payouts:charge-disputed`.
- **Admin** under Commerce: accounts (with live balance and who pays/who is liable), payments (with the
  refund form), settings. **Recipient page** at `/payouts/`.
- **Permissions** `payouts:connect` (given to every user on a first install only), `payouts:view`,
  `payouts:refund`, `payouts:settings`; groups `kempo-payouts:viewer` and `…:administrator`.
- A `payments` icon in kempo core's shared icon set (local commit, unreleased).
- **Tests:** 61 on the unit tier (in-memory Postgres), 70 on the integration tier including real
  parallel connections and a Chromium suite on a throwaway site; guards that protect money are
  mutation-checked. `scripts/connect-test-mode.js` proves the Stripe parts in test mode.

### Changed from the plan (decision 1 needs the owner — see PLAN.md "Findings while building")

- **Legacy `type: express` accounts cannot be created any more** (Stripe answers 400). The build creates
  Accounts v2 accounts with the Express Dashboard, which Stripe only allows with the **site** collecting
  fees and carrying losses. The consequence is that Stripe bills the site the card processing fee on
  every payment, the site pays Connect fees ($2/active account/month + 0.25% + 25¢ per payout) and files
  the recipients' 1099s — **the premise that the recipient bears the processing fee does not hold on
  this setup.** The full Stripe Dashboard setup is implemented and one constant away
  (`ACCOUNT_SETUP`); it is recommended and **not switched** because decision 1 says not to.
