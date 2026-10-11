import type { PoolClient } from "pg";
import { HttpError } from "./errors";
import { type Difficulty, type GeneratedProblem, generateProblem } from "./gemini";
import type { Language } from "./languages";
import type { RateLimit } from "./rateLimit";
import { allPassed, runTests } from "./runner";

export const VISIBLE_TESTS = 2;
const GENERATION_ATTEMPTS = 3;

/** One hourly budget shared by every endpoint that calls the model (practice problems and challenges). */
export const generationLimit: RateLimit = { name: "generation", windowMs: 60 * 60_000, limit: 20 };

/** A generated problem is only usable if the reference solution passes every test and the buggy one doesn't. */
async function isValidExercise(p: GeneratedProblem) {
  const [fixed, buggy] = await Promise.all([
    runTests(p.fixedCode, p.entryPoint, p.tests, p.language, p.signature),
    runTests(p.buggyCode, p.entryPoint, p.tests, p.language, p.signature),
  ]);
  if (!allPassed(fixed, p.tests.length)) {
    console.warn(`reference ${p.language} solution failed`, fixed.error ?? fixed.results.filter((r) => !r.passed).slice(0, 2));
  }
  return allPassed(fixed, p.tests.length) && !allPassed(buggy, p.tests.length);
}

export async function generateVerifiedProblem(difficulty: Difficulty, language: Language): Promise<GeneratedProblem> {
  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt++) {
    let problem: GeneratedProblem;
    try {
      problem = await generateProblem(difficulty, language);
    } catch (err) {
      console.warn(`generation attempt ${attempt} (${language}) returned unusable output`, err);
      continue;
    }
    if (await isValidExercise(problem)) return problem;
    console.warn(`generation attempt ${attempt} (${language}) failed verification`);
  }
  throw new HttpError(502, "Could not generate a valid problem. Please try again.");
}

export async function insertProblem(
  client: Pick<PoolClient, "query">,
  problem: GeneratedProblem,
  difficulty: Difficulty,
  userId: string,
  isChallenge = false,
) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO problems (title, description, difficulty, entry_point, buggy_code, fixed_code, tests,
                           visible_test_count, created_by, language, signature, is_challenge)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      problem.title,
      problem.description,
      difficulty,
      problem.entryPoint,
      problem.buggyCode,
      problem.fixedCode,
      JSON.stringify(problem.tests),
      VISIBLE_TESTS,
      userId,
      problem.language,
      JSON.stringify(problem.signature),
      isChallenge,
    ],
  );
  return rows[0].id;
}
