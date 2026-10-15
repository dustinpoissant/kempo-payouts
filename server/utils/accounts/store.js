import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { user } from 'kempo/server/db/schema.js';
import { kempoPayoutAccount } from '../../db/schema.js';
import newId from '../ids.js';
import { hasNulByte } from '../validate.js';

/*
  Every read and write of the account rows, and nothing else — no processor calls, no hooks.
*/

const isUniqueViolation = error => (error?.code || error?.cause?.code) === '23505';

const one = async (where, label = 'No payout account') => {
  try {
    const [row] = await db.select().from(kempoPayoutAccount).where(where).limit(1);
    if(!row) return [{ code: 404, msg: label }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not load the payout account' }, null];
  }
};

export const accountForUser = userId => one(eq(kempoPayoutAccount.userId, userId), 'This user has not connected a payout account');

export const accountById = id => one(eq(kempoPayoutAccount.id, id));

export const accountForProvider = (provider, providerAccountId) => one(and(eq(kempoPayoutAccount.provider, provider), eq(kempoPayoutAccount.providerAccountId, providerAccountId)));

/*
  Claims a user's one account row before anything is asked of the processor. The unique index on the
  user is what stops a double click creating two processor accounts for one person: the second claim
  fails here, before it can cost anything.
*/
export const reserveAccount = async ({ userId, provider, country }) => {
  const now = new Date();
  const row = {
    id: newId('pac'),
    userId,
    provider,
    providerAccountId: `pending:${newId('res')}`,
    status: 'creating',
    country,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(kempoPayoutAccount).values(row);
    return [null, row];
  } catch(error) {
    if(isUniqueViolation(error)) return [{ code: 409, msg: 'A payout account is already being set up for you — try again in a moment' }, null];
    return [{ code: 500, msg: 'Could not record the payout account' }, null];
  }
};

/*
  The same claim for a user whose earlier account was disconnected: their row is reused for the new
  processor account (one row per user), and only one request at a time can take it from
  `disconnected` to `creating`. Their earlier charges keep pointing at the account they were paid to.
*/
export const reclaimDisconnected = async (id, country) => {
  try {
    const [row] = await db.update(kempoPayoutAccount)
      .set({ status: 'creating', country, updatedAt: new Date() })
      .where(and(eq(kempoPayoutAccount.id, id), eq(kempoPayoutAccount.status, 'disconnected')))
      .returning();
    if(!row) return [{ code: 409, msg: 'A payout account is already being set up for you — try again in a moment' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not update the payout account' }, null];
  }
};

export const restoreDisconnected = async id => {
  try {
    await db.update(kempoPayoutAccount).set({ status: 'disconnected', updatedAt: new Date() }).where(and(eq(kempoPayoutAccount.id, id), eq(kempoPayoutAccount.status, 'creating')));
  } catch {
    // The caller is already returning the failure that made this necessary.
  }
};

/* Forgets an account row outright — one whose processor account turned out to be unusable. */
export const deleteAccountRow = async id => {
  try {
    await db.delete(kempoPayoutAccount).where(eq(kempoPayoutAccount.id, id));
  } catch {
    // Nothing more to do: the caller is already returning the refusal that made this necessary.
  }
};

export const releaseAccount = async id => {
  try {
    await db.delete(kempoPayoutAccount).where(and(eq(kempoPayoutAccount.id, id), eq(kempoPayoutAccount.status, 'creating')));
  } catch {
    // The caller is already returning the failure that made this necessary.
  }
};

export const updateAccount = async (id, changes) => {
  try {
    const [row] = await db.update(kempoPayoutAccount).set({ ...changes, updatedAt: new Date() }).where(eq(kempoPayoutAccount.id, id)).returning();
    if(!row) return [{ code: 404, msg: 'No payout account' }, null];
    return [null, row];
  } catch(error) {
    if(isUniqueViolation(error)) return [{ code: 409, msg: 'That processor account already belongs to another user' }, null];
    return [{ code: 500, msg: 'Could not update the payout account' }, null];
  }
};

/*
  The admin list: newest first, filtered by status, and searchable by the user's name or email or the
  processor's account id — the three things an administrator is likely to have in hand.
*/
export const listAccounts = async ({ status, search, limit = 50, offset = 0 } = {}) => {
  if(hasNulByte(status, search)) return [{ code: 400, msg: 'Filters cannot contain null characters' }, null];

  const conditions = [];
  const statuses = Array.isArray(status) ? status : status ? [status] : [];
  if(statuses.length) conditions.push(inArray(kempoPayoutAccount.status, statuses));
  if(search && String(search).trim()){
    const term = `%${String(search).trim().replace(/[\\%_]/g, character => `\\${character}`)}%`;
    conditions.push(or(ilike(user.name, term), ilike(user.email, term), ilike(kempoPayoutAccount.providerAccountId, term), eq(kempoPayoutAccount.userId, String(search).trim())));
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const take = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);

  try {
    const rows = await db.select({ account: kempoPayoutAccount, name: user.name, email: user.email })
      .from(kempoPayoutAccount)
      .leftJoin(user, eq(user.id, kempoPayoutAccount.userId))
      .where(where)
      .orderBy(desc(kempoPayoutAccount.createdAt))
      .limit(take)
      .offset(skip);
    const [counted] = await db.select({ total: sql`count(*)::int` })
      .from(kempoPayoutAccount)
      .leftJoin(user, eq(user.id, kempoPayoutAccount.userId))
      .where(where);
    return [null, { accounts: rows.map(row => ({ ...row.account, user: { name: row.name, email: row.email } })), total: counted?.total ?? rows.length, limit: take, offset: skip }];
  } catch {
    return [{ code: 500, msg: 'Could not list payout accounts' }, null];
  }
};

export const countAccounts = async () => {
  try {
    const rows = await db.select({ status: kempoPayoutAccount.status, count: sql`count(*)::int` }).from(kempoPayoutAccount).groupBy(kempoPayoutAccount.status);
    return [null, Object.fromEntries(rows.map(row => [row.status, row.count]))];
  } catch {
    return [{ code: 500, msg: 'Could not count payout accounts' }, null];
  }
};
