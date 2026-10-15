import { refreshCountries } from '../../../../server/utils/countries.js';
import { gate, refuse } from '../../../../server/http/gate.js';

/* Asks Stripe for its list of countries again. Countries Stripe refused an account in stay refused. */
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:settings');
  if(gateError) return refuse(response, gateError);

  const [error, result] = await refreshCountries();
  if(error) return refuse(response, error);
  response.json(result);
};
