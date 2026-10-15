import { getBalance } from '../../../../../server/utils/accounts/connect.js';
import { accountById } from '../../../../../server/utils/accounts/store.js';
import { gate, refuse } from '../../../../../server/http/gate.js';

/*
  One account's balance at Stripe, asked live. On an account the site is liable for, a negative
  balance the recipient cannot repay becomes the site's — this is where an administrator sees it.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const [error, account] = await accountById(request.params?.id);
  if(error) return refuse(response, error);

  const [balanceError, balance] = await getBalance({ userId: account.userId });
  if(balanceError) return refuse(response, balanceError);
  response.json({ balance });
};
