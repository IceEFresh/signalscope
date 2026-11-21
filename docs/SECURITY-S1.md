# S1: security fixes (CodeQL and dependency audit)

Chris asked for the CodeQL and Dependabot items to be dealt with. Branch: `plan/s1-security`, branched from `main` after #14–#17 merge. One PR, titled `[S1] Security fixes`.

## Findings at main 622d3b7 (2026-11-20)

The reviewer ran CodeQL 2.27.5 (code-scanning suites for JavaScript/TypeScript, Actions and Python) locally, because the session token can't read the Security tab. It also ran `npm audit`.

### CodeQL

| Rule | Location | Action |
|---|---|---|
| `js/double-escaping` | `src/lib/harvester/sources/stocktwits.ts:82` | Fix. Decode `&amp;` **last**, after `&quot;`, `&#39;`, `&lt;` and `&gt;`, or use one decode pass with a lookup map. Add a test where `&amp;lt;` decodes to `&lt;`, not `<`. |
| `js/incomplete-multi-character-sanitization` | `src/lib/harvester/sources/sec-insider.ts:62` and `:89` | Fix. After stripping tags, remove any remaining `<` and `>`, so the text can't keep a partial tag. Add a test with nested `<<script>script>`. |
| `js/insecure-randomness` | `src/app/api/auth/register/route.ts:73`, `src/app/api/user/profile/route.ts:22` (`generateUsername`) | Fix. Use `crypto.randomInt` in `generateUsername`. The username is public and isn't a secret, but the change is one line and clears the alert. |
| `js/insufficient-password-hash` | `src/lib/auth.ts:107` | **No code change.** This is SHA-256 over an API key. The keys are random tokens with high entropy, not passwords, so a slow hash isn't needed. Chris dismisses it in the Security tab as "Won't fix: high-entropy API key". Note this in the PR body. |
| `js/incomplete-url-substring-sanitization` ×9 | `src/__tests__/sec-insider.test.ts` | Fix the tests. Compare `new URL(u).hostname === "openinsider.com"` instead of `includes`. |

The Actions and Python suites found nothing.

### npm audit (40 advisories: 4 critical, 19 high, 16 moderate, 1 low; 25 in production dependencies)

The critical ones in production are `next`, `next-auth` / `@auth/core` and `proxy-addr`. The high ones include `@x402/*`, `prisma` / `@prisma/config`, `sharp`, `zod`, `mysql2`, `body-parser`, `fast-uri`, `effect`, `deepmerge-ts` and `@modelcontextprotocol/sdk` (pulled in by `yahoo-finance2`).

1. Run `npm audit fix` without `--force`. Commit the lockfile.
2. For each advisory still open, upgrade within the current major version where a fixed version exists: `next` 16.x, `next-auth` 5 beta, `prisma` / `@prisma/client` 7.x, `vitest`, `vite`, `@x402/*`, `sharp`, `zod`.
3. A **major** bump (for example, `yahoo-finance2` for the `@modelcontextprotocol/sdk` path) needs the full test suite. If a bump breaks the harvester, leave it out and list it under QUESTIONS FOR CHRIS with the advisory, whether the vulnerable path is reachable here, and the upgrade cost.
4. Don't add or remove dependencies. Removing x402 is a feature decision for Chris; ask him.
5. End with `npm audit --omit=dev` and `npm audit` output in the PR body: before, after, and a reason for each advisory left open.

## Constraints

- No score, stage, label or rule changes. No migration.
- The image must still build on the NAS (`docker compose build`; Node 22, linux/amd64).
- All four CI checks pass, and the CodeQL check on the PR shows no new alerts.

## For Chris after merge

- In GitHub → Security → Code scanning, dismiss the `js/insufficient-password-hash` alert as "Won't fix", with the reason above.
- Check that Dependabot alerts are switched on for the fork (Settings → Code security). The API showed 0 open Dependabot alerts while `npm audit` showed 40, which suggests alerts were never enabled after forking.
