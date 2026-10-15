/* Records payouts:account-updated for the suites. */
export default data => {
  (globalThis.kempoPayoutsHeard ||= []).push({ event: 'payouts:account-updated', data });
};
