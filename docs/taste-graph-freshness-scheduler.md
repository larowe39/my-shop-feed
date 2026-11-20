# Taste Graph freshness scheduler

The [workflow](../.github/workflows/taste-graph-freshness.yml) runs the existing
one-shot worker, not a second implementation:

```sh
npm run taste:worker -- --run --batch-size 5
```

Each invocation makes exactly **one bounded claim of at most five jobs**,
including when the queue is empty. It does not poll, drain the queue, or retry
the command within a run. Queue debounce, leases, generation checks, retries,
and blocking remain unchanged; see [worker details](./taste-graph.md).

## Credentials and activation

In repository **Settings > Secrets and variables > Actions**, add:

- `SUPABASE_URL`: the production Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the legacy JWT with role `service_role`.
  The existing worker rejects anon/authenticated and opaque API keys.

These are repository Actions secrets, exposed only to the worker step, not
dependency installation. Never use `EXPO_PUBLIC_*` for the service-role key,
commit credentials, or print them during troubleshooting.

Node **24** is pinned for the worker's native TypeScript stripping and satisfies
the locked React Native (`>=20.19.4`) and Supabase (`>=20`) requirements.
`npm ci` installs reproducibly from the unchanged `package-lock.json`.
Actions are pinned by commit; the GitHub token has only `contents: read`, and
checkout does not persist it.

Opening or pushing this draft PR does **not** invoke the worker: the only
triggers are `schedule` and `workflow_dispatch`, and scheduled runs require the
workflow on the default branch. The job also rejects non-default-branch runs.
**Merging into `main` enables the schedule** when Actions is enabled; do not
merge until production activation is approved. Before merging, confirm both
freshness migrations are deployed (do not edit or reapply deployed migrations),
the Supabase API row limit is at least 500, staging checks are complete, secrets
are configured, and an operator owns failure monitoring. Do not race this
worker with the unguarded administrative `taste:rebuild --apply` path.
No `pg_cron` or `pg_net` is needed.

## Cadence and freshness

Cron: **`2-59/5 * * * *`**, every five minutes UTC at minutes
02, 07, 12, ..., 57. This is the
[shortest interval GitHub officially supports](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule);
the offset avoids the start-of-hour load spike.

This is **not** a 40-second or 90-second freshness guarantee. Those are queue
eligibility bounds, not scheduler intervals. With no backlog or Actions delay,
eligible work waits up to about five minutes for a claim, plus runner setup and
replay time. From an event, allow the 40-second quiet debounce (or 90-second
starvation cap under continuing events), that scheduling wait, and processing.
A newer generation during replay requires a later invocation. Nominal capacity
is at most five users per five-minute tick (60 claims/hour); backlog, retry
backoff, blocking, or supersession increases freshness lag.

GitHub may delay or drop scheduled runs, so there is no hard freshness SLA.
Public-repository schedules may also be disabled after 60 days of inactivity.
Monitor run history and queue lag rather than assuming every tick ran.

## Manual runs, serialization, and limits

After approval and merge, use **Actions > Taste Graph freshness > Run workflow**,
select `main`, and run once. This is a production write, not a dry run.
Manual runs use the same fixed batch, secrets, timeouts, and concurrency group;
there is no batch-size override.

The fixed group `taste-graph-freshness-production` serializes scheduled and
manual runs across refs. `cancel-in-progress: false` lets an active lease-owning
worker finish rather than interrupting it for the next tick. GitHub retains at
most one pending run in the group; later arrivals can replace pending runs.
This guard does not coordinate workers started outside this workflow.

The job timeout is **10 minutes**, allowing checkout and installation as well
as worker execution. The worker step timeout is **5 minutes**, above its
240-second internal budget plus the separate 10-second failure-report budget.
A hung process is terminated visibly. An interrupted run can leave leases to
expire; the existing claim RPC handles recovery on later invocations.

## Stop immediately and investigate failures

1. In **Actions > Taste Graph freshness > ... > Disable workflow**, disable
   future scheduled/manual starts. Alternatively:
   `gh workflow disable taste-graph-freshness.yml --repo larowe39/my-shop-feed`.
2. Disabling does not stop already active or pending runs. Inspect the workflow
   run list and **Cancel workflow** on each active/pending run if immediate
   cessation is required. Cancellation can leave leases until expiry; do not
   clear them or manually acknowledge work.
3. To inspect a failure, open its run and the failed step's log. For CLI
   inspection, use
   `gh run view RUN_ID --log-failed --repo larowe39/my-shop-feed`.
   Check install/setup failures, missing or invalid secrets, timeouts, and the
   worker's JSON statuses/errors without printing secret values.

The command's nonzero exit is not suppressed: `retry_scheduled`, `blocked`,
`failure_unreported`, and thrown errors fail the run. An empty queue or
`stale_generation` is a normal successful outcome. Fix the cause and let later
invocations honor the queue's retry/backoff. Blocked jobs require a service-role
operator to call the existing `requeue_taste_graph_rebuild(user_id)` after the
cause is resolved; Actions reruns alone do not unblock them. Watch for blocked
jobs even when subsequent empty batches succeed.

Re-enable only after approval via the same workflow menu or `gh workflow enable`.
