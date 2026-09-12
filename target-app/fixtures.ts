/**
 * Synthetic data only. No real credentials, no real PII — per the ground
 * rules. Member 12345 is the happy-path fixture used by Slice 1-3.
 * Error-case members (not-found, slow, unknown-dialog) are added in
 * Slice 4 without touching this happy-path fixture.
 */
export interface MemberAccount {
  accountType: 'Savings';
  accountId: string;
  balance: string;
  currency: string;
}

export interface Member {
  memberId: string;
  name: string;
  accounts: MemberAccount[];
}

export const MEMBERS: Record<string, Member> = {
  '12345': {
    memberId: '12345',
    name: 'Jordan Alvarez',
    accounts: [
      { accountType: 'Savings', accountId: 'SAV-88213', balance: '4235.67', currency: 'USD' },
    ],
  },
  // Slice 4: recoverable conditions. 44444's accounts page shows an
  // unexpected notice that must be dismissed once per session before the
  // real content renders -- the "unexpected confirmation dialog" case.
  '44444': {
    memberId: '44444',
    name: 'Priya Nakamura',
    accounts: [
      { accountType: 'Savings', accountId: 'SAV-51190', balance: '812.40', currency: 'USD' },
    ],
  },
  // 55555's accounts-frame returns a "loading" placeholder on the first
  // request per session and the real table from the second request on --
  // the "transient slow load, recovered by retry" case.
  '55555': {
    memberId: '55555',
    name: 'Owen Fitzgerald',
    accounts: [
      { accountType: 'Savings', accountId: 'SAV-30456', balance: '15920.11', currency: 'USD' },
    ],
  },
  // Slice 5: the genuinely-stuck case. Shows an "unresolvable" notice
  // (distinct from 44444's auto-dismissable one) that the capability
  // declares as escalate-only -- automation must not guess at it, a
  // human has to look at it and decide.
  '33333': {
    memberId: '33333',
    name: 'Dana Kowalski',
    accounts: [
      { accountType: 'Savings', accountId: 'SAV-77042', balance: '2650.00', currency: 'USD' },
    ],
  },
  // Slice 7: a second clean happy-path member, distinct from 12345 (the
  // one discovery used). Verifying the compiled artifact against THIS
  // member -- not 12345 -- is the mechanical proof that the compiler
  // actually parameterized memberId rather than transcribing "12345".
  '67890': {
    memberId: '67890',
    name: 'Marisol Vega',
    accounts: [
      { accountType: 'Savings', accountId: 'SAV-40988', balance: '9310.25', currency: 'USD' },
    ],
  },
  // 3.3 gap closure: a real member whose accounts page always answers
  // "access restricted" instead of returning data -- a genuine
  // permission-denial business outcome, not a 404 (member not found) or
  // an interstitial (nothing to dismiss; there is no automated path
  // through this at all).
  '88888': {
    memberId: '88888',
    name: 'Restricted Account Holder',
    accounts: [],
  },
  // 3.3 gap closure: a real member whose FIRST accounts request each
  // session invalidates the session server-side and redirects to /login
  // -- simulating a session timing out mid-flow. Deterministic and
  // reproducible (unlike a real wall-clock expiry) while still exercising
  // a genuine navigation-based detection path, not a canned response.
  '22222': {
    memberId: '22222',
    name: 'Session Timeout Test Holder',
    accounts: [],
  },
};

/** Synthetic operator credential for the demo login form. Not a real secret. */
export const OPERATOR_CREDENTIALS = { username: 'operator', password: 'demo-pass-1234' };
