import { and, eq, sql } from 'drizzle-orm';
import { groupPermission, permission } from 'kempo/server/db/schema.js';
import install from '../install.js';
import update from '../update.js';
import uninstall from '../uninstall.js';
import { INDEXES } from '../server/db/indexes.js';
import { kempoPayoutAccount } from '../server/db/schema.js';
import { db, seedDatabase } from './helpers/db.js';
import { freshUser, purge, seedAccount, seedCharge } from './helpers/fixtures.js';

/*
  What kempo runs when this extension is installed, updated and removed.

  The test database already has every index — drizzle made them from the schema — which is exactly
  why a mistake in install.js would never show. So they are dropped first, and install.js has to put
  them back; the unique ones are then proved to hold by trying to break them.

  And `payouts:connect`: given to every user on a first install, never again.
*/

const existingIndexes = async () => new Set((await db.execute(sql`select indexname from pg_indexes where tablename like 'kempoPayout%'`)).map(row => row.indexname));

const quietly = async run => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

const usersCanConnect = async () => (await db.select().from(groupPermission).where(and(eq(groupPermission.groupName, 'system:Users'), eq(groupPermission.permissionName, 'payouts:connect')))).length > 0;

const forgetPermission = async () => {
  await db.delete(groupPermission).where(eq(groupPermission.permissionName, 'payouts:connect'));
  await db.delete(permission).where(eq(permission.name, 'payouts:connect'));
};

export const beforeAll = async () => {
  await seedDatabase();
  await purge();
};

export const afterAll = async () => {
  await quietly(install);
  await purge();
};

export default {
  'install creates every index, and the unique ones hold': async ({ pass, fail }) => {
    for(const { name } of INDEXES) await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
    const before = await existingIndexes();
    if(INDEXES.some(({ name }) => before.has(name))) return fail('the indexes were not dropped, so this proves nothing');

    await quietly(install);
    const after = await existingIndexes();
    const missing = INDEXES.filter(({ name }) => !after.has(name)).map(({ name }) => name);
    if(missing.length) return fail(`install did not create ${missing.join(', ')}`);

    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    try {
      await seedAccount({ userId: person.id });
      return fail('a second payout account for one user was accepted');
    } catch {}
    try {
      await db.insert(kempoPayoutAccount).values({ ...account, id: 'pac_other', userId: 'somebody-else' });
      return fail('two users were given the same Stripe account');
    } catch {}
    const { charge } = await seedCharge({ account });
    try {
      await seedCharge({ account }).then(async ({ charge: other }) => db.execute(sql`update "kempoPayoutCharge" set "idempotencyKey" = ${charge.idempotencyKey} where "id" = ${other.id}`));
      return fail('two charges were given one idempotency key');
    } catch {}
    await purge();
    pass('');
  },

  'a first install lets every user connect; a reinstall on a site that took it away does not': async ({ pass, fail }) => {
    await forgetPermission();
    await quietly(install);
    if(!await usersCanConnect()) return fail('a first install did not give system:Users payouts:connect');

    // The site takes it away, and the extension is reinstalled (its permission row is left behind).
    await db.delete(groupPermission).where(eq(groupPermission.permissionName, 'payouts:connect'));
    await quietly(install);
    if(await usersCanConnect()) return fail('reinstalling gave payouts:connect back to a site that took it away');

    await quietly(update);
    if(await usersCanConnect()) return fail('an update gave payouts:connect back');

    await forgetPermission();
    await quietly(install);
    pass('');
  },

  'update is safe to run any number of times': async ({ pass, fail }) => {
    await quietly(update);
    await quietly(update);
    const indexes = await existingIndexes();
    if(INDEXES.some(({ name }) => !indexes.has(name))) return fail('an index went missing');
    pass('');
  },

  'uninstall deletes nothing, and says what is at stake': async ({ pass, fail }) => {
    await purge();
    const person = await freshUser('DJ');
    const account = await seedAccount({ userId: person.id });
    await seedCharge({ account, amount: 1000, fee: 50, status: 'succeeded' });

    const lines = [];
    const { log, warn } = console;
    console.log = message => lines.push(String(message));
    console.warn = message => lines.push(String(message));
    try {
      await uninstall();
    } finally {
      console.log = log;
      console.warn = warn;
    }
    if(!lines.some(line => /1 connected payout account/.test(line) && /50 USD/.test(line))) return fail(`it said: ${lines.join(' | ')}`);
    const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(kempoPayoutAccount);
    if(count !== 1) return fail('uninstall deleted accounts');
    await purge();
    pass('');
  },
};
