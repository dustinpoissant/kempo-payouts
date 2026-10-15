import { listCharges } from '../../../server/utils/charges/store.js';
import { gate, refuse } from '../../../server/http/gate.js';

/*
  Every charge made to a recipient, newest first. Filters: `recipient` (a user id), `owner` and `ref`
  (the caller's reference — an event), and `status`, comma-separated.
*/
export default async (request, response) => {
  const [gateError] = await gate(request, 'payouts:view');
  if(gateError) return refuse(response, gateError);

  const query = request.query || {};
  const status = query.status ? String(query.status).split(',').map(value => value.trim()).filter(Boolean) : undefined;
  const [error, result] = await listCharges({ recipientUserId: query.recipient, owner: query.owner, ref: query.ref, status, limit: query.limit, offset: query.offset });
  if(error) return refuse(response, error);
  response.json(result);
};
