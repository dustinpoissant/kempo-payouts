import crypto from 'crypto';

/*
  Ids carry a prefix saying what they are, so one pasted into a support ticket or a log line can be
  read without looking it up: `pac_` a payout account, `pch_` a charge.
*/
export default prefix => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
