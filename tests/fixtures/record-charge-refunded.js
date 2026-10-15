/* Records payouts:charge-refunded for the suites. */
export default data => {
  (globalThis.kempoPayoutsHeard ||= []).push({ event: 'payouts:charge-refunded', data });
};
