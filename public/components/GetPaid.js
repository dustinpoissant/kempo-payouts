import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getMyAccount, getMyBalance, listMyCharges, openDashboard, refreshMyAccount, startOnboarding } from '/payouts/sdk.js';
import { accountStatus, chargeStatus, chargeTone, formatDateTime, formatMoney, requirementLabels } from '/payouts/utils/format.js';

/*
  The Get paid page, served at /payouts/components/GetPaid.js — where a user connects the account
  other people pay them into, sees whether they can be paid, opens their Stripe dashboard, and reads
  the charges made to them.

  ```html
  <script type="module" src="/payouts/components/GetPaid.js"></script>
  <k-payouts-get-paid></k-payouts-get-paid>
  ```

  Identity and bank details are given to Stripe on its own pages; nothing of the kind is typed here.
  The charges are read-only: a recipient cannot refund one from this page (an administrator, or the
  site's own code, can).

  Stripe sends people back here with `?onboarding=return` (this page then asks Stripe how far they
  got, rather than waiting for the webhook) or `?onboarding=refresh` (their link expired; this page
  fetches a new one and sends them straight back).
*/

export default class GetPaid extends ShadowComponent {
  static properties = {
    data: { type: Object, state: true },
    balance: { type: Object, state: true },
    charges: { type: Array, state: true },
    country: { type: String, state: true },
    busy: { type: String, state: true },
    error: { type: String, state: true },
    signedOut: { type: Boolean, state: true },
    forbidden: { type: Boolean, state: true },
  };

  constructor(){
    super();
    this.data = null;
    this.balance = null;
    this.charges = [];
    this.country = '';
    this.busy = '';
    this.error = '';
    this.signedOut = false;
    this.forbidden = false;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.start();
  }

  start = async () => {
    const step = new URLSearchParams(location.search).get('onboarding');
    if(step === 'refresh') return this.onboard();
    if(step === 'return') await refreshMyAccount();
    if(step) history.replaceState(null, '', location.pathname);
    this.load();
  };

  /*
    Data
  */

  load = async () => {
    const [error, data] = await getMyAccount();
    this.signedOut = error?.code === 401;
    this.forbidden = error?.code === 403;
    if(error){
      this.error = this.signedOut || this.forbidden ? '' : error.msg;
      return;
    }
    this.data = data;
    this.country ||= data.countries.length === 1 ? data.countries[0].code : '';

    if(data.account?.detailsSubmitted){
      const [, balance] = await getMyBalance();
      this.balance = balance?.balance || null;
    }
    if(data.account){
      const [, list] = await listMyCharges({ limit: 50 });
      this.charges = list?.charges || [];
    }
  };

  /*
    Actions
  */

  onboard = async () => {
    this.busy = 'onboarding';
    this.error = '';
    const [error, link] = await startOnboarding({ country: this.country || undefined });
    if(error){
      this.busy = '';
      this.error = error.msg;
      if(!this.data) this.load();
      return;
    }
    location.assign(link.url);
  };

  dashboard = async () => {
    this.busy = 'dashboard';
    this.error = '';
    const [error, link] = await openDashboard();
    this.busy = '';
    if(error){
      this.error = error.msg;
      return;
    }
    window.open(link.url, '_blank', 'noopener');
  };

  /*
    Rendering
  */

  #renderConnect(reconnecting){
    const { countries, currency, countriesError, fee } = this.data;
    const chosen = countries.find(country => country.code === this.country);

    return html`
      <div class="card mb">
        <h2 class="mbh">${reconnecting ? 'Connect a payout account again' : 'Get paid by other people on this site'}</h2>
        <p class="mb">
          Payments to you go into your own Stripe account, and Stripe pays them into your bank. This site
          never holds your money, and never sees your identity or bank details — you give those to
          Stripe on its own pages.
          ${fee?.percent ? html`This site keeps ${fee.percent}% of each payment${fee.cap ? html`, up to ${formatMoney(fee.cap, currency)} for any one event` : nothing}.` : nothing}
        </p>
        ${countriesError && !countries.length ? html`<p class="tc-danger mb" role="alert">${countriesError}</p>` : html`
          <label class="d-b mb" for="country">Where you live
            <small class="d-b tc-muted">Stripe opens your account in this country. It cannot be changed afterwards.</small>
            <select id="country" .value=${this.country} @change=${event => { this.country = event.target.value; }}>
              <option value="">Choose a country</option>
              ${countries.map(country => html`<option value=${country.code} ?selected=${country.code === this.country}>${country.name}</option>`)}
            </select>
          </label>
          ${chosen ? html`
            <div class="mb">
              <p class="mbh"><strong>What this means in ${chosen.name}</strong></p>
              <ul class="mb">
                <li>People pay you in ${currency.toUpperCase()}.${chosen.converts ? html` Stripe converts it into ${chosen.defaultCurrency.toUpperCase()} for your account and charges a conversion fee, which comes out of what you receive.` : nothing}</li>
                <li>Stripe pays the money into your bank on its own schedule for ${chosen.name}. It shows you the timing when you set up, and you can see every payout in your Stripe dashboard.</li>
                <li>Stripe will ask who you are and for your bank details, and may ask for an identity document — that is the law for anybody receiving money, not this site’s choice.</li>
              </ul>
            </div>
          ` : nothing}
          <button class="primary mb" ?disabled=${!this.country || !!this.busy} @click=${this.onboard}>
            ${this.busy === 'onboarding' ? 'Sending you to Stripe…' : 'Set up payouts with Stripe'}
          </button>
        `}
      </div>
    `;
  }

  #renderStatus(){
    const { account } = this.data;
    const status = accountStatus(account.status);
    const needs = requirementLabels(account.requirementsDue);

    return html`
      <div class="card mb">
        <p class="mbh"><span class="tc-${status.tone}">${account.canReceive ? html`<k-icon name="check_circle"></k-icon> ` : nothing}<strong>${status.label}</strong></span></p>
        ${account.canReceive ? html`<p class="mb">People on this site can pay you. Stripe pays the money into your bank.</p>` : nothing}
        ${!account.canReceive && account.status !== 'disconnected' ? html`
          <p class="mbh">Nobody can pay you until Stripe has finished checking your details.</p>
          ${needs.length ? html`<p class="mb">Stripe still needs: ${needs.join(', ')}.${account.requirementsDeadline ? html` Before ${formatDateTime(account.requirementsDeadline)}.` : nothing}</p>` : html`<p class="mb tc-muted">If you have just finished, Stripe can take a few minutes to confirm.</p>`}
        ` : nothing}
        ${account.payoutFailure ? html`<p class="tc-danger mb" role="alert"><k-icon name="warning"></k-icon> A payout to your bank failed: ${account.payoutFailure}. The money is safe in your Stripe balance — update your bank details in your Stripe dashboard.</p>` : nothing}
        <div class="d-f actions">
          ${!account.canReceive ? html`<button class="primary" ?disabled=${!!this.busy} @click=${this.onboard}>${this.busy === 'onboarding' ? 'Sending you to Stripe…' : account.detailsSubmitted ? 'Update your details with Stripe' : 'Continue setting up with Stripe'}</button>` : nothing}
          ${account.detailsSubmitted ? html`<button ?disabled=${!!this.busy} @click=${this.dashboard}><k-icon name="link"></k-icon> ${this.busy === 'dashboard' ? 'Opening…' : 'Open your Stripe dashboard'}</button>` : nothing}
        </div>
      </div>
    `;
  }

  #renderBalance(){
    if(!this.balance) return nothing;
    const line = entries => entries.length ? entries.map(entry => formatMoney(entry.amount, entry.currency)).join(', ') : formatMoney(0, this.data.account.defaultCurrency || 'usd');
    return html`
      <div class="card mb">
        <p class="mbh"><strong>Your Stripe balance</strong></p>
        <p class="mbh">Available: ${line(this.balance.available)}</p>
        <p class="mb tc-muted">On its way: ${line(this.balance.pending)}</p>
        ${this.balance.negative ? html`<p class="tc-danger mb" role="alert"><k-icon name="warning"></k-icon> Your balance is below zero — usually a refund or a chargeback. Stripe takes it from your next payments and holds payouts until it is back above zero.</p>` : nothing}
      </div>
    `;
  }

  #renderCharges(){
    if(!this.data.account) return nothing;
    return html`
      <h2>Payments to you</h2>
      ${!this.charges.length ? html`<p class="tc-muted">Nobody has paid you yet.</p>` : html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>When</th><th>What for</th><th class="ta-right">Amount</th><th class="ta-right">Site’s fee</th><th class="ta-right">Refunded</th><th>Status</th></tr></thead>
            <tbody>
              ${this.charges.map(charge => html`
                <tr>
                  <td class="tc-muted">${formatDateTime(charge.createdAt)}</td>
                  <td>${charge.description || charge.referenceId}</td>
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

  render(){
    if(this.signedOut) return html`<p><a href="/login?redirect=${encodeURIComponent(location.pathname)}">Sign in</a> to get paid on this site.</p>`;
    if(this.forbidden) return html`<p class="tc-muted">This site has not turned on payouts for your account.</p>`;
    if(!this.data) return this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : html`<k-spinner></k-spinner>`;

    const { account } = this.data;
    return html`
      ${this.error ? html`<p class="tc-danger mb" role="alert">${this.error}</p>` : nothing}
      ${!account || account.status === 'disconnected' ? html`
        ${account ? html`<p class="tc-warning mb"><k-icon name="warning"></k-icon> Your payout account was disconnected from this site, so nobody can pay you.</p>` : nothing}
        ${this.#renderConnect(!!account)}
      ` : html`${this.#renderStatus()}${this.#renderBalance()}`}
      ${this.#renderCharges()}
    `;
  }

  static styles = css`
    :host { display: block; }
    .actions { gap: var(--spacer); align-items: center; }
    select { max-width: 24rem; }
  `;
}

customElements.define('k-payouts-get-paid', GetPaid);
