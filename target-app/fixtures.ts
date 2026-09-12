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
};

/** Synthetic operator credential for the demo login form. Not a real secret. */
export const OPERATOR_CREDENTIALS = { username: 'operator', password: 'demo-pass-1234' };
