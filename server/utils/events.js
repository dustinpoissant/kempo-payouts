import { triggerHook } from 'kempo/server/sdk.js';
import { OWNER } from './owner.js';

/*
  The hooks this extension fires, in notification mode: every handler runs, a handler that throws is
  logged and stops nothing, and nothing a handler does can undo what it is hearing about. Each fires
  after the change is written, so a handler that reads the row sees the new state.

  Consumers register handlers in their own kempo-config.json `hooks` — Crowd Pulse shows a tip on the
  DJ's screen from `payouts:charge-succeeded`, and turns its Tips feature off from
  `payouts:account-updated` when an account can no longer receive.
*/
export const EVENTS = [
  'payouts:account-updated',  // { account, previous, canReceive } — connected, set up, restricted, disconnected
  'payouts:charge-succeeded', // { charge, payment } — the money is in the recipient's account
  'payouts:charge-refunded',  // { charge, payment, refund } — some or all of it given back
  'payouts:charge-disputed',  // { charge, payment, disputed, reason } — a chargeback opened, or closed
];

export const fire = async (event, data) => {
  const [error] = await triggerHook(event, data);
  if(error) console.warn(`[${OWNER}] Could not fire ${event}: ${error.msg}`);
};
