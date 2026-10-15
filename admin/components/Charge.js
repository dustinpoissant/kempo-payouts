import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getCharge, newKey, refundCharge, syncCharge } from '/payouts/sdk.js';
import { chargeStatus, chargeTone, formatDateTime, formatMoney, parseMoney, toMajor } from '/payouts/utils/format.js';
import permissions from './permissions.js';

/*
  One payment to a user: who paid whom, for what, what the site kept, what was refunded — and, for
  somebody holding `payouts:refund`, the form to refund it. A page of its own
  (/admin/extension/kempo-payouts/charge/?id=…).

  The refund gives the site's fee back with it unless that box is unticked, and each submission
  carries its own key, so a double click refunds once.

    <k-payouts-charge charge-id="pch_…"></k-payouts-charge>
*/

const ACCOUNTS = '/admin/extension/kempo-payouts/';

export default class Charge extends ShadowComponent {
  static properties = {
    chargeId: { type: String, attribute: 'charge-id' },
    detail: { type: Object, state: true },
    canRefund: { type: Boolean, state: true },
    form: { type: Object, state: true },
    busy: { type: String, state: true },
    notice: { type: String, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.chargeId = '';
    this.detail = null;
    this.canRefund = false;
    this.form = { amount: '', reason: '', fee: true, key: newKey() };
    this.busy = '';
    this.notice = '';
    this.error = '';
  }

  /*
    Lifecycle
  */

  connectedCallback(){
    super.connectedCallback();
    this.chargeId ||= new URLSearchParams(location.search).get('id') || '';
    permissions().then(held => {
      this.canRefund = held.has('payouts:refund');
    });
    this.load();
  }

  /*
    Data
  */

  load = async () => {
    if(!this.chargeId){
      this.error = 'No payment was chosen.';
      return;
    }
    const [error, detail] = await getCharge(this.chargeId);
    this.error = error?.msg || '';
    this.detail = detail || null;
    if(detail) this.form = { ...this.form, amount: detail.refundable ? toMajor(detail.refundable, detail.charge.currency) : '' };
  };

  /*
    Actions
  */

  sync = async () => {
    this.busy = 'sync';
    this.notice = '';
    const [error] = await syncCharge(this.chargeId);
    this.busy = '';
    this.error = error?.msg || '';
    if(!error) this.notice = 'Brought up to date from Stripe.';
    this.load();
  };

  refund = async event => {
    event.preventDefault();
    const { charge, refundable } = this.detail;
    const amount = parseMoney(this.form.amount, charge.currency);
    if(!amount || amount > refundable){
      this.error = `Enter an amount up to ${formatMoney(refundable, charge.currency)}`;
      return;
    }

    this.busy = 'refund';
    const [error] = await refundCharge(this.chargeId, {
      amount: amount === refundable ? undefined : amount,
      reason: this.form.reason || undefined,
      refundApplicationFee: this.form.fee,
      idempotencyKey: this.form.key,
    });
    this.busy = '';
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.notice = `Refunded ${formatMoney(amount, charge.currency)}${this.form.fee ? ', with the site’s share of the fee' : ', and the site kept its fee'}.`;
    this.form = { amount: '', reason: '', fee: true, key: newKey() };
    this.load();
  };

  /*
    Rendering
  */

  #renderRefund(){
    const { charge, refundable } = this.detail;
    if(!this.canRefund || !refundable) return nothing;
    return html`
      <form class="card mb" @submit=${this.refund}>
        <p class="mb"><strong>Refund</strong></p>
        <label class="d-b mb" for="amount">Amount (${charge.currency.toUpperCase()})
          <small class="d-b tc-muted">Up to ${formatMoney(refundable, charge.currency)}. It comes out of the recipient’s Stripe balance and goes back to whoever paid.</small>
          <input id="amount" type="text" inputmode="decimal" required .value=${this.form.amount} @input=${event => { this.form = { ...this.form, amount: event.target.value }; }} />
        </label>
        <label class="d-b mb" for="reason">Why
          <small class="d-b tc-muted">Optional. Kept on the payment’s record.</small>
          <input id="reason" type="text" maxlength="500" .value=${this.form.reason} @input=${event => { this.form = { ...this.form, reason: event.target.value }; }} />
        </label>
        ${charge.feeAmount - charge.feeRefunded > 0 ? html`
          <label class="checkbox mb">
            <input type="checkbox" .checked=${this.form.fee} @change=${event => { this.form = { ...this.form, fee: event.target.checked }; }} />
            Give back the site’s fee too
            <small class="d-b tc-muted">The site kept ${formatMoney(charge.feeAmount - charge.feeRefunded, charge.currency)}. Ticked, that is returned in proportion to the refund; unticked, the recipient pays the whole refund and the site keeps its fee.</small>
          </label>
        ` : nothing}
        <div class="d-f actions">
          <button class="danger" type="submit" ?disabled=${!!this.busy}>${this.busy === 'refund' ? 'Refunding…' : 'Refund'}</button>
        </div>
      </form>
    `;
  }

  render(){
    if(!this.detail) return this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : html`<k-spinner></k-spinner>`;
    const { charge, payment, refunds, recipient, payer } = this.detail;

    return html`
      <h2 class="mbq">${formatMoney(charge.amount, charge.currency)} to ${recipient?.name || recipient?.email || charge.recipientUserId}</h2>
      <p class="mb"><span class="tc-${chargeTone(charge)}"><strong>${chargeStatus(charge.status)}</strong></span>${charge.disputed ? html` · <span class="tc-danger"><k-icon name="warning"></k-icon> Disputed</span>` : nothing}</p>
      ${this.notice ? html`<p class="tc-success mb" role="status"><k-icon name="check_circle"></k-icon> ${this.notice}</p>` : nothing}
      ${this.error ? html`<p class="tc-danger mb" role="alert">${this.error}</p>` : nothing}
      ${charge.feeCapPending > 0 ? html`<p class="tc-warning mb">${formatMoney(charge.feeCapPending, charge.currency)} of the fee is over the cap for this reference and is still to be given back to the recipient. Check with Stripe to try again.</p>` : nothing}

      <div class="d-f actions mb">
        <button ?disabled=${!!this.busy} @click=${this.sync}><k-icon name="replay"></k-icon> ${this.busy === 'sync' ? 'Checking…' : 'Check with Stripe'}</button>
        ${recipient ? html`<a class="btn" href="${ACCOUNTS}?tab=charges&owner=${encodeURIComponent(charge.referenceOwner)}&ref=${encodeURIComponent(charge.referenceId)}">Everything for this reference</a>` : nothing}
      </div>

      <dl class="facts mb">
        <dt>For</dt><dd>${charge.description || '—'}</dd>
        <dt>Reference</dt><dd>${charge.referenceOwner} · ${charge.referenceId}</dd>
        <dt>Paid to</dt><dd>${recipient ? html`${recipient.name} (${recipient.email})` : charge.recipientUserId} — Stripe account <span class="ff-mono">${charge.accountId}</span></dd>
        <dt>Paid by</dt><dd>${payer ? `${payer.name} (${payer.email})` : payment?.customerEmail || 'A guest'}</dd>
        <dt>Site’s fee</dt><dd>${formatMoney(charge.feeAmount, charge.currency)}${charge.feeSource === 'caller' ? ' — set by the calling code' : charge.feeCap ? `, under a cap of ${formatMoney(charge.feeCap, charge.currency)} for this reference` : ''}${charge.feeRefunded ? `; ${formatMoney(charge.feeRefunded, charge.currency)} given back` : ''}</dd>
        <dt>Refunded</dt><dd>${formatMoney(charge.amountRefunded, charge.currency)}</dd>
        <dt>Started</dt><dd>${formatDateTime(charge.createdAt)}</dd>
        ${charge.succeededAt ? html`<dt>Paid</dt><dd>${formatDateTime(charge.succeededAt)}</dd>` : nothing}
        ${payment ? html`<dt>Payment</dt><dd><span class="ff-mono">${payment.providerRef}</span>${payment.livemode ? '' : ' (test mode)'}</dd>` : nothing}
      </dl>

      ${this.#renderRefund()}

      ${refunds.length ? html`
        <h3>Refunds</h3>
        <div class="table-wrapper">
          <table>
            <thead><tr><th>When</th><th class="ta-right">Amount</th><th>Status</th><th>Why</th></tr></thead>
            <tbody>
              ${refunds.map(refund => html`
                <tr>
                  <td class="tc-muted">${formatDateTime(refund.createdAt)}</td>
                  <td class="ta-right">${formatMoney(refund.amount, refund.currency)}</td>
                  <td>${refund.status}</td>
                  <td>${refund.reason || ''}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      ` : nothing}
    `;
  }

  static styles = css`
    :host { display: block; }
    .actions { gap: var(--spacer); align-items: center; }
    form input[type="text"] { max-width: 24rem; }
    .facts { display: grid; grid-template-columns: max-content 1fr; column-gap: var(--spacer); row-gap: var(--spacer_h); }
    .facts dt { color: var(--tc_muted); }
    .facts dd { margin: 0; }
  `;
}

customElements.define('k-payouts-charge', Charge);
