import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Spinner.js';
import '/kempo-ui/components/Table.js';
import '/kempo-ui/components/controls/TcOpen.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { listCharges } from '/payouts/sdk.js';
import { chargeLabel, formatDateTime, formatMoney } from '/payouts/utils/format.js';

/*
  Every payment made to a user, newest first, with what the site kept from each. Each opens its own
  page (/admin/extension/kempo-payouts/charge/?id=…), where it can be refunded.

  Narrowed by the page's own `?owner=&ref=` (a reference, such as one event) or by the filters here.

    <k-payouts-charges></k-payouts-charges>
*/

const PAGE = 25;
const CHARGE = '/admin/extension/kempo-payouts/charge/';

const fields = [
  { name: 'createdAt', label: 'When', size: 180, editable: false, calculator: charge => formatDateTime(charge.createdAt) },
  {
    name: 'recipient', label: 'Paid to', size: 200, editable: false,
    calculator: charge => charge.recipient?.name || charge.recipient?.email || charge.recipientUserId,
  },
  {
    name: 'description', label: 'For', editable: false,
    calculator: charge => charge.description || `${charge.referenceOwner} · ${charge.referenceId}`,
  },
  { name: 'amount', label: 'Amount', size: 120, editable: false, calculator: charge => formatMoney(charge.amount, charge.currency) },
  {
    name: 'feeKept', label: 'Fee kept', size: 120, editable: false,
    calculator: charge => formatMoney(charge.feeAmount - charge.feeRefunded, charge.currency),
  },
  {
    name: 'amountRefunded', label: 'Refunded', size: 120, editable: false,
    calculator: charge => charge.amountRefunded ? formatMoney(charge.amountRefunded, charge.currency) : '—',
  },
  { name: 'status', label: 'Status', size: 140, editable: false, calculator: chargeLabel },
];

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

  updated(changed){
    if(!changed.has('charges')) return;
    this.renderRoot.querySelector('k-table')?.setData({
      records: this.charges.map(charge => ({ ...charge, _url: `${CHARGE}?id=${encodeURIComponent(charge.id)}` })),
      fields,
    });
  }

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
        <k-table open-on-click>
          <kc-tc-open slot="before"></kc-tc-open>
        </k-table>
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
  `;
}

customElements.define('k-payouts-charges', Charges);
