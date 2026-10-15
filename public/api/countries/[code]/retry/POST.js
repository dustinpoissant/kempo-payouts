import { clearRefusal } from '../../../../../server/utils/countries.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  Offers a country again after Stripe refused to open an account there. The next person to choose it
  is sent to Stripe, and Stripe's answer is the final word again.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:settings');
  if(gateError) return refuse(response, gateError);

  const [error, country] = await clearRefusal(request.params?.code);
  if(error) return refuse(response, error);
  response.json({ country });
};
