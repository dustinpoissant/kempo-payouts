import { getProvider } from '../../../server/providers/index.js';
import { readConfig } from '../../../server/utils/config.js';
import { gate, origin, refuse } from '../../../server/http/gate.js';

/*
  Everything the settings screen shows, and not one character of a secret: the webhook secret comes
  back as whether it is set. Also the Connect endpoint to paste into Stripe, the events to subscribe
  it to, and how new recipients' accounts are set up — who pays Stripe's fees and who is liable.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:settings');
  if(gateError) return refuse(response, gateError);

  const config = await readConfig();
  const [, provider] = getProvider();
  const [, status] = await provider.status();

  response.json({
    settings: config,
    status,
    webhook: { url: `${origin(request)}${provider.webhookPath}`, events: provider.webhookEvents },
    encryptionConfigured: !!process.env.SETTINGS_ENCRYPTION_KEY,
  });
};
