import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { listCharges } from '/payouts/sdk.js';
import { chargeStatus, chargeTone, formatDateTime, formatMoney } from '/payouts/utils/format.js';

/*
  Every payment made to a user, newest first, with what the site kept from each. Each opens its own
  page (/admin/extension/kempo-payouts/charge/?id=…), where it can be refunded.

  Narrowed by the page's own `?owner=&ref=` (a reference, such as one event) or by the filters here.

    <k-payouts-charges></k-payouts-charges>
*/

const PAGE = 25;
const CHARGE = '/admin/extension/kempo-payouts/charge/';

export default class Charges extends ShadowComponent {
  static properties = {
    charges: { type: Array, state: true },
    total: { type: Number, state: true },
    offset: { type: Number, state: true },
    status: { type: String, state: true },
    owner: { type: String, state: true },
    ref: { type: String, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    const params = new URLSearchParams(location.search);
    this.charges = [];
    this.total = 0;
    this.offset = 0;
    this.status = '';
    this.owner = params.get('owner') || '';
    this.ref = params.get('ref') || '';
    this.loading = true;
    this.error = '';
    this.timer = null;
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.load();
  }

  /*
    Data
  */

  load = async () => {
    this.loading = true;
    const [error, list] = await listCharges({ status: this.status, owner: this.owner, ref: this.ref, limit: PAGE, offset: this.offset });
    this.loading = false;
    this.error = error ? error.msg : '';
    this.charges = list?.charges || [];
    this.total = list?.total || 0;
  };

  /*
    Actions
  */

  change = (field, value, wait = 0) => {
    this[field] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.offset = 0;
      this.load();
    }, wait);
  };

  page = direction => {
    this.offset = Math.max(0, this.offset + direction * PAGE);
    this.load();
  };

  go = id => location.assign(`${CHARGE}?id=${encodeURIComponent(id)}`);

  /*
    Rendering
  */

  render(){
    return html`
      <div class="d-f controls mb">
        <label>Status
          <select .value=${this.status} @change=${event => this.change('status', event.target.value)}>
            <option value="">Any</option>
            <option value="succeeded">Paid</option>
            <option value="requires_payment_method,requires_confirmation,requires_action,processing">Not paid yet</option>
            <option value="canceled,failed">Abandoned or failed</option>
          </select>
        </label>
        <label>Reference owner
          <input type="text" placeholder="crowd-pulse" .value=${this.owner} @input=${event => this.change('owner', event.target.value, 300)} />
        </label>
        <label>Reference
          <input type="text" placeholder="An event id" .value=${this.ref} @input=${event => this.change('ref', event.target.value, 300)} />
        </label>
        ${this.loading ? html`<k-spinner size="sm"></k-spinner>` : nothing}
      </div>
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : nothing}
      ${!this.charges.length && !this.loading ? html`<p class="tc-muted">${this.status || this.owner || this.ref ? 'No payment matches that.' : 'Nobody has paid a user yet.'}</p>` : html`
        <div class="table-wrapper">
          <table>
            <thead><tr><th>When</th><th>Paid to</th><th>For</th><th class="ta-right">Amount</th><th class="ta-right">Fee kept</th><th class="ta-right">Refunded</th><th>Status</th></tr></thead>
            <tbody>
              ${this.charges.map(charge => html`
                <tr @click=${() => this.go(charge.id)}>
                  <td><a href="${CHARGE}?id=${encodeURIComponent(charge.id)}" @click=${event => event.stopPropagation()}>${formatDateTime(charge.createdAt)}</a></td>
                  <td>${charge.recipient?.name || charge.recipient?.email || charge.recipientUserId}</td>
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
    .controls { gap: var(--spacer); align-items: flex-end; }
    .controls label { margin: 0; }
    .controls input, .controls select { margin: 0; max-width: 16rem; }
    .pager { gap: var(--spacer); align-items: center; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--c_bg__alt); }
  `;
}

customElements.define('k-payouts-charges', Charges);
