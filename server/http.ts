import type { NextRequest } from "next/server";
import { z } from "zod";
import { HttpError } from "./errors";

const MAX_BODY_BYTES = 100 * 1024;

/**
 * Wraps a route handler with the API's error responses: validation errors become 400 with the field issues,
 * HttpErrors carry their own status, and anything else is logged and hidden behind a 500.
 */
export function handle<P = Record<string, never>>(fn: (req: NextRequest, params: P) => Promise<Response>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    try {
      return await fn(req, await ctx.params);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return Response.json({ error: "Invalid request", issues: z.flattenError(err).fieldErrors }, { status: 400 });
      }
      if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status, headers: err.headers });
      console.error(err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/**
 * The request's JSON body, or undefined when it has none. Like express.json(), only `application/json` bodies are
 * read (so a cross-site form can't post one) and they're capped at 100kb.
 */
export async function readJson(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
}

/** The client's address. Vercel overwrites these headers at its edge, so clients can't choose their own. */
export function clientIp(req: Request) {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

export const noContent = () => new Response(null, { status: 204 });
