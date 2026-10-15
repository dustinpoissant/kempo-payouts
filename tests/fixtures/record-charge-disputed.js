/* Records payouts:charge-disputed for the suites. */
export default data => {
  (globalThis.kempoPayoutsHeard ||= []).push({ event: 'payouts:charge-disputed', data });
};
