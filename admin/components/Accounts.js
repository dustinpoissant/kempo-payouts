import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getSummary, listAccounts } from '/payouts/sdk.js';
import { accountStatus, formatDate, formatMoney } from '/payouts/utils/format.js';

/*
  The fees collected, and every connected payout account with a search to find one. Each account is
  a link to its own page (/admin/extension/kempo-payouts/account/?id=…), where its status at Stripe,
  its balance and the charges made to it are.

    <k-payouts-accounts></k-payouts-accounts>
*/

const PAGE = 25;
const ACCOUNT = '/admin/extension/kempo-payouts/account/';

export default class Accounts extends ShadowComponent {
  static properties = {
    summary: { type: Object, state: true },
    accounts: { type: Array, state: true },
    total: { type: Number, state: true },
    offset: { type: Number, state: true },
    search: { type: String, state: true },
    status: { type: String, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.summary = null;
    this.accounts = [];
    this.total = 0;
    this.offset = 0;
    this.search = '';
    this.status = '';
    this.loading = true;
    this.error = '';
    this.timer = null;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
const pane = this.closest('k-tab-content');
    // Loads when its tab is first opened, so a tab nobody opens makes no requests.
    if(!pane || pane.active) this.load();
    else this.closest('k-tabs')?.addEventListener('tabfirstshown', ({ detail }) => {
      if(detail.tab === pane.name) this.load();
    });
  }

  /*
    Data
  */

  load = async () => {
    this.loading = true;
    const [[error, list], [, summary]] = await Promise.all([
      listAccounts({ search: this.search, status: this.status, limit: PAGE, offset: this.offset }),
      getSummary(),
    ]);
    this.loading = false;
    this.error = error ? error.msg : '';
    this.accounts = list?.accounts || [];
    this.total = list?.total || 0;
    this.summary = summary || null;
  };

  /*
    Actions
  */

  typed = event => {
    this.search = event.target.value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.offset = 0;
      this.load();
    }, 300);
  };

  filter = event => {
    this.status = event.target.value;
    this.offset = 0;
    this.load();
  };

  page = direction => {
    this.offset = Math.max(0, this.offset + direction * PAGE);
    this.load();
  };

  go = id => location.assign(`${ACCOUNT}?id=${encodeURIComponent(id)}`);

  /*
    Rendering
  */

  #renderSummary(){
    if(!this.summary) return nothing;
    const { totals, accounts } = this.summary;
    return html`
      <div class="d-f tiles mb">
        ${totals.length ? totals.map(total => html`
          <div class="card tile">
            <span class="tc-muted">Fees collected</span>
            <span class="value">${formatMoney(total.fees, total.currency)}</span>
            <span class="tc-muted">From ${formatMoney(total.amount, total.currency)} paid to users in ${total.count} payment${total.count === 1 ? '' : 's'}</span>
          </div>
        `) : html`
          <div class="card tile">
            <span class="tc-muted">Fees collected</span>
            <span class="value">Nothing yet</span>
            <span class="tc-muted">No payment to a user has succeeded</span>
          </div>
        `}
        <div class="card tile">
          <span class="tc-muted">Ready to be paid</span>
          <span class="value">${accounts.enabled || 0}</span>
          <span class="tc-muted">${(accounts.pending || 0) + (accounts.restricted || 0)} still setting up${accounts.disconnected ? `, ${accounts.disconnected} disconnected` : ''}</span>
        </div>
      </div>
    `;
  }

  render(){
    return html`
      ${this.#renderSummary()}
      <div class="d-f controls mb">
        <input type="search" placeholder="Find by name, email or Stripe account" .value=${this.search} @input=${this.typed} />
        <select .value=${this.status} @change=${this.filter}>
          <option value="">Every status</option>
          ${['enabled', 'restricted', 'pending', 'disconnected'].map(status => html`<option value=${status}>${accountStatus(status).label}</option>`)}
        </select>
        ${this.loading ? html`<k-spinner size="sm"></k-spinner>` : nothing}
      </div>
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
      ${!this.accounts.length && !this.loading
        ? html`<p class="tc-muted">${this.search || this.status ? 'No payout account matches that.' : 'Nobody has connected a payout account yet. Users do it on the Get paid page, /payouts/.'}</p>`
        : html`
          <div class="table-wrapper">
            <table>
              <thead><tr><th>User</th><th>Status</th><th>Country</th><th>Stripe account</th><th>Connected</th></tr></thead>
              <tbody>
                ${this.accounts.map(account => html`
                  <tr @click=${() => this.go(account.id)}>
                    <td>
                      <a href="${ACCOUNT}?id=${encodeURIComponent(account.id)}" @click=${event => event.stopPropagation()}>${account.user?.name || account.user?.email || account.userId}</a>
                      ${account.user?.name ? html`<span class="tc-muted d-b">${account.user.email}</span>` : nothing}
                    </td>
                    <td class="tc-${accountStatus(account.status).tone}">${accountStatus(account.status).label}${account.payoutFailure ? html`<span class="tc-danger d-b">A payout failed</span>` : nothing}</td>
                    <td>${account.country}</td>
                    <td class="ff-mono">${account.providerAccountId.startsWith('acct_') ? account.providerAccountId : '—'}</td>
                    <td class="tc-muted">${formatDate(account.createdAt)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          ${this.total > PAGE ? html`
            <div class="d-f pager">
              <button ?disabled=${this.offset === 0} @click=${() => this.page(-1)}>Previous</button>
              <span class="tc-muted">${this.offset + 1}–${Math.min(this.offset + PAGE, this.total)} of ${this.total}</span>
              <button ?disabled=${this.offset + PAGE >= this.total} @click=${() => this.page(1)}>Next</button>
            </div>
          ` : nothing}
        `}
    `;
  }

  static styles = css`
    :host { display: block; }
    .tiles, .controls, .pager { gap: var(--spacer); align-items: stretch; }
    .controls { align-items: center; }
    .controls input[type="search"], .controls select { margin: 0; max-width: 22rem; }
    .tile { display: flex; flex-direction: column; gap: var(--spacer_q); min-width: 13rem; max-width: 22rem; padding-bottom: var(--spacer); }
    .tile .value { font-size: 1.6rem; line-height: 1.2; font-weight: 600; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--c_bg__alt); }
  `;
}

customElements.define('k-payouts-accounts', Accounts);
