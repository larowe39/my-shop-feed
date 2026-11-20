# PENCHANT agent guidance

## Architecture and conventions

- Expo/React Native uses Expo Router file-based routes in `app/`, shared UI in
  `components/`, hooks in `hooks/`, and domain logic in `lib/`. Keep routing and
  presentation separate from reusable domain logic; use the existing TypeScript
  strict configuration and `@/` alias.
- Supabase provides authentication, data, RLS, migrations in
  `supabase/migrations/`, and Edge Functions in `supabase/functions/`. Client
  configuration uses the public URL and anon key; service-role credentials are
  server-only and must never be exposed in app code, logs, or commits.
- Catalog acquisition, matching, staging, review, and promotion are separate
  gates. See `docs/catalog-acquisition-pipeline.md` and `docs/catalog-data.md`.
  Taste Graph uses append-only events, deterministic replay, and a bounded,
  generation-checked freshness worker; see `docs/taste-graph.md` and
  `docs/taste-graph-freshness-scheduler.md`.
- Make focused changes, preserve existing behavior and tests, and add regression
  coverage for changed behavior. Do not edit already-deployed migrations.

## Required checks

Use Node 24 and `npm ci`. Before requesting review, run the PR checks:

```sh
EXPO_NO_DOTENV=1 npm run lint
npx tsc --noEmit
npm run catalog:validate
npm run catalog:test
npm run catalog:matcher-test
npm run catalog:matcher-equivalence-test
npm run catalog:matcher-differential-test
npm run taste:test
npm run taste:onboarding-test
npm run taste:freshness-test
npm run taste:for-you-test
```

Also run relevant additional existing tests from `package.json` for the
affected area. For RLS, freshness RPC, or migration changes, run
`npm run taste:freshness-db-test` when Docker is available: it uses a disposable
network-isolated PostgreSQL container, not a production database. Report any
checks not run and why. PR checks do not cover Edge Function type checking,
database integration, device behavior, or live services.

## Production safety

- Do not run catalog `--apply`, approve/promote catalog data, apply migrations,
  write to production Supabase, change secrets, or deploy as part of routine
  agent work. These require a separate explicit owner authorization and
  operational review; never put production credentials in PR checks.
- Do not weaken RLS, tests, or the Taste Graph scheduler's default-branch guard,
  bounded execution, concurrency, and failure handling. Do not invoke the
  production worker or the administrative rebuild against production while
  developing. Preserve dry-run and human review gates.
- For issue #40, do not modify or merge PR #33, and do not perform any of the
  production actions above. No auto-merge.

## Issue-to-review workflow

1. Owner writes a bounded issue with acceptance criteria and safety constraints
   and assigns it to Copilot coding agent where available.
2. Agent inspects instructions and existing checks, implements the scoped
   change, records test results and limitations, and opens or maintains a draft
   PR linked to the issue.
3. An authorized human approves any required Actions runs for the agent PR.
   Wait for `PR checks` / `verify` on the current head; investigate failures
   rather than bypassing them. This workflow runs on `pull_request` with a
   read-only token, no checkout credentials, and no production secrets.
4. Request an independent human reviewer who did not author the changes.
   Copilot code review can supplement, not replace, that review. Address
   feedback and rerun checks after changes.
5. Owner reviews the diff, test outcomes, unresolved risks and approvals, then
   explicitly approves before a human marks ready and merges. No auto-merge.
   If an independent human or required check is unavailable, leave the PR
   draft and blocked.

## Owner approval and GitHub settings checklist

These are owner actions, not settings changed by this PR:

- [ ] Confirm Copilot coding agent access, repository policy, licensing and
  Actions availability for the intended users. Agent runs and Copilot code
  reviews have occurred in this repository, but that does not prove access for
  every user or future task.
- [ ] Review Actions permissions and fork/agent workflow approval policies;
  permit the PR workflow to run without exposing secrets or write tokens to
  untrusted PR code. Approve agent-triggered runs when GitHub requires it.
- [ ] Configure a ruleset or branch protection on the default branch to require
  the `verify` status check from `PR checks` and at least one independent
  human PR approval; restrict bypasses and direct pushes as appropriate.
  Verify the check appears after its first run before requiring it. Verify the
  plan and repository visibility support the chosen protections.
- [ ] Decide whether to enable Copilot code review as an additional review,
  and assign an eligible independent human reviewer. Do not rely on an AI
  review as owner approval.
- [ ] Keep auto-merge disabled; inspect the current-head checks, independent
  review, safety implications, and test limitations before explicit approval
  and a manual merge. For this PR, confirm PR #33 and production remain untouched.
