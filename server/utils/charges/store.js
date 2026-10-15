import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { user } from 'kempo/server/db/schema.js';
import { kempoPayoutCharge } from '../../db/schema.js';
import newId from '../ids.js';
import { hasNulByte } from '../validate.js';

/*
  Every read and write of the charge rows, and nothing else — no processor calls, no hooks.
*/

const isUniqueViolation = error => (error?.code || error?.cause?.code) === '23505';

const one = async where => {
  try {
    const [row] = await db.select().from(kempoPayoutCharge).where(where).limit(1);
    if(!row) return [{ code: 404, msg: 'No such charge' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not load the charge' }, null];
  }
};

export const chargeById = id => one(eq(kempoPayoutCharge.id, id));

export const chargeForPayment = paymentId => one(eq(kempoPayoutCharge.paymentId, paymentId));

export const chargeForKey = key => one(eq(kempoPayoutCharge.idempotencyKey, key));

/*
  Claims the idempotency key before any payment exists. The unique index on the key is what makes a
  retried request create one payment rather than two: a second claim with the same key fails here,
  and the caller is given the first one instead.
*/
export const reserveCharge = async values => {
  const now = new Date();
  const row = { id: newId('pch'), paymentId: null, status: 'creating', amountRefunded: 0, feeRefunded: 0, feeCapPending: 0, disputed: false, createdAt: now, updatedAt: now, ...values };
  try {
    await db.insert(kempoPayoutCharge).values(row);
    return [null, row];
  } catch(error) {
    if(isUniqueViolation(error)) return [{ code: 409, msg: 'duplicate', duplicate: true }, null];
    return [{ code: 500, msg: 'Could not record the charge' }, null];
  }
};

export const releaseCharge = async id => {
  try {
    await db.delete(kempoPayoutCharge).where(and(eq(kempoPayoutCharge.id, id), eq(kempoPayoutCharge.status, 'creating')));
  } catch {
    // The caller is already returning the failure that made this necessary.
  }
};

export const updateCharge = async (id, changes, executor = db) => {
  try {
    const [row] = await executor.update(kempoPayoutCharge).set({ ...changes, updatedAt: new Date() }).where(eq(kempoPayoutCharge.id, id)).returning();
    if(!row) return [{ code: 404, msg: 'No such charge' }, null];
    return [null, row];
  } catch {
    return [{ code: 500, msg: 'Could not update the charge' }, null];
  }
};

/*
  The net fee the site has kept from one recipient for one reference: every charge that succeeded,
  less any of its fee given back since. What the cap is measured against. `excludeId` leaves one
  charge out — the one being corrected.
*/
export const feesUsed = async ({ recipientUserId, owner, ref, excludeId = null }, executor = db) => {
  const conditions = [
    eq(kempoPayoutCharge.recipientUserId, recipientUserId),
    eq(kempoPayoutCharge.referenceOwner, owner),
    eq(kempoPayoutCharge.referenceId, ref),
    eq(kempoPayoutCharge.status, 'succeeded'),
  ];
  if(excludeId) conditions.push(ne(kempoPayoutCharge.id, excludeId));
  try {
    const [row] = await executor.select({ total: sql`coalesce(sum(${kempoPayoutCharge.feeAmount} - ${kempoPayoutCharge.feeRefunded} - ${kempoPayoutCharge.feeCapPending}), 0)::int` })
      .from(kempoPayoutCharge)
      .where(and(...conditions));
    return [null, row?.total ?? 0];
  } catch {
    return [{ code: 500, msg: 'Could not total the fees for that reference' }, null];
  }
};

/*
  Filtered, paged, newest first. A recipient's own list (the Get paid page) and the admin's list are
  both this, with different filters.
*/
export const listCharges = async ({ recipientUserId, owner, ref, status, limit = 50, offset = 0 } = {}) => {
  if(hasNulByte(recipientUserId, owner, ref, status)) return [{ code: 400, msg: 'Filters cannot contain null characters' }, null];

  const conditions = [ne(kempoPayoutCharge.status, 'creating')];
  if(recipientUserId) conditions.push(eq(kempoPayoutCharge.recipientUserId, recipientUserId));
  if(owner) conditions.push(eq(kempoPayoutCharge.referenceOwner, owner));
  if(ref) conditions.push(eq(kempoPayoutCharge.referenceId, ref));
  const statuses = Array.isArray(status) ? status : status ? [status] : [];
  if(statuses.length) conditions.push(inArray(kempoPayoutCharge.status, statuses));
  const where = and(...conditions);
  const take = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);

  try {
    const rows = await db.select({ charge: kempoPayoutCharge, name: user.name, email: user.email })
      .from(kempoPayoutCharge)
      .leftJoin(user, eq(user.id, kempoPayoutCharge.recipientUserId))
      .where(where)
      .orderBy(desc(kempoPayoutCharge.createdAt))
      .limit(take)
      .offset(skip);
    const [counted] = await db.select({ total: sql`count(*)::int` }).from(kempoPayoutCharge).where(where);
    return [null, { charges: rows.map(row => ({ ...row.charge, recipient: { name: row.name, email: row.email } })), total: counted?.total ?? rows.length, limit: take, offset: skip }];
  } catch {
    return [{ code: 500, msg: 'Could not list charges' }, null];
  }
};

/*
  Fees collected: what the site has kept, net of fees given back, per currency — in total and per
  recipient. Only charges that succeeded count; a tip nobody paid earned nothing.
*/
export const summary = async ({ recipientUserId } = {}) => {
  const conditions = [eq(kempoPayoutCharge.status, 'succeeded')];
  if(recipientUserId) conditions.push(eq(kempoPayoutCharge.recipientUserId, recipientUserId));
  const where = and(...conditions);
  const net = sql`coalesce(sum(${kempoPayoutCharge.feeAmount} - ${kempoPayoutCharge.feeRefunded}), 0)::int`;

  try {
    const totals = await db.select({
      currency: kempoPayoutCharge.currency,
      count: sql`count(*)::int`,
      amount: sql`coalesce(sum(${kempoPayoutCharge.amount}), 0)::int`,
      refunded: sql`coalesce(sum(${kempoPayoutCharge.amountRefunded}), 0)::int`,
      fees: net,
      disputed: sql`count(*) filter (where ${kempoPayoutCharge.disputed})::int`,
    }).from(kempoPayoutCharge).where(where).groupBy(kempoPayoutCharge.currency);

    const recipients = await db.select({
      recipientUserId: kempoPayoutCharge.recipientUserId,
      name: user.name,
      email: user.email,
      currency: kempoPayoutCharge.currency,
      count: sql`count(*)::int`,
      amount: sql`coalesce(sum(${kempoPayoutCharge.amount}), 0)::int`,
      fees: net,
    }).from(kempoPayoutCharge)
      .leftJoin(user, eq(user.id, kempoPayoutCharge.recipientUserId))
      .where(where)
      .groupBy(kempoPayoutCharge.recipientUserId, user.name, user.email, kempoPayoutCharge.currency)
      .orderBy(desc(net))
      .limit(50);

    return [null, { totals, recipients }];
  } catch {
    return [{ code: 500, msg: 'Could not summarise the fees' }, null];
  }
};
