/* Records payouts:charge-succeeded for the suites. */
export default data => {
  (globalThis.kempoPayoutsHeard ||= []).push({ event: 'payouts:charge-succeeded', data });
};
