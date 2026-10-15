import * as stripe from '../server/providers/stripe.js';

/*
  How Stripe's answers become this extension's words — pure translation, no network. The shapes here
  are the ones Stripe actually returned in test mode (2026-10-15), not written from memory: a fixture
  that drifts from the real API is how a webhook path silently stops working.
*/

const refusals = {
  india: { type: 'StripeInvalidRequestError', code: 'cross_border_connected_account_creation_not_allowed', statusCode: 400, message: 'Connected accounts in IN cannot be created by platforms in US. Please contact us via https://support.stripe.com/contact if you need further assistance.' },
  malaysia: { type: 'StripeInvalidRequestError', statusCode: 400, message: 'You are trying to create an account link for a connected account in a country that Connect Onboarding does not yet support.' },
};

export default {
  'both ways Stripe refuses a country are recognised, and nothing else is': async ({ pass, fail }) => {
    if(!stripe.isCountryRefusal(refusals.india)) return fail('India’s refusal at creation was not recognised');
    if(!stripe.isCountryRefusal(refusals.malaysia)) return fail('Malaysia’s refusal at the onboarding link was not recognised');
    if(!stripe.isCountryRefusal({ statusCode: 400, param: 'identity.country', message: 'Invalid value' })) return fail('an invalid country parameter was not recognised');
    for(const error of [
      { statusCode: 400, message: 'contact_email is required' },
      { statusCode: 500, message: 'Something went wrong with country specs' },
      { statusCode: 401, message: 'Invalid API Key provided' },
      null,
    ]){
      if(stripe.isCountryRefusal(error)) return fail(`${JSON.stringify(error)} was taken for a country refusal`);
    }
    pass('');
  },

  'an account reads the same whichever API created it': async ({ pass, fail }) => {
    const account = stripe.fromAccount({
      id: 'acct_1', country: 'gb', default_currency: 'gbp', charges_enabled: true, payouts_enabled: false, details_submitted: true,
      controller: { stripe_dashboard: { type: 'full' }, fees: { payer: 'account' }, losses: { payments: 'stripe' } },
      requirements: { past_due: ['external_account'], currently_due: ['external_account', 'individual.verification.document'], disabled_reason: 'requirements.past_due', current_deadline: 1760000000 },
    });
    if(account.country !== 'GB' || account.defaultCurrency !== 'gbp') return fail('the country or currency was lost');
    if(account.feesCollector !== 'stripe' || account.lossesCollector !== 'stripe' || account.dashboard !== 'full') return fail(`the setup read as ${account.dashboard}/${account.feesCollector}/${account.lossesCollector}`);
    if(account.requirementsDue.join() !== 'external_account,individual.verification.document') return fail(`requirements: ${account.requirementsDue}`);
    if(!(account.requirementsDeadline instanceof Date)) return fail('the deadline is not a date');
    const legacy = stripe.fromAccount({ id: 'acct_2', controller: { fees: { payer: 'application_express' }, losses: { payments: 'application' } } });
    if(legacy.feesCollector !== 'application_express') return fail('a legacy Express account lost what it is');
    pass('');
  },

  'every Connect event the settings screen lists is one this code does something with': async ({ pass, fail }) => {
    for(const type of stripe.webhookEvents){
      const interpreted = stripe.interpretEvent({ type, account: 'acct_1', data: { object: { id: 'x', object: type.startsWith('account.') ? 'account' : 'other' } } });
      if(interpreted.kind === 'ignored') return fail(`${type} is on the list but nothing acts on it`);
    }
    if(stripe.interpretEvent({ type: 'customer.created', account: 'acct_1', data: { object: {} } }).kind !== 'ignored') return fail('an unrelated event is acted on');
    pass(`${stripe.webhookEvents.length} events`);
  },

  'each kind of Connect event says which account it is about': async ({ pass, fail }) => {
    const updated = stripe.interpretEvent({ type: 'account.updated', account: 'acct_1', data: { object: { id: 'acct_1', object: 'account', charges_enabled: true, payouts_enabled: true } } });
    if(updated.kind !== 'account' || updated.accountId !== 'acct_1' || !updated.snapshot?.chargesEnabled) return fail(`account.updated: ${JSON.stringify(updated)}`);
    const capability = stripe.interpretEvent({ type: 'capability.updated', data: { object: { id: 'card_payments', account: 'acct_2' } } });
    if(capability.accountId !== 'acct_2' || capability.snapshot !== null) return fail(`capability.updated: ${JSON.stringify(capability)}`);
    const gone = stripe.interpretEvent({ type: 'account.application.deauthorized', account: 'acct_3', data: { object: { id: 'ca_1', object: 'application' } } });
    if(gone.kind !== 'deauthorized' || gone.accountId !== 'acct_3') return fail(`deauthorized: ${JSON.stringify(gone)}`);
    const payout = stripe.interpretEvent({ type: 'payout.failed', account: 'acct_4', data: { object: { failure_code: 'account_closed' } } });
    if(payout.kind !== 'payout_failed' || payout.message !== 'account_closed') return fail(`payout.failed: ${JSON.stringify(payout)}`);
    const payment = stripe.interpretEvent({ type: 'charge.dispute.created', account: 'acct_5', data: { object: {} } });
    if(payment.kind !== 'payment') return fail('a dispute is not handed to kempo-payments');
    pass('');
  },

  'the two account setups are what Stripe allows, and the chosen one is one of them': async ({ pass, fail }) => {
    const express = stripe.ACCOUNT_SETUPS.express;
    const full = stripe.ACCOUNT_SETUPS.full;
    if(express.dashboard !== 'express' || express.feesCollector !== 'application' || express.lossesCollector !== 'application') return fail(`express is ${JSON.stringify(express)}`);
    if(full.dashboard !== 'full' || full.feesCollector !== 'stripe' || full.lossesCollector !== 'stripe') return fail(`full is ${JSON.stringify(full)}`);
    if(!stripe.ACCOUNT_SETUPS[stripe.ACCOUNT_SETUP]) return fail(`ACCOUNT_SETUP is ${stripe.ACCOUNT_SETUP}`);
    /*
      The owner's decision (2026-10-15): recipients pay Stripe's processing fee and Stripe carries the
      losses. Switching back to express puts both on the site — change this assertion with eyes open.
    */
    if(stripe.ACCOUNT_SETUP !== 'full') return fail(`new accounts are set up as "${stripe.ACCOUNT_SETUP}", not the full Stripe Dashboard the owner chose`);
    pass(`new accounts: ${stripe.ACCOUNT_SETUP}`);
  },
};
