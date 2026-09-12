import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { MEMBERS, OPERATOR_CREDENTIALS } from './fixtures.js';
import {
  loginPage,
  memberSearchPage,
  memberNotFoundPage,
  memberDetailPage,
  accountsPage,
  accountsFramePartial,
  unknownDialogPage,
  unresolvableNoticePage,
  loadingPartial,
  permissionDeniedPage,
  newSubAccountFormPage,
  subAccountConfirmationPage,
  closeAccountConfirmPage,
  accountClosedPage,
} from './templates.js';

const PORT = Number(process.env.PORT ?? 4173);

// In-memory session store — this is a throwaway target-app fixture, not
// production auth. Sessions are keyed by an opaque cookie value.
// acknowledgedDialogs / slowLoadServed back the two Slice 4 recoverable-
// condition fixtures: once-per-session state, not per-request.
const sessions = new Map<
  string,
  {
    authenticated: boolean;
    acknowledgedDialogs: Set<string>;
    slowLoadServed: Set<string>;
    escalationAcknowledged: Set<string>;
  }
>();

const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sid = req.cookies?.sid;
  if (sid && sessions.get(sid)?.authenticated) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  const sid = req.cookies?.sid;
  res.redirect(sid && sessions.get(sid)?.authenticated ? '/member-search' : '/login');
});

app.get('/login', (req, res) => {
  // 3.3 gap closure: distinguishes a plain landing on /login from being
  // bounced there mid-flow by SESSION_EXPIRED_MEMBER_ID below, so the
  // login page itself explains why an operator (or a suspended replay
  // worker) ended up back here.
  const message = req.query.reason === 'session_expired' ? 'Your session has expired. Please log in again.' : undefined;
  res.send(loginPage(message));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === OPERATOR_CREDENTIALS.username && password === OPERATOR_CREDENTIALS.password) {
    const sid = randomUUID();
    sessions.set(sid, {
      authenticated: true,
      acknowledgedDialogs: new Set(),
      slowLoadServed: new Set(),
      escalationAcknowledged: new Set(),
    });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax' });
    return res.redirect('/member-search');
  }
  res.status(401).send(loginPage('Invalid username or password.'));
});

app.get('/logout', (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) sessions.delete(sid);
  res.clearCookie('sid');
  res.redirect('/login');
});

app.get('/member-search', requireAuth, (req, res) => {
  res.send(memberSearchPage());
});

// 3.3 gap closure: a well-formed identifier (passes the capability's own
// `^[0-9]{5}$` pattern) that the APP itself refuses to search -- a real
// business-rule validation failure, distinct from "not found" (which only
// fires after a genuine lookup). Re-rendering the search page in place
// (no redirect to a /member route at all) is what makes this
// unambiguously a search-time validation error, not a lookup failure.
const VALIDATION_ERROR_MEMBER_ID = '00000';

app.post('/member-search', requireAuth, (req, res) => {
  const memberId = String(req.body?.memberId ?? '').trim();
  if (memberId === VALIDATION_ERROR_MEMBER_ID) {
    return res.send(memberSearchPage('Member ID 00000 is reserved for internal test accounts and cannot be searched.'));
  }
  res.redirect(`/member/${encodeURIComponent(memberId)}`);
});

app.get('/member/:memberId', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));
  res.send(memberDetailPage(member.memberId, member.name));
});

// Only member 44444 has the unexpected-dialog fixture. Scoping the gate
// to this one ID (not "any member not yet acknowledged") is what keeps
// 12345's happy path an actual zero-interstitial happy path.
const DIALOG_GATED_MEMBER_ID = '44444';
// 33333's notice is visually similar but deliberately NOT wired to any
// auto-dismiss interstitial in the capability -- it exists to require a
// human decision (Slice 5), not to be auto-recovered like 44444's.
const ESCALATION_GATED_MEMBER_ID = '33333';
// 3.3 gap closure: this member's accounts are permanently restricted --
// a legitimate business outcome (KnownOutcome, not a failure), distinct
// from ESCALATION_GATED_MEMBER_ID above, which needs a human decision.
// There is no acknowledgement path here at all; every request is denied.
const PERMISSION_DENIED_MEMBER_ID = '88888';
// 3.3 gap closure: this member's FIRST accounts request per session
// destroys the session server-side and redirects to /login, simulating a
// session timing out mid-flow. Scoped to one member ID, same reasoning as
// every other gated fixture in this file: it keeps 12345's happy path an
// actual zero-incident happy path.
const SESSION_EXPIRED_MEMBER_ID = '22222';

app.get('/member/:memberId/accounts', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));

  const sid = req.cookies?.sid;
  const session = sid ? sessions.get(sid) : undefined;

  // Slice 4: the unexpected-dialog case. Shown once per session for this
  // one member; the real accounts content is withheld until acknowledged.
  if (session && member.memberId === DIALOG_GATED_MEMBER_ID && !session.acknowledgedDialogs.has(member.memberId)) {
    return res.send(unknownDialogPage(member.memberId));
  }

  // Slice 5: the genuinely-stuck case. No automatic path clears this one.
  if (session && member.memberId === ESCALATION_GATED_MEMBER_ID && !session.escalationAcknowledged.has(member.memberId)) {
    return res.send(unresolvableNoticePage(member.memberId));
  }

  if (member.memberId === PERMISSION_DENIED_MEMBER_ID) {
    return res.send(permissionDeniedPage(member.memberId));
  }

  if (session && member.memberId === SESSION_EXPIRED_MEMBER_ID) {
    sessions.delete(sid!);
    res.clearCookie('sid');
    return res.redirect('/login?reason=session_expired');
  }

  res.send(accountsPage(member.memberId, member.accounts));
});

// 3.4 gap closure: sub-account creation (mutating_reversible -- a real
// mutation, but reversible by closing the account afterward) and closure
// (risky_irreversible -- a genuine point of no return). Generic across any
// member, same as every other route here; the demo capabilities target
// memberId=56789 specifically so mutating it can never touch another
// member's regression-checked fixture data.
let nextSubAccountSeq = 90000;

app.get('/member/:memberId/accounts/new', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));
  res.send(newSubAccountFormPage(member.memberId));
});

app.post('/member/:memberId/accounts/new', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));

  const accountType = req.body?.accountType === 'Checking' ? 'Checking' : 'Savings';
  const nickname = String(req.body?.nickname ?? '').trim() || undefined;
  const prefix = accountType === 'Checking' ? 'CHK' : 'SAV';
  const accountId = `${prefix}-${nextSubAccountSeq++}`;
  const newAccount = { accountType: accountType as 'Savings' | 'Checking', accountId, balance: '0.00', currency: 'USD', nickname };
  member.accounts.push(newAccount);

  res.send(subAccountConfirmationPage(member.memberId, newAccount));
});

app.get('/member/:memberId/accounts/:accountId/close', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));
  const account = member.accounts.find((a) => a.accountId === req.params.accountId);
  if (!account) return res.status(404).send(`<p>No account ${req.params.accountId} found for this member.</p>`);
  res.send(closeAccountConfirmPage(member.memberId, account));
});

app.post('/member/:memberId/accounts/:accountId/close', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));
  const before = member.accounts.length;
  member.accounts = member.accounts.filter((a) => a.accountId !== req.params.accountId);
  if (member.accounts.length === before) {
    return res.status(404).send(`<p>No account ${req.params.accountId} found for this member.</p>`);
  }
  res.send(accountClosedPage(member.memberId, req.params.accountId));
});

app.post('/member/:memberId/acknowledge', requireAuth, (req, res) => {
  const sid = req.cookies?.sid;
  const session = sid ? sessions.get(sid) : undefined;
  session?.acknowledgedDialogs.add(req.params.memberId);
  res.redirect(`/member/${encodeURIComponent(req.params.memberId)}/accounts`);
});

// Deliberately not something the replay engine ever calls on its own --
// only reachable by whoever (a human operator, in Slice 5's demo) decides
// to click through the notice.
app.post('/member/:memberId/escalate-acknowledge', requireAuth, (req, res) => {
  const sid = req.cookies?.sid;
  const session = sid ? sessions.get(sid) : undefined;
  session?.escalationAcknowledged.add(req.params.memberId);
  res.redirect(`/member/${encodeURIComponent(req.params.memberId)}/accounts`);
});

// Only member 55555 has the slow-load fixture -- same reasoning as
// DIALOG_GATED_MEMBER_ID above.
const SLOW_LOAD_MEMBER_ID = '55555';

// Loaded inside the accounts page's <iframe> — the one deliberately hostile
// frame-traversal case: the balance/currency/account-id fields only exist
// inside this frame, so the adapter's target resolution must switch into
// it (framePath: ["accounts-frame"]) rather than assume a single document.
app.get('/member/:memberId/accounts-frame', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));

  // Slice 4: the transient-slow-load case. First request per session for
  // this one member gets a loading placeholder instead of the real
  // table; every request after that (and every other member) gets the
  // real data straight away.
  const sid = req.cookies?.sid;
  const session = sid ? sessions.get(sid) : undefined;
  if (session && member.memberId === SLOW_LOAD_MEMBER_ID && !session.slowLoadServed.has(member.memberId)) {
    session.slowLoadServed.add(member.memberId);
    return res.send(loadingPartial());
  }

  res.send(accountsFramePartial(member.accounts));
});

app.listen(PORT, () => {
  console.log(`Target app listening on http://localhost:${PORT}`);
  console.log(`Login with username="${OPERATOR_CREDENTIALS.username}" password="${OPERATOR_CREDENTIALS.password}"`);
});
