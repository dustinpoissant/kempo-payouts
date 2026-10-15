import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css, nothing } from '/kempo-ui/lit-all.min.js';
import { getCountries, getSettings, refreshCountries, retryCountry, saveSettings } from '/payouts/sdk.js';
import { formatDateTime, formatMoney, parseMoney, toMajor } from '/payouts/utils/format.js';

/*
  The site's fee, its cap, the countries payouts are offered in, and the Connect webhook.

  The countries are Stripe's list — fetched, never typed in — and the choice here can only narrow it:
  "Every country Stripe supports" or a ticked subset. A country Stripe cannot take payments to in the
  site's currency, or refused an account in, is shown with why and cannot be ticked.

  The webhook secret is never shown; its field is always empty and saving with it empty leaves the
  stored one alone.

    <k-payouts-settings></k-payouts-settings>
*/

const SETUPS = {
  express: 'New recipients get the Stripe Express Dashboard. Stripe only allows that when this site collects Stripe’s fees and carries the losses: on every payment to a recipient Stripe bills this site the card processing fee (the fee percentage has to cover it), dispute fees and Connect’s monthly and per-payout fees, this site files the recipients’ 1099s, and a negative balance a recipient cannot repay is this site’s.',
  full: 'New recipients get the full Stripe Dashboard. Stripe collects its fees from them and carries the losses: this site keeps exactly its fee, pays no Connect fees, and Stripe files the recipients’ 1099-Ks.',
};

export default class Settings extends ShadowComponent {
  static properties = {
    data: { type: Object, state: true },
    countries: { type: Array, state: true },
    fetchedAt: { type: String, state: true },
    form: { type: Object, state: true },
    narrow: { type: Boolean, state: true },
    busy: { type: String, state: true },
    notice: { type: String, state: true },
    error: { type: String, state: true },
  };

  constructor(){
    super();
    this.data = null;
    this.countries = [];
    this.fetchedAt = null;
    this.form = { percent: '', cap: '', allowed: new Set(), secret: '' };
    this.narrow = false;
    this.busy = '';
    this.notice = '';
    this.error = '';
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
    const [[error, data], [, countries]] = await Promise.all([getSettings(), getCountries()]);
    if(error){
      this.error = error.msg;
      return;
    }
    this.data = data;
    this.countries = countries?.countries || [];
    this.fetchedAt = countries?.fetchedAt || null;
    const { settings } = data;
    this.narrow = settings.allowedCountries.length > 0;
    this.form = {
      percent: String(settings.feePercent),
      cap: settings.feeCap ? toMajor(settings.feeCap, settings.currency) : '',
      allowed: new Set(settings.allowedCountries),
      secret: '',
    };
  };

  /*
    Actions
  */

  save = async event => {
    event.preventDefault();
    const { currency } = this.data.settings;
    const cap = this.form.cap.trim() ? parseMoney(this.form.cap, currency) : 0;
    if(cap === null){
      this.error = `Enter the cap as an amount, such as 50.00, or leave it empty for no cap`;
      return;
    }
    if(this.narrow && !this.form.allowed.size){
      this.error = 'Tick at least one country, or choose every country Stripe supports';
      return;
    }

    this.busy = 'save';
    const [error] = await saveSettings({
      fee_percent: this.form.percent,
      fee_cap: cap,
      allowed_countries: this.narrow ? [...this.form.allowed].join(',') : '',
      ...(this.form.secret.trim() ? { connect_webhook_secret: this.form.secret.trim() } : {}),
    });
    this.busy = '';
    if(error){
      this.error = error.msg;
      return;
    }
    this.error = '';
    this.notice = 'Saved.';
    this.load();
  };

  clearSecret = async () => {
    this.busy = 'clear';
    const [error] = await saveSettings({ connect_webhook_secret: null });
    this.busy = '';
    this.error = error?.msg || '';
    this.notice = error ? '' : 'The webhook secret was removed.';
    this.load();
  };

  refresh = async () => {
    this.busy = 'refresh';
    const [error, result] = await refreshCountries();
    this.busy = '';
    this.error = error?.msg || '';
    this.notice = error ? '' : `Stripe’s list fetched: ${result.count} countries.`;
    this.load();
  };

  retry = async code => {
    const [error] = await retryCountry(code);
    this.error = error?.msg || '';
    this.load();
  };

  toggle = (code, on) => {
    const allowed = new Set(this.form.allowed);
    if(on) allowed.add(code);
    else allowed.delete(code);
    this.form = { ...this.form, allowed };
  };

  /*
    Rendering
  */

  #renderCountries(){
    const supported = this.countries.filter(country => country.stripeSupports);
    const unsupported = this.countries.filter(country => !country.stripeSupports);
    return html`
      <h3>Countries</h3>
      <small class="d-b tc-muted mb">Stripe’s list, fetched ${this.fetchedAt ? formatDateTime(this.fetchedAt) : 'never'}. A recipient chooses their country once, when they connect.</small>
      ${!this.countries.length ? html`<p class="tc-warning mb">Stripe’s list has not been fetched yet, so nobody can connect. Connect Stripe on the Payments screen, then fetch it.</p>` : html`
        <label class="checkbox mb">
          <input type="radio" name="scope" .checked=${!this.narrow} @change=${() => { this.narrow = false; }} />
          Every country Stripe supports for this (${supported.length})
        </label>
        <label class="checkbox mb">
          <input type="radio" name="scope" .checked=${this.narrow} @change=${() => { this.narrow = true; }} />
          Only the countries ticked below
        </label>
        ${this.narrow ? html`
          <div class="countries mb">
            ${supported.map(country => html`
              <label class="checkbox">
                <input type="checkbox" .checked=${this.form.allowed.has(country.code)} @change=${event => this.toggle(country.code, event.target.checked)} />
                ${country.name}${country.converts ? html` <span class="tc-muted">(${country.defaultCurrency.toUpperCase()})</span>` : nothing}
              </label>
            `)}
          </div>
        ` : nothing}
        ${unsupported.length ? html`
          <details class="mb">
            <summary>${unsupported.length} countr${unsupported.length === 1 ? 'y' : 'ies'} on Stripe’s list cannot be offered</summary>
            <ul>
              ${unsupported.map(country => html`<li>${country.name}: ${country.reason}${country.refused ? html` <button type="button" @click=${() => this.retry(country.code)}>Try again</button>` : nothing}</li>`)}
            </ul>
          </details>
        ` : nothing}
      `}
      <div class="mb">
        <button type="button" ?disabled=${!!this.busy} @click=${this.refresh}><k-icon name="replay"></k-icon> ${this.busy === 'refresh' ? 'Fetching…' : 'Fetch Stripe’s list again'}</button>
      </div>
    `;
  }

  #renderWebhook(){
    const { status, webhook, encryptionConfigured } = this.data;
    return html`
      <h3>Connect webhook</h3>
      <p class="mb">
        Stripe reports what happens on recipients’ accounts — set up, restricted, paid, refunded — to a
        webhook of its own. In Stripe, open Developers → Webhooks, add an endpoint that listens to
        <strong>events on connected accounts</strong>, and paste its signing secret below.
        ${status?.hasWebhookSecret ? html`<span class="tc-success"><k-icon name="check_circle"></k-icon> A secret is saved.</span>` : html`<span class="tc-danger"><k-icon name="warning"></k-icon> No secret yet: no recipient will ever become ready to be paid.</span>`}
      </p>
      <label class="d-b mb" for="url">Endpoint URL
        <small class="d-b tc-muted">Paste this into Stripe as the endpoint URL.</small>
        <input id="url" type="text" readonly .value=${webhook.url} />
      </label>
      <details class="mb">
        <summary>The ${webhook.events.length} events to send it</summary>
        <ul class="ff-mono events">${webhook.events.map(event => html`<li>${event}</li>`)}</ul>
      </details>
      <label class="d-b mb" for="secret">Signing secret
        <small class="d-b tc-muted">Begins whsec_. Never shown again once saved; leave empty to keep the one saved.${encryptionConfigured ? '' : ' SETTINGS_ENCRYPTION_KEY is not set on this server, so it cannot be saved.'}</small>
        <input id="secret" type="password" autocomplete="off" placeholder=${status?.hasWebhookSecret ? '•••••••• (saved)' : 'whsec_…'} .value=${this.form.secret} @input=${event => { this.form = { ...this.form, secret: event.target.value }; }} />
      </label>
      ${status?.hasWebhookSecret ? html`<div class="mb"><button type="button" ?disabled=${!!this.busy} @click=${this.clearSecret}>Remove the saved secret</button></div>` : nothing}
    `;
  }

  render(){
    if(!this.data) return this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : html`<k-spinner></k-spinner>`;
    const { settings, status } = this.data;

    return html`
      ${status && !status.configured ? html`<p class="tc-warning mb"><k-icon name="warning"></k-icon> Stripe is not connected. Add the secret key on the Payments screen first — payouts use the same Stripe account.</p>` : nothing}
      <form @submit=${this.save}>
        <h3>Fee</h3>
        <div class="d-f fields">
          <label class="mb" for="percent">Fee (%)
            <small class="d-b tc-muted">Kept from each payment to a user. 0 takes none; up to two decimal places.</small>
            <input id="percent" type="text" inputmode="decimal" required .value=${this.form.percent} @input=${event => { this.form = { ...this.form, percent: event.target.value }; }} />
          </label>
          <label class="mb" for="cap">Most per recipient, per reference (${settings.currency.toUpperCase()})
            <small class="d-b tc-muted">The most fee kept from one person for one reference, such as an event. Empty for no cap.</small>
            <input id="cap" type="text" inputmode="decimal" placeholder="No cap" .value=${this.form.cap} @input=${event => { this.form = { ...this.form, cap: event.target.value }; }} />
          </label>
        </div>
        ${settings.feeCap && settings.feePercent ? html`<p class="tc-muted mb">At ${settings.feePercent}%, the cap of ${formatMoney(settings.feeCap, settings.currency)} is reached after ${formatMoney(Math.ceil(settings.feeCap * 100 / (settings.feePercent || 100)), settings.currency)} of payments to one person for one reference.</p>` : nothing}
        <p class="tc-muted mb">Payments to users are made in ${settings.currency.toUpperCase()}, the site’s currency (kempo-products’ currency setting, or kempo-payments’ if that is not installed).</p>

        ${this.#renderCountries()}
        ${this.#renderWebhook()}

        <h3>How recipients’ accounts are set up</h3>
        <p class="mb">${SETUPS[status?.accountSetup] || 'Unknown.'}</p>
        <small class="d-b tc-muted mb">Fixed by Stripe when each account is created; see the README’s “Who pays and who is liable”.</small>

        ${this.error ? html`<p class="tc-danger mb" role="alert">${this.error}</p>` : nothing}
        ${this.notice ? html`<p class="tc-success mb" role="status"><k-icon name="check_circle"></k-icon> ${this.notice}</p>` : nothing}
        <div class="d-f actions mb">
          <button class="primary" type="submit" ?disabled=${!!this.busy}>${this.busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    `;
  }

  static styles = css`
    :host { display: block; }
    .actions { gap: var(--spacer); align-items: center; }
    .fields { gap: 0 var(--spacer); }
    .fields label { flex: 1 1 16rem; max-width: 30rem; }
    .events { overflow-wrap: anywhere; }
    input[type="text"], input[type="password"] { max-width: 32rem; }
    .countries { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--spacer_q) var(--spacer); }
  `;
}

customElements.define('k-payouts-settings', Settings);
