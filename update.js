import { createIndexes } from './server/db/indexes.js';

/*
  Updating makes sure the indexes exist — every statement is `IF NOT EXISTS`, so this is safe from any
  version to any other — and nothing else. In particular it never gives `payouts:connect` to anybody:
  install.js does that once, on a site's first install, and a site that took it away keeps it away.
*/
export default async () => {
  await createIndexes();
};
