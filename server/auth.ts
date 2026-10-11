import type { NextRequest } from "next/server";
import { z } from "zod";
import { preferredLanguagesSchema } from "./languages";
import { getConfig } from "./config";
import { db } from "./db";
import { HttpError } from "./errors";
import { clientIp, noContent, readJson } from "./http";
import { hashPassword, verifyPassword } from "./password";
import { rateLimit, refundRateLimit, type RateLimit } from "./rateLimit";
import { destroySession, getSession, requireUser, startSession } from "./session";

export const ROLES = [
  "Software engineer",
  "Student",
  "Data scientist",
  "QA / test engineer",
  "Engineering manager",
  "Other",
] as const;

const registerSchema = z.object({
  fullName: z.string().trim().max(100).optional(),
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  remember: z.boolean().optional().default(false),
});

const onboardingSchema = z.object({
  fullName: z.string().trim().min(1, "Display name is required").max(100),
  role: z.enum(ROLES, { message: "Please select a valid role" }),
  languages: preferredLanguagesSchema,
  acceptTerms: z.literal(true, {
    message: "You must accept the terms of service to continue",
  }),
});

const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Display name is required").max(100),
  role: z.enum(ROLES, { message: "Please select a valid role" }),
  languages: preferredLanguagesSchema,
});

export type UserRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  debug_languages: string[] | null;
  avatar_url: string | null;
  onboarded_at: Date | string | null;
  created_at?: Date | string | null;
};

export function toUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    debugLanguages: row.debug_languages ?? [],
    avatarUrl: row.avatar_url,
    onboarded: Boolean(row.onboarded_at),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  };
}

// Compared against when the email is unknown so login timing doesn't reveal which emails exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword("timing-equaliser"));

const ipLimit: RateLimit = { name: "auth-ip", windowMs: 15 * 60_000, limit: 20 };
// Per-account limit on failed logins: holds even if a client rotates IPs.
const failedLoginLimit: RateLimit = {
  name: "login-failures",
  windowMs: 15 * 60_000,
  limit: 10,
  message: "Too many failed attempts for this account. Try again in 15 minutes.",
};

export async function providers() {
  const config = getConfig();
  return Response.json({
    github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
    google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
  });
}

export async function register(req: NextRequest) {
  const body = await readJson(req);
  await rateLimit(ipLimit, clientIp(req));
  const { fullName, email, password } = registerSchema.parse(body);
  const { rows } = await db().query<UserRow>(
    `INSERT INTO users (email, password_hash, full_name, terms_accepted_at)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, full_name, role, debug_languages, avatar_url, onboarded_at, created_at`,
    [email, await hashPassword(password), fullName || null],
  );
  if (rows.length === 0) {
    throw new HttpError(409, "An account with this email already exists. Log in instead.");
  }
  await startSession(rows[0].id, true, "email");
  return Response.json({ user: toUser(rows[0]) }, { status: 201 });
}

export async function login(req: NextRequest) {
  const body = await readJson(req);
  await rateLimit(ipLimit, clientIp(req));
  const account = String((body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
  await rateLimit(failedLoginLimit, account);

  const { email, password, remember } = loginSchema.parse(body);
  const { rows } = await db().query<UserRow & { password_hash: string | null }>(
    "SELECT id, email, password_hash, full_name, role, debug_languages, avatar_url, onboarded_at, created_at FROM users WHERE email = $1",
    [email],
  );
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !user.password_hash || !ok) throw new HttpError(401, "Invalid email or password");
  await startSession(user.id, remember, "email");
  // Only failed attempts count towards the per-account limit.
  await refundRateLimit(failedLoginLimit, account);
  return Response.json({ user: toUser(user) });
}

export async function logout() {
  await destroySession();
  return noContent();
}

export async function me() {
  const session = await getSession();
  if (!session?.userId) return Response.json({ user: null });
  const { rows } = await db().query<UserRow>(
    "SELECT id, email, full_name, role, debug_languages, avatar_url, onboarded_at, created_at FROM users WHERE id = $1",
    [session.userId],
  );
  if (!rows[0]) return Response.json({ user: null });
  return Response.json({ user: toUser(rows[0]), authMethod: session.authMethod ?? "email" });
}

export async function onboarding(req: NextRequest) {
  const userId = await requireUser();
  const { fullName, role, languages } = onboardingSchema.parse(await readJson(req));
  const { rows } = await db().query<UserRow>(
    `UPDATE users
     SET full_name = $1, role = $2, debug_languages = $3, terms_accepted_at = now(), onboarded_at = now()
     WHERE id = $4
     RETURNING id, email, full_name, role, debug_languages, avatar_url, onboarded_at, created_at`,
    [fullName, role, languages, userId],
  );
  if (rows.length === 0) throw new HttpError(404, "User not found");
  return Response.json({ user: toUser(rows[0]) });
}

export async function updateProfile(req: NextRequest) {
  const userId = await requireUser();
  const { fullName, role, languages } = profileSchema.parse(await readJson(req));
  const { rows } = await db().query<UserRow>(
    `UPDATE users
     SET full_name = $1, role = $2, debug_languages = $3
     WHERE id = $4
     RETURNING id, email, full_name, role, debug_languages, avatar_url, onboarded_at, created_at`,
    [fullName, role, languages, userId],
  );
  if (rows.length === 0) throw new HttpError(404, "User not found");
  return Response.json({ user: toUser(rows[0]) });
}
