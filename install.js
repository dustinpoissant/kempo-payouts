import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { group, groupPermission, permission } from 'kempo/server/db/schema.js';
import { createIndexes } from './server/db/indexes.js';

/*
  What kempo-config.json cannot say.

  **The indexes**, which kempo's installer does not make from the schema — see server/db/indexes.js.
  The unique ones are correctness guarantees, so if one cannot be made the install fails.

  **`payouts:connect` for every signed-in user, on the first install only.** Connecting your own
  payout account is something an ordinary member of the site does, so the permission is given to
  `system:Users` — but only when this extension has never been installed here before. kempo runs this
  script before it creates the declared permissions, so a permission row that already exists means an
  earlier install left it behind, and a site that took the permission away from its users must not
  have it handed back by reinstalling. update.js never grants it.
*/

const require = createRequire(import.meta.url);
const config = require('./kempo-config.json');
const CONNECT = 'payouts:connect';

const grantConnectOnFirstInstall = async () => {
  const [existing] = await db.select().from(permission).where(eq(permission.name, CONNECT)).limit(1);
  if(existing) return false;

  const [users] = await db.select().from(group).where(eq(group.name, 'system:Users')).limit(1);
  if(!users){
    console.warn('[kempo-payouts] There is no system:Users group, so nobody can connect a payout account until payouts:connect is given to a group.');
    return false;
  }

  const description = config.permissions.find(entry => entry.name === CONNECT)?.description || null;
  await db.insert(permission).values({ name: CONNECT, description, owner: 'kempo-payouts', createdAt: new Date() }).onConflictDoNothing();
  const [granted] = await db.select().from(groupPermission).where(and(eq(groupPermission.groupName, 'system:Users'), eq(groupPermission.permissionName, CONNECT))).limit(1);
  if(!granted) await db.insert(groupPermission).values({ id: randomUUID(), groupName: 'system:Users', permissionName: CONNECT, createdAt: new Date() });
  return true;
};

export default async () => {
  await createIndexes();
  const granted = await grantConnectOnFirstInstall();

  console.log([
    '[kempo-payouts] Installed.',
    granted ? '  Every signed-in user can now connect a payout account at /payouts/.' : '  payouts:connect was left as it was — this site has had kempo-payouts before.',
    '  Add a Connect webhook in Stripe pointing at /payouts/api/webhooks/stripe and paste its signing secret',
    '  at /admin/extension/kempo-payouts/ — without it no account ever becomes ready to be paid.',
  ].join('\n'));
};
