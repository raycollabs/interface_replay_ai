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
};

/** Synthetic operator credential for the demo login form. Not a real secret. */
export const OPERATOR_CREDENTIALS = { username: 'operator', password: 'demo-pass-1234' };
