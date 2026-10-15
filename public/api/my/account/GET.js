import { getAccount } from '../../../../server/utils/accounts/connect.js';
import { availableCountries } from '../../../../server/utils/countries.js';
import { getProvider } from '../../../../server/providers/index.js';
import { readConfig } from '../../../../server/utils/config.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/*
  Everything the Get paid page needs: the signed-in user's payout account (or null), whether they can
  be paid, and — for somebody who has not connected yet — the countries they can choose from and
  what being paid in the site's currency means for them.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:connect');
  if(gateError) return refuse(response, gateError);

  const [error, account] = await getAccount({ userId: session.user.id });
  if(error) return refuse(response, error);

  const [countriesError, countries] = await availableCountries();
  const [, provider] = getProvider(account?.provider);
  const [, status] = provider ? await provider.status() : [null, null];
  const config = await readConfig();

  response.json({
    account,
    canReceive: !!account?.canReceive,
    currency: config.currency,
    countries: countries?.countries || [],
    countriesError: countriesError ? countriesError.msg : null,
    fee: { percent: config.feePercent, cap: config.feeCap || null },
    setup: status ? { dashboard: status.dashboard, feesCollector: status.feesCollector, mode: status.mode, configured: status.configured } : null,
  });
};
