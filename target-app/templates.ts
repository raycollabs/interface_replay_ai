/**
 * Deliberately old-school server-rendered HTML: table-based layout, no
 * test IDs, form fields labeled by table-cell adjacency rather than
 * <label for>. This is what forces the resolver's targeting ladder
 * (Slice 2) to actually be exercised rather than resolved trivially by
 * rung 1. A shared <style> block (not inline style attributes) gives it a
 * consistent period-appropriate look without violating the
 * no-inline-styles convention.
 *
 * Multi-tenant stretch demo: TENANT_VARIANT=B renders the same
 * underlying vendor product with different field/link wording -- a
 * realistic white-label scenario (two credit unions on the same core
 * banking product, branded differently). This is what a TenantBinding's
 * targetOverrides exist to survive without re-recording the capability;
 * see src/multitenant/resolve.ts and tenants/credit-union-b.json.
 */
const VARIANT = process.env.TENANT_VARIANT === 'B' ? 'B' : 'A';
const LABELS =
  VARIANT === 'B'
    ? { titlebar: 'Northshore Member Portal', memberIdLabel: 'Customer Number', accountsLinkText: 'Products' }
    : { titlebar: 'Member Servicing Console', memberIdLabel: 'Member ID', accountsLinkText: 'Accounts' };

const STYLE = `
  body { font-family: Tahoma, Verdana, sans-serif; font-size: 13px; background: #ECE9D8; margin: 0; }
  .titlebar { background: #003366; color: #fff; padding: 6px 12px; font-weight: bold; }
  .content { padding: 16px; }
  table.form { border-collapse: collapse; }
  table.form td { padding: 4px 8px; }
  table.data { border-collapse: collapse; margin-top: 8px; }
  table.data th, table.data td { border: 1px solid #999; padding: 4px 10px; background: #fff; }
  table.data th { background: #D6D2C2; text-align: left; }
  input[type=text], input[type=password] { border: 1px solid #7F9DB9; padding: 2px 4px; }
  button { padding: 3px 14px; }
  .banner-error { background: #FFDCDC; border: 1px solid #C00; padding: 8px; margin-bottom: 10px; }
  .banner-info { background: #DCE8FF; border: 1px solid #369; padding: 8px; margin-bottom: 10px; }
  a { color: #003366; }
`;

export function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="titlebar">${LABELS.titlebar}</div>
  <div class="content">${bodyHtml}</div>
</body>
</html>`;
}

export function loginPage(errorMessage?: string): string {
  const banner = errorMessage ? `<div class="banner-error">${errorMessage}</div>` : '';
  return pageShell(
    'Login',
    `
    ${banner}
    <form method="post" action="/login">
      <table class="form">
        <tr><td>Username</td><td><input type="text" name="username" /></td></tr>
        <tr><td>Password</td><td><input type="password" name="password" /></td></tr>
        <tr><td></td><td><button type="submit">Log In</button></td></tr>
      </table>
    </form>
  `,
  );
}

/**
 * `validationError`, when present, is a real app-level business-rule
 * rejection distinct from "not found" (3.3 gap closure) -- the identifier
 * is well-formed (passes the capability's own `pattern`) but the app
 * itself refuses to search it, the same way a bank's real system might
 * reject a reserved/test account range. Re-rendered in place on the SAME
 * page (no redirect to a member route at all) so it's unambiguously a
 * search-time validation failure, not a lookup failure.
 */
export function memberSearchPage(validationError?: string): string {
  const banner = validationError
    ? `<div class="banner-error" role="alert" aria-label="Validation error">${validationError}</div>`
    : '';
  return pageShell(
    'Member Search',
    `
    ${banner}
    <form method="post" action="/member-search">
      <table class="form">
        <tr><td>${LABELS.memberIdLabel}</td><td><input type="text" name="memberId" /></td></tr>
        <tr><td></td><td><button type="submit">Search</button></td></tr>
      </table>
    </form>
  `,
  );
}

export function memberNotFoundPage(memberId: string): string {
  return pageShell(
    'Member Not Found',
    `<div class="banner-error" role="alert" aria-label="Member not found">No member found for identifier ${memberId}.</div>
     <p><a href="/member-search">Back to search</a></p>`,
  );
}

/**
 * The "permission denial" business outcome (3.3 gap closure): a real
 * member exists, but this operator's role cannot view their accounts. No
 * form, no acknowledgement action -- unlike the two interstitial notices
 * below, there is nothing to dismiss or escalate; this is a legitimate,
 * final answer the caller needs to know about, exactly like "no such
 * member" is (KnownOutcome, not a failure).
 */
export function permissionDeniedPage(memberId: string): string {
  return pageShell(
    `Accounts — Member ${memberId}`,
    `<div class="banner-error" role="alert" aria-label="Permission denied">Access to this member's accounts is restricted and cannot be viewed with the current operator role.</div>
     <p><a href="/member/${memberId}">Back to member</a></p>`,
  );
}

export function memberDetailPage(memberId: string, name: string): string {
  return pageShell(
    `Member ${memberId}`,
    `
    <p>Member: ${name} (${memberId})</p>
    <p><a href="/member/${memberId}/accounts">${LABELS.accountsLinkText}</a></p>
  `,
  );
}

/**
 * `manageableAccounts`, when present, adds a top-level (non-iframe) list
 * with a "Close" action per account, plus an "Open a new sub-account"
 * link -- 3.4 gap closure. Deliberately kept OUTSIDE the accounts-frame
 * iframe used by the read-balance flow: that iframe exists specifically
 * to exercise frame-traversal targeting (Slice 2), a different concern
 * from risk-class handling. Optional so the read-savings-balance
 * capability's existing targets/evidence are byte-for-byte unaffected.
 */
export function accountsPage(memberId: string, manageableAccounts?: { accountId: string; accountType: string; nickname?: string }[]): string {
  const manageSection = manageableAccounts
    ? `
    <p><a href="/member/${memberId}/accounts/new">Open a new sub-account</a></p>
    <ul>
      ${manageableAccounts
        .map(
          (a) =>
            `<li>${a.accountType} ${a.accountId}${a.nickname ? ` ("${a.nickname}")` : ''} — <a href="/member/${memberId}/accounts/${a.accountId}/close">Close</a></li>`,
        )
        .join('\n')}
    </ul>`
    : '';
  return pageShell(
    `Accounts — Member ${memberId}`,
    `
    <p><a href="/member/${memberId}">Back to member</a></p>
    <iframe name="accounts-frame" title="Accounts" src="/member/${memberId}/accounts-frame"
      style="width:100%;height:220px;border:1px solid #999;"></iframe>
    ${manageSection}
  `,
  );
}

/**
 * The sub-account creation form (3.4 gap closure -- mutating_reversible).
 * Type select and nickname input are the two fields; the submit button is
 * the flow's actual point of mutation, distinct from the link that
 * navigated here ('sub-account create action' vs 'sub-account confirm
 * submit' -- two different semantic purposes for "start the flow" vs
 * "commit the flow").
 */
export function newSubAccountFormPage(memberId: string): string {
  return pageShell(
    'Open a New Sub-Account',
    `
    <form method="post" action="/member/${memberId}/accounts/new">
      <table class="form">
        <tr><td>Account Type</td><td>
          <select name="accountType">
            <option value="Savings">Savings</option>
            <option value="Checking">Checking</option>
          </select>
        </td></tr>
        <tr><td>Nickname</td><td><input type="text" name="nickname" /></td></tr>
        <tr><td></td><td><button type="submit">Create</button></td></tr>
      </table>
    </form>
    <p><a href="/member/${memberId}/accounts">Cancel</a></p>
  `,
  );
}

export function subAccountConfirmationPage(memberId: string, account: { accountId: string; accountType: string; nickname?: string }): string {
  return pageShell(
    'Sub-Account Created',
    `
    <div role="status" class="banner-info" aria-label="Sub-account created">Sub-account created successfully.</div>
    <p>Account Type: ${account.accountType}</p>
    <p>Account ID:</p>
    <p>${account.accountId}</p>
    ${account.nickname ? `<p>Nickname: ${account.nickname}</p>` : ''}
    <p><a href="/member/${memberId}/accounts">Back to accounts</a></p>
  `,
  );
}

/**
 * The risky_irreversible confirmation gate (3.4 gap closure). Explicitly
 * warns that this cannot be undone -- the human-facing equivalent of what
 * the policy layer already enforces mechanically (risky_irreversible
 * always requires an explicit, in-the-moment decision, attended or not).
 */
export function closeAccountConfirmPage(memberId: string, account: { accountId: string; accountType: string; nickname?: string }): string {
  return pageShell(
    'Close Account',
    `
    <div class="banner-error" role="alert" aria-label="Irreversible action warning">
      This will permanently close ${account.accountType} account ${account.accountId}${account.nickname ? ` ("${account.nickname}")` : ''}.
      This cannot be undone.
    </div>
    <form method="post" action="/member/${memberId}/accounts/${account.accountId}/close">
      <button type="submit">Confirm Close</button>
    </form>
    <p><a href="/member/${memberId}/accounts">Cancel</a></p>
  `,
  );
}

export function accountClosedPage(memberId: string, accountId: string): string {
  return pageShell(
    'Account Closed',
    `
    <div role="status" class="banner-info" aria-label="Account closed">Account ${accountId} has been closed.</div>
    <p><a href="/member/${memberId}/accounts">Back to accounts</a></p>
  `,
  );
}

export function accountsFramePartial(
  accounts: { accountType: string; accountId: string; balance: string; currency: string }[],
): string {
  const rows = accounts
    .map(
      (a) =>
        `<tr><td>${a.accountType}</td><td>${a.accountId}</td><td>${a.balance}</td><td>${a.currency}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html><head><style>${STYLE}</style></head><body>
<table class="data">
  <thead><tr><th>Account Type</th><th>Account ID</th><th>Balance</th><th>Currency</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}

/**
 * The "unexpected confirmation dialog" recoverable case (Slice 4). Renders
 * in place of the real accounts page until the member's dialog has been
 * acknowledged once for this session.
 */
export function unknownDialogPage(memberId: string): string {
  return pageShell(
    `Accounts — Member ${memberId}`,
    `
    <div role="alertdialog" aria-label="Notice" class="banner-info">
      <p>An unexpected notice requires acknowledgement before continuing.</p>
      <form method="post" action="/member/${memberId}/acknowledge">
        <button type="submit">Continue</button>
      </form>
    </div>
  `,
  );
}

/**
 * The genuinely-stuck case (Slice 5). Visually similar to 44444's dialog
 * but with a different control name/wording, on a different semantic
 * purpose the capability declares as escalate-only -- deliberately NOT
 * auto-dismissable, unlike 44444's.
 */
export function unresolvableNoticePage(memberId: string): string {
  return pageShell(
    `Accounts — Member ${memberId}`,
    `
    <div role="alertdialog" aria-label="Notice" class="banner-error">
      <p>This account carries a flag that requires manual review before account data can be displayed.</p>
      <form method="post" action="/member/${memberId}/escalate-acknowledge">
        <button type="submit">Acknowledge and escalate</button>
      </form>
    </div>
  `,
  );
}

/**
 * The "transient slow load, recovered by retry" case (Slice 4). Served
 * once per session in place of the real accounts-frame table.
 */
export function loadingPartial(): string {
  return `<!doctype html>
<html><head><style>${STYLE}</style></head><body>
<div role="status" class="banner-info">Loading account data, please wait...</div>
</body></html>`;
}
