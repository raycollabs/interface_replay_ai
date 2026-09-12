/**
 * Deliberately old-school server-rendered HTML: table-based layout, no
 * test IDs, form fields labeled by table-cell adjacency rather than
 * <label for>. This is what forces the resolver's targeting ladder
 * (Slice 2) to actually be exercised rather than resolved trivially by
 * rung 1. A shared <style> block (not inline style attributes) gives it a
 * consistent period-appropriate look without violating the
 * no-inline-styles convention.
 */

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
  <div class="titlebar">Member Servicing Console</div>
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

export function memberSearchPage(): string {
  return pageShell(
    'Member Search',
    `
    <form method="post" action="/member-search">
      <table class="form">
        <tr><td>Member ID</td><td><input type="text" name="memberId" /></td></tr>
        <tr><td></td><td><button type="submit">Search</button></td></tr>
      </table>
    </form>
  `,
  );
}

export function memberNotFoundPage(memberId: string): string {
  return pageShell(
    'Member Not Found',
    `<div class="banner-error" role="alert">No member found for identifier ${memberId}.</div>
     <p><a href="/member-search">Back to search</a></p>`,
  );
}

export function memberDetailPage(memberId: string, name: string): string {
  return pageShell(
    `Member ${memberId}`,
    `
    <p>Member: ${name} (${memberId})</p>
    <p><a href="/member/${memberId}/accounts">Accounts</a></p>
  `,
  );
}

export function accountsPage(memberId: string): string {
  return pageShell(
    `Accounts — Member ${memberId}`,
    `
    <p><a href="/member/${memberId}">Back to member</a></p>
    <iframe name="accounts-frame" title="Accounts" src="/member/${memberId}/accounts-frame"
      style="width:100%;height:220px;border:1px solid #999;"></iframe>
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
