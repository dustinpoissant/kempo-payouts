import { availableCountries } from '../../../server/utils/countries.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  Every country on Stripe's list as last fetched, each with whether it is offered and, if not, why —
  the settings screen's country picker. Never fetches: "Refresh from Stripe" is its own route.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:settings');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await availableCountries({ fetch: false });
  if(error) return refuse(response, error);
  response.json({ currency: result.currency, countries: result.all, fetchedAt: result.fetchedAt });
};
