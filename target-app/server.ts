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
} from './templates.js';

const PORT = Number(process.env.PORT ?? 4173);

// In-memory session store — this is a throwaway target-app fixture, not
// production auth. Sessions are keyed by an opaque cookie value.
const sessions = new Map<string, { authenticated: boolean }>();

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
    sessions.set(sid, { authenticated: true });
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

app.get('/member/:memberId/accounts', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));
  res.send(accountsPage(member.memberId));
});

// Loaded inside the accounts page's <iframe> — the one deliberately hostile
// frame-traversal case: the balance/currency/account-id fields only exist
// inside this frame, so the adapter's target resolution must switch into
// it (framePath: ["accounts-frame"]) rather than assume a single document.
app.get('/member/:memberId/accounts-frame', requireAuth, (req, res) => {
  const member = MEMBERS[req.params.memberId];
  if (!member) return res.status(404).send(memberNotFoundPage(req.params.memberId));
  res.send(accountsFramePartial(member.accounts));
});

app.listen(PORT, () => {
  console.log(`Target app listening on http://localhost:${PORT}`);
  console.log(`Login with username="${OPERATOR_CREDENTIALS.username}" password="${OPERATOR_CREDENTIALS.password}"`);
});
