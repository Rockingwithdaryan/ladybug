import { z } from "zod";

// On Vercel the production domain is known, so OAuth redirects work without setting PUBLIC_URL.
const defaultPublicUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  PUBLIC_URL: z.string().default(defaultPublicUrl),
  /** Sandbox snapshot with the runner's toolchains, created by `npm run runner:setup`. */
  RUNNER_SNAPSHOT_ID: z.string().optional(),
  /** Only needed outside Vercel, where no OIDC token is available (see README). */
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

let cached: z.infer<typeof schema> | undefined;

/** Validated on first use rather than at import, so `next build` doesn't need the runtime secrets. */
export function getConfig() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error("Invalid environment:\n" + z.prettifyError(parsed.error));
  cached = parsed.data;
  return cached;
}

export const isProduction = () => getConfig().NODE_ENV === "production";
