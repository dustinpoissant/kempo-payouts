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

### Changed from the plan (decision 1, revised by the owner 2026-10-15 — see PLAN.md "Findings while building")

- **Recipients get the full Stripe Dashboard, not the Express Dashboard** (`ACCOUNT_SETUP = 'full'`;
  the owner's choice). Legacy `type: express` accounts cannot be created any more (Stripe answers 400),
  and Accounts v2 only allows the Express Dashboard with the **site** collecting fees and carrying
  losses — which would have put the card processing fee, Connect fees, 1099 filing and negative
  balances on the site and defeated the plan's premise that the recipient bears processing. With
  `full`, Stripe collects its fees from the recipient and carries the losses. Verified in test mode: a
  $20.00 charge with a $1.00 fee shows Stripe's 88¢ on the recipient's side and a net of $18.12. The
  Express setup remains in the code and tests as the alternative.
