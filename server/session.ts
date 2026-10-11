import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getConfig, isProduction } from "./config";
import { db } from "./db";
import { HttpError } from "./errors";

/**
 * Server-side sessions in the `session` table, referenced by a signed `sid` cookie. The table and the cookie format
 * (`s:<id>.<hmac>`) are the ones express-session used, so sessions from before the move to Next.js stay valid.
 */

export type AuthMethod = "email" | "github" | "google";
export type OAuthState = {
  provider: "github" | "google";
  state: string;
  verifier: string;
  remember: boolean;
  from: "login" | "register";
};
type SessionData = {
  userId?: string;
  authMethod?: AuthMethod;
  oauth?: OAuthState;
  /** False for "don't remember me" logins: a browser-session cookie, and the session expires after a day idle. */
  persistent?: boolean;
};
export type Session = SessionData & { sid: string };

const COOKIE = "sid";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const REMEMBER_MS = 7 * DAY_MS;
// An OAuth round trip only needs the state for a few minutes.
const OAUTH_ONLY_MS = HOUR_MS;

const sign = (sid: string) =>
  `s:${sid}.${crypto.createHmac("sha256", getConfig().SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, "")}`;

function unsign(value: string): string | null {
  if (!value.startsWith("s:")) return null;
  const sid = value.slice(2, value.lastIndexOf("."));
  const expected = Buffer.from(sign(sid));
  const actual = Buffer.from(value);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? sid : null;
}

async function setCookie(sid: string, maxAgeMs: number | null) {
  (await cookies()).set(COOKIE, sign(sid), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    ...(maxAgeMs === null ? {} : { maxAge: Math.floor(maxAgeMs / 1000) }),
  });
}

async function create(data: SessionData, ttlMs: number, cookieMaxAgeMs: number | null) {
  const sid = crypto.randomBytes(24).toString("base64url");
  await db().query(
    "INSERT INTO session (sid, sess, expire) VALUES ($1, $2, now() + $3 * interval '1 millisecond')",
    [sid, JSON.stringify(data), ttlMs],
  );
  await setCookie(sid, cookieMaxAgeMs);
  return sid;
}

async function save(session: Session) {
  const { sid, ...data } = session;
  await db().query("UPDATE session SET sess = $2 WHERE sid = $1", [sid, JSON.stringify(data)]);
}

/** The current request's session, or null if it has none (or it expired). */
export async function getSession(): Promise<Session | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  const sid = value ? unsign(value) : null;
  if (!sid) return null;
  const { rows } = await db().query<{ sess: SessionData; stale: boolean }>(
    "SELECT sess, expire < now() + interval '23 hours' AS stale FROM session WHERE sid = $1 AND expire > now()",
    [sid],
  );
  if (!rows[0]) return null;
  const session = { ...rows[0].sess, sid };
  // Browser-session logins expire after a day without use; refreshing hourly is plenty and saves a write per request.
  if (session.persistent === false && rows[0].stale) {
    await db().query("UPDATE session SET expire = now() + interval '1 day' WHERE sid = $1", [sid]);
  }
  return session;
}

/** The logged-in user's id, or a 401. */
export async function requireUser(): Promise<string> {
  const session = await getSession();
  if (!session?.userId) throw new HttpError(401, "Not logged in");
  return session.userId;
}

/** Logs a user in with a brand-new session id, so a session id planted before login is useless (session fixation). */
export async function startSession(userId: string, remember: boolean, authMethod: AuthMethod) {
  const previous = await getSession();
  if (previous) await db().query("DELETE FROM session WHERE sid = $1", [previous.sid]);
  // Logins are a good moment to drop expired sessions, which nothing else deletes.
  await db().query("DELETE FROM session WHERE expire < now()");
  await create(
    { userId, authMethod, persistent: remember },
    remember ? REMEMBER_MS : DAY_MS,
    remember ? REMEMBER_MS : null,
  );
}

export async function destroySession() {
  const session = await getSession();
  if (session) await db().query("DELETE FROM session WHERE sid = $1", [session.sid]);
  (await cookies()).delete(COOKIE);
}

/** Remembers an OAuth login in progress, creating a short-lived session when the visitor has none yet. */
export async function saveOAuthState(oauth: OAuthState) {
  const session = await getSession();
  if (session) await save({ ...session, oauth });
  else await create({ oauth }, OAUTH_ONLY_MS, OAUTH_ONLY_MS);
}

/** The pending OAuth state, removed from the session so each state can only be used once. */
export async function takeOAuthState(): Promise<OAuthState | undefined> {
  const session = await getSession();
  if (!session?.oauth) return undefined;
  const { oauth, ...rest } = session;
  await save(rest);
  return oauth;
}
