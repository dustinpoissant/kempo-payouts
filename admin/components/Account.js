import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getAccount, getAccountBalance, syncAccount } from '/payouts/sdk.js';
import { accountStatus, chargeStatus, chargeTone, formatDateTime, formatMoney, requirementLabels } from '/payouts/utils/format.js';

/*
  One connected payout account: whose it is, what Stripe says about it, who pays Stripe's fees on it
  and who carries its losses, its balance at Stripe, and the charges made to it.

  A page of its own (/admin/extension/kempo-payouts/account/?id=…), so the address changes and the
  back button returns to the list.

    <k-payouts-account account-id="pac_…"></k-payouts-account>
*/

const CHARGE = '/admin/extension/kempo-payouts/charge/';

const SETUP = {
  feesCollector: {
    application: 'This site — Stripe bills the site its card processing and dispute fees on every payment to this account',
    application_express: 'This site, on Stripe’s older Express terms — the account pays the processing fee, the site pays Connect’s fees',
    stripe: 'The account holder — Stripe takes its fees from what they receive',
  },
  lossesCollector: {
    application: 'This site — if the balance goes below zero and they cannot pay it back, the site owes it',
    stripe: 'Stripe — a negative balance they cannot pay back is Stripe’s',
  },
};

export default class Account extends ShadowComponent {
  static properties = {
    accountId: { type: String, attribute: 'account-id' },
    detail: { type: Object, state: true },
    balance: { type: Object, state: true },
    balanceError: { type: String, state: true },
    busy: { type: Boolean, state: true },
    notice: { type: String, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.accountId = '';
    this.detail = null;
    this.balance = null;
    this.balanceError = '';
    this.busy = false;
    this.notice = '';
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.accountId ||= new URLSearchParams(location.search).get('id') || '';
    this.load();
  }

  /*
    Data
  */

  load = async () => {
    if(!this.accountId){
      this.error = 'No account was chosen.';
      return;
    }
    const [error, detail] = await getAccount(this.accountId);
    this.error = error?.msg || '';
    this.detail = detail || null;
    if(detail?.account.detailsSubmitted){
      const [balanceError, result] = await getAccountBalance(this.accountId);
      this.balance = result?.balance || null;
      this.balanceError = balanceError?.msg || '';
    }
  };

  /*
    Actions
  */

  sync = async () => {
    this.busy = true;
    this.notice = '';
    const [error, result] = await syncAccount(this.accountId);
    this.busy = false;
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.notice = result.changed ? 'Brought up to date from Stripe.' : 'Already up to date with Stripe.';
    this.load();
  };

  /*
    Rendering
  */

  #renderBalance(){
    if(this.balanceError) return html`<p class="tc-muted mb">The balance could not be read from Stripe: ${this.balanceError}</p>`;
    if(!this.balance) return nothing;
    const line = entries => entries.length ? entries.map(entry => formatMoney(entry.amount, entry.currency)).join(', ') : '—';
    return html`
      <div class="card tile mb">
        <span class="tc-muted">Balance at Stripe</span>
        <span class="value ${this.balance.negative ? 'tc-danger' : ''}">${line(this.balance.available)}</span>
        <span class="tc-muted">On its way: ${line(this.balance.pending)}</span>
        ${this.balance.negative ? html`<span class="tc-danger"><k-icon name="warning"></k-icon> Below zero — a refund or a lost dispute. Stripe takes it from this account’s next payments and holds its payouts until it is back above zero.</span>` : nothing}
      </div>
    `;
  }

  render(){
    if(!this.detail) return this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : html`<k-spinner></k-spinner>`;
    const { account, user, charges, totals, countryName } = this.detail;
    const status = accountStatus(account.status);
    const needs = requirementLabels(account.requirementsDue);

    return html`
      <h2 class="mbq">${user?.name || user?.email || account.userId}</h2>
      ${user?.name ? html`<p class="tc-muted mb">${user.email}</p>` : nothing}

      <p class="mb"><span class="tc-${status.tone}"><strong>${status.label}</strong></span>${account.canReceive ? ' — other users can pay them.' : ' — nobody can pay them yet.'}</p>
      ${this.notice ? html`<p class="tc-success mb" role="status"><k-icon name="check_circle"></k-icon> ${this.notice}</p>` : nothing}
      ${this.error ? html`<p class="tc-danger mb" role="alert">${this.error}</p>` : nothing}
      ${needs.length ? html`<p class="mb">Stripe still needs: ${needs.join(', ')}${account.requirementsDeadline ? `, before ${formatDateTime(account.requirementsDeadline)}` : ''}.</p>` : nothing}
      ${account.disabledReason ? html`<p class="tc-warning mb">Stripe’s reason: ${account.disabledReason.replace(/[._]/g, ' ')}</p>` : nothing}
      ${account.payoutFailure ? html`<p class="tc-danger mb"><k-icon name="warning"></k-icon> A payout to their bank failed on ${formatDateTime(account.payoutFailedAt)}: ${account.payoutFailure}</p>` : nothing}

      <div class="d-f actions mb">
        <button ?disabled=${this.busy} @click=${this.sync}><k-icon name="replay"></k-icon> ${this.busy ? 'Checking…' : 'Check with Stripe'}</button>
      </div>

      ${this.#renderBalance()}

      <dl class="facts mb">
        <dt>Stripe account</dt><dd class="ff-mono">${account.providerAccountId}${account.livemode ? '' : ' (test mode)'}</dd>
        <dt>Country</dt><dd>${countryName} (${account.country})${account.defaultCurrency ? `, paid out in ${account.defaultCurrency.toUpperCase()}` : ''}</dd>
        <dt>Dashboard</dt><dd>${account.dashboard === 'express' ? 'Stripe Express Dashboard' : account.dashboard === 'full' ? 'Full Stripe Dashboard' : account.dashboard || '—'}</dd>
        <dt>Pays Stripe’s fees</dt><dd>${SETUP.feesCollector[account.feesCollector] || account.feesCollector || '—'}</dd>
        <dt>Liable for losses</dt><dd>${SETUP.lossesCollector[account.lossesCollector] || account.lossesCollector || '—'}</dd>
        <dt>Connected</dt><dd>${formatDateTime(account.createdAt)}</dd>
        ${account.disconnectedAt ? html`<dt>Disconnected</dt><dd>${formatDateTime(account.disconnectedAt)}</dd>` : nothing}
        <dt>Last heard from Stripe</dt><dd>${account.syncedAt ? formatDateTime(account.syncedAt) : 'Never — check the Connect webhook on the Settings tab'}</dd>
      </dl>

      <h3>Payments to them</h3>
      ${totals.length ? html`<p class="mb">${totals.map(total => `${formatMoney(total.amount, total.currency)} paid, ${formatMoney(total.fees, total.currency)} kept by the site`).join('; ')}.</p>` : nothing}
      ${!charges.length ? html`<p class="tc-muted">Nobody has paid them yet.</p>` : html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>When</th><th>For</th><th class="ta-right">Amount</th><th class="ta-right">Fee kept</th><th class="ta-right">Refunded</th><th>Status</th></tr></thead>
            <tbody>
              ${charges.map(charge => html`
                <tr>
                  <td><a href="${CHARGE}?id=${encodeURIComponent(charge.id)}">${formatDateTime(charge.createdAt)}</a></td>
                  <td>${charge.description || `${charge.referenceOwner} · ${charge.referenceId}`}</td>
                  <td class="ta-right">${formatMoney(charge.amount, charge.currency)}</td>
                  <td class="ta-right">${formatMoney(charge.feeAmount - charge.feeRefunded, charge.currency)}</td>
                  <td class="ta-right">${charge.amountRefunded ? formatMoney(charge.amountRefunded, charge.currency) : '—'}</td>
                  <td class="tc-${chargeTone(charge)}">${chargeStatus(charge.status)}${charge.disputed ? ' · disputed' : ''}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `}
    `;
  }

  static styles = css`
    :host { display: block; }
    .actions { gap: var(--spacer); align-items: center; }
    .tile { display: flex; flex-direction: column; gap: var(--spacer_q); max-width: 30rem; padding-bottom: var(--spacer); }
    .tile .value { font-size: 1.6rem; line-height: 1.2; font-weight: 600; }
    .facts { display: grid; grid-template-columns: max-content 1fr; column-gap: var(--spacer); row-gap: var(--spacer_h); }
    .facts dt { color: var(--tc_muted); }
    .facts dd { margin: 0; }
  `;
}

customElements.define('k-payouts-account', Account);
