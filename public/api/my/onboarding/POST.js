import { createOnboardingLink } from '../../../../server/utils/accounts/connect.js';
import { gate, origin, refuse } from '../../../../server/http/gate.js';

/*
  Starts (or continues) the signed-in user's onboarding with Stripe and answers with the address to
  send them to. `country` is needed only the first time. Stripe sends them back to the Get paid page
  either way — `?onboarding=refresh` when their link expired, which simply asks for a new one.
*/
export default async (request, response) => {
  const [gateError, session] = await gate(request, 'payouts:connect');
  if(gateError) return refuse(response, gateError);

  const page = `${origin(request)}/payouts/`;
  const [error, link] = await createOnboardingLink({
    userId: session.user.id,
    country: request.body?.country,
    returnUrl: `${page}?onboarding=return`,
    refreshUrl: `${page}?onboarding=refresh`,
  });
  if(error) return refuse(response, error);
  response.json(link);
};
