import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { recordEvent } from "./activity";
import { type ChallengeKind, periodEndsAt } from "./challenges";
import { db } from "./db";
import { HttpError } from "./errors";
import { generateHint } from "./hints";
import { noContent, readJson } from "./http";
import type { Language, Signature } from "./languages";
import { rateLimit, type RateLimit } from "./rateLimit";
import { allPassed, evalAtStep, runTests, traceCode, type RunResult, type TestCase } from "./runner";
import { getSession, requireUser } from "./session";

type IdParams = { id: string };

const idParam = z.object({ id: z.coerce.number().int().positive() });
const codeBody = z.object({ code: z.string().max(20_000) });
const expression = z.string().trim().min(1).max(200);
const debugBody = codeBody.extend({
  args: z.array(z.unknown()).max(20),
  conditions: z.array(z.object({ line: z.number().int().positive(), expr: expression })).max(50).default([]),
});
const evalBody = debugBody.extend({
  step: z.number().int().min(0),
  frame: z.number().int().min(0),
  expressions: z.array(expression).min(1).max(20),
});
const debugLimit: RateLimit = { name: "debug", windowMs: 60_000, limit: 240 };
// Every run/submit starts a sandbox (and compiles, for Java/C/C++), so cap how often one user can do it.
const gradeLimit: RateLimit = {
  name: "grade",
  windowMs: 60_000,
  limit: 30,
  message: "You're running code very quickly. Wait a moment and try again.",
};
const hintLimit: RateLimit = {
  name: "hint",
  windowMs: 60 * 60_000,
  limit: 10,
  message: "You've used your 10 hints for this hour. Try the debugger in the meantime!",
};
const hintBody = codeBody.extend({
  failing: z
    .object({ args: z.array(z.unknown()).max(20), expected: z.unknown(), actual: z.string().max(2000).optional(), error: z.string().max(2000).optional() })
    .optional(),
});

type ProblemRow = {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  entry_point: string;
  buggy_code: string;
  tests: TestCase[];
  visible_test_count: number;
  language: Language;
  signature: Signature | null;
  solved: boolean;
  challenge_owner: string | null;
  challenge_kind: ChallengeKind | null;
  challenge_period: string | null;
  is_challenge: boolean;
};

type LoadedProblem = ProblemRow & { challenge: { kind: ChallengeKind; endsAt: string } | null };

/**
 * Loads a problem as seen by the given user. Challenge problems are personal: only their owner can see them,
 * and once the period ends without a passing submission they're gone (410 until the cleanup deletes them).
 */
async function loadProblem(params: IdParams, userId: string | null): Promise<LoadedProblem> {
  const { id } = idParam.parse(params);
  const { rows } = await db().query<ProblemRow>(
    `SELECT p.id, p.title, p.description, p.difficulty, p.entry_point, p.buggy_code, p.tests, p.visible_test_count,
            p.language, p.signature, p.is_challenge,
            EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = $2 AND s.passed) AS solved,
            c.user_id AS challenge_owner, c.kind AS challenge_kind,
            to_char(c.period_start, 'YYYY-MM-DD') AS challenge_period
     FROM problems p LEFT JOIN challenges c ON c.problem_id = p.id
     WHERE p.id = $1`,
    [id, userId],
  );
  const row = rows[0];
  // A challenge problem whose challenge row is gone (e.g. its owner was deleted) has no owner left: keep it private.
  if (!row || (row.is_challenge && (!row.challenge_owner || row.challenge_owner !== userId))) {
    throw new HttpError(404, "Problem not found");
  }
  if (!row.challenge_kind || !row.challenge_period) return { ...row, challenge: null };
  const endsAt = periodEndsAt(row.challenge_kind, row.challenge_period);
  if (endsAt.getTime() <= Date.now() && !row.solved) {
    throw new HttpError(410, `This ${row.challenge_kind} challenge has expired. Start a new one from the problems page.`);
  }
  return { ...row, challenge: { kind: row.challenge_kind, endsAt: endsAt.toISOString() } };
}

function eventOf(userId: string, p: LoadedProblem, kind: "run" | "submit" | "debug" | "hint") {
  return { userId, kind, problemId: p.id, language: p.language, difficulty: p.difficulty };
}

/** Languages the runner can trace (runner/languages TRACERS); keep in sync with lib/languages.ts. */
const debuggable: ReadonlySet<Language> = new Set(["python", "javascript", "typescript", "java", "c", "cpp"]);

function requireDebuggable(p: LoadedProblem) {
  if (!debuggable.has(p.language)) throw new HttpError(400, `The debugger doesn't support ${p.language} yet`);
}

/**
 * Grades against every test. Visible tests are always shown in full; of the hidden tests only the
 * first failing one is revealed (LeetCode-style) so there's something to debug without leaking the whole set.
 */
function publicResults(run: RunResult, problem: ProblemRow) {
  const total = problem.tests.length;
  // A compile error or timeout yields no per-test results, so every test counts as failed.
  const results = problem.tests.map((t, i) => ({ ...t, ...(run.results[i] ?? { passed: false }) }));
  const failedHidden = results
    .map((r, i) => ({ ...r, testNumber: i + 1 }))
    .slice(problem.visible_test_count)
    .filter((r) => !r.passed);
  return {
    status: run.status,
    error: run.error,
    passed: allPassed(run, total),
    passedCount: results.filter((r) => r.passed).length,
    totalCount: total,
    visibleResults: results.slice(0, problem.visible_test_count),
    hiddenFailure: run.status === "ok" ? failedHidden[0] : undefined,
    hiddenFailureCount: failedHidden.length,
  };
}

function saveDraft(userId: string, problemId: string, code: string) {
  return db().query(
    `INSERT INTO drafts (user_id, problem_id, code) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, problem_id) DO UPDATE SET code = EXCLUDED.code, updated_at = now()`,
    [userId, problemId, code],
  );
}

async function gradeProblem(req: NextRequest, params: IdParams, userId: string) {
  const p = await loadProblem(params, userId);
  const { code } = codeBody.parse(await readJson(req));
  // Whatever was run or submitted is the user's latest work, even if an autosave never landed.
  const [run] = await Promise.all([
    runTests(code, p.entry_point, p.tests, p.language, p.signature),
    saveDraft(userId, p.id, code),
  ]);
  return { p, code, result: publicResults(run, p) };
}

export async function listProblems() {
  const userId = (await getSession())?.userId ?? null;
  const { rows } = await db().query(
    `SELECT p.id, p.title, p.difficulty, p.language, p.created_at,
            EXISTS (SELECT 1 FROM submissions s
                    WHERE s.problem_id = p.id AND s.user_id = $1 AND s.passed) AS solved
     FROM problems p
     WHERE NOT p.is_challenge -- challenges are personal
     ORDER BY p.created_at DESC`,
    [userId],
  );
  return Response.json({ problems: rows });
}

export async function getProblem(_req: NextRequest, params: IdParams) {
  const userId = (await getSession())?.userId ?? null;
  const p = await loadProblem(params, userId);
  if (userId) {
    after(() =>
      db()
        .query("INSERT INTO problem_attempts (user_id, problem_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, p.id])
        .catch((err) => console.warn("attempt not recorded", err)),
    );
  }
  const { rows } = await db().query<{ saved_code: string }>(
    "SELECT code AS saved_code FROM drafts WHERE problem_id = $1 AND user_id = $2",
    [p.id, userId],
  );
  // The same problem in other languages is a separate row sharing the title. Challenges are personal, so they have none.
  const { rows: variants } = p.challenge
    ? { rows: [{ id: p.id, language: p.language }] }
    : await db().query<{ id: string; language: Language }>(
        `SELECT DISTINCT ON (p.language) p.id, p.language FROM problems p
         WHERE p.title = $1 AND NOT p.is_challenge
         ORDER BY p.language, p.id = $2 DESC, p.id`,
        [p.title, p.id],
      );
  return Response.json({
    problem: {
      solved: p.solved,
      savedCode: rows[0]?.saved_code ?? null,
      language: p.language,
      signature: p.signature,
      challenge: p.challenge,
      id: p.id,
      title: p.title,
      description: p.description,
      difficulty: p.difficulty,
      entryPoint: p.entry_point,
      buggyCode: p.buggy_code,
      examples: p.tests.slice(0, p.visible_test_count),
      totalTests: p.tests.length,
      variants,
    },
  });
}

export async function putDraft(req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  const p = await loadProblem(params, userId);
  const { code } = codeBody.parse(await readJson(req));
  await saveDraft(userId, p.id, code);
  return noContent();
}

/** Resetting discards the draft, so the problem opens with the original buggy code again. */
export async function deleteDraft(_req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  const { id } = idParam.parse(params);
  await db().query("DELETE FROM drafts WHERE user_id = $1 AND problem_id = $2", [userId, id]);
  return noContent();
}

// Run and Submit grade identically against every test; only Submit records the attempt.
export async function runProblem(req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  await rateLimit(gradeLimit, userId);
  const { p, result } = await gradeProblem(req, params, userId);
  recordEvent({ ...eventOf(userId, p, "run"), passed: result.passed, passedCount: result.passedCount, totalCount: result.totalCount });
  return Response.json(result);
}

export async function submitProblem(req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  await rateLimit(gradeLimit, userId);
  const { p, code, result } = await gradeProblem(req, params, userId);
  await db().query(
    `INSERT INTO submissions (user_id, problem_id, code, passed, passed_count, total_count, language)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, p.id, code, result.passed, result.passedCount, result.totalCount, p.language],
  );
  recordEvent({ ...eventOf(userId, p, "submit"), passed: result.passed, passedCount: result.passedCount, totalCount: result.totalCount });
  return Response.json(result);
}

// Debug args come from the client (an example, the revealed hidden failure, or custom input),
// so these endpoints never expose hidden test data.
export async function debugProblem(req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  await rateLimit(debugLimit, userId);
  const p = await loadProblem(params, userId);
  requireDebuggable(p);
  const { code, args, conditions } = debugBody.parse(await readJson(req));
  recordEvent(eventOf(userId, p, "debug"));
  return Response.json(await traceCode(code, p.entry_point, args, conditions, p.language, p.signature));
}

export async function evalProblem(req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  await rateLimit(debugLimit, userId);
  const p = await loadProblem(params, userId);
  requireDebuggable(p);
  const { code, args, conditions, ...at } = evalBody.parse(await readJson(req));
  return Response.json(await evalAtStep(code, p.entry_point, args, { ...at, conditions }, p.language, p.signature));
}

// AI hint from Gemini: a nudge about the student's code, never the fix.
export async function hintProblem(req: NextRequest, params: IdParams) {
  const userId = await requireUser();
  await rateLimit(hintLimit, userId);
  const p = await loadProblem(params, userId);
  const { code, failing } = hintBody.parse(await readJson(req));
  const { rows } = await db().query<{ fixed_code: string }>("SELECT fixed_code FROM problems WHERE id = $1", [p.id]);
  const hint = await generateHint({
    title: p.title,
    description: p.description,
    language: p.language,
    code,
    referenceCode: rows[0].fixed_code,
    failing,
  });
  recordEvent(eventOf(userId, p, "hint"));
  return Response.json({ hint });
}
