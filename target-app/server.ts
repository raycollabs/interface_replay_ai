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
  res.send(loginPage());
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

app.post('/member-search', requireAuth, (req, res) => {
  const memberId = String(req.body?.memberId ?? '').trim();
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

  res.send(accountsPage(member.memberId));
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
