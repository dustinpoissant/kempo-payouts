import { getSession, currentUserHasPermission } from 'kempo/server/sdk.js';

/*
  The HTTP layer's own helpers — who is asking, are they allowed, and where is this site. They live
  here rather than in server/utils because they read requests, and nothing under server/utils does.

  Routes come in three kinds, and each says which it is by what it calls:

  - **Your own** (`/payouts/api/my/…`): the signed-in user's own payout account and the charges made
    to it. They need `payouts:connect`, which every signed-in user holds after a first install, and
    the user id comes from the session — never the request.
  - **Administrative**: every other route, each with its own `payouts:*` permission.
  - **The Connect webhook**: no session; Stripe authenticates by signing the request.

  There is no route that starts a payment to a user: the amount would be in the request body, and
  only the consumer's own server knows what a payment is for. Consumers call the SDK.
*/

export const requireSession = async request => {
  const token = request.cookies?.session_token;
  if(!token) return [{ code: 401, msg: 'Sign in first' }, null];

  const [error, session] = await getSession({ token });
  if(error || !session?.user) return [{ code: 401, msg: 'Sign in first' }, null];

  return [null, { token, user: session.user }];
};

export const gate = async (request, permission) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return [sessionError, null];

  const [error, allowed] = await currentUserHasPermission(session.token, permission);
  if(error) return [{ code: error.code, msg: error.msg }, null];
  if(!allowed) return [{ code: 403, msg: 'You do not have permission to do that' }, null];

  return [null, session];
};

export const refuse = (response, { code, msg }) => response.status(code || 500).json({ error: msg });

/* A whole number from a JSON body or a query string, or undefined when there is none. */
export const wholeNumber = value => {
  if(value === undefined || value === null || value === '') return undefined;
  if(typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
};

/*
  The address this site was reached at, for the links Stripe sends somebody back to after onboarding.
  Taken from the request: the only person a forged Host header could misdirect is the one sending it.
*/
export const origin = request => {
  const headers = request.headers || {};
  const protocol = String(headers['x-forwarded-proto'] || '').split(',')[0].trim() || (request.socket?.encrypted ? 'https' : 'http');
  return `${protocol}://${headers.host}`;
};
