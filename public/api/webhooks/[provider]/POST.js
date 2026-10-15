import { signatureHeaderFor } from '../../../../server/providers/index.js';
import { receiveConnectWebhook } from '../../../../server/utils/webhooks/receive.js';

/*
  The Connect webhook — where Stripe reports what happened on recipients' accounts. No session: the
  caller is Stripe, and it authenticates by signing the request with this endpoint's own secret.

  **The raw body.** The signature covers the exact bytes sent, so it is checked against
  `request.text()`, never a re-serialised `request.body` — that has different whitespace and key order
  and would fail every time.

  **What counts as a failure.** A bad signature, or an event that could not be applied (a database
  that would not write, Stripe unreachable when an account had to be re-read): those answer non-2xx
  so Stripe sends the event again. Anything else — an event about an account this site never
  connected, a type nothing here acts on — is a 200, because redelivering it would change nothing.
*/
export default async (request, response) => {
  const provider = request.params?.provider;
  const header = signatureHeaderFor(provider);
  if(!header) return response.status(404).json({ error: 'No such payout provider' });

  const [error, result] = await receiveConnectWebhook({
    provider,
    payload: await request.text(),
    signature: request.headers[header] || null,
  });
  if(error) return response.status(error.code || 500).json({ error: error.msg });

  response.json({ received: true, ...result });
};
