# ACO Studio Agent Operating System

## Mission

Build and maintain ACO Studio as a secure, production-ready TypeScript
application for customer order, mailbox, shipment, and ETL workflows. The
current repository is a Node 22 + TypeScript + Vite + React + Express +
PostgreSQL application deployed as a Render web service. Render Workflows and
OpenAI-powered batch parsing are supported architectural options, not assumed
to exist until their code, service definition, and tests are present.

## Agent hierarchy and file routing

The coordinator owns the final plan, integration, and acceptance decision.
Read the smallest applicable specialist instructions before making changes:

- `agents/frontend/AGENT.md` — React/Vite UI, browser behavior, accessibility,
  client state, API consumption, and frontend tests.
- `agents/backend/AGENT.md` — Express APIs, PostgreSQL, migrations, IMAP,
  encryption, authentication, validation, and backend tests.
- `agents/render-workflows/AGENT.md` — Render Workflows, ETL decomposition,
  task contracts, retries, concurrency, idempotency, and operations.
- `agents/openai-data/AGENT.md` — OpenAI API parsing, structured outputs,
  Batch API, model routing, token/cost controls, privacy, and evaluations.
- `agents/codex-routing/AGENT.md` — Codex model/reasoning-effort selection,
  delegation, context management, and review strategy.

Do not have two agents edit the same file concurrently without an explicit
ownership decision. Cross-boundary work must define the interface first.

## Repository facts

- Client: React + Vite + TypeScript; demo mode is selected by Vite mode.
- Server: Express + TypeScript, started by `tsx server/index.ts`.
- Data: PostgreSQL accessed through `pg`; migrations run with
  `npm run db:migrate`.
- Tests: Vitest, with `npm test` as the repository test command.
- Deployment: `render.yaml`/Blueprint currently defines a Node web service and
  PostgreSQL database. Do not claim that a Render Workflow exists unless a
  workflow service/task implementation has been added and deployed.
- Runtime: Node `^22.12.0 || >=24.0.0` as declared by `package.json`.
- Sensitive configuration includes `DATABASE_URL`, encryption keys, session
  secrets, portal secrets, operator credentials, mailbox credentials, and any
  OpenAI key.

## Non-negotiable rules

1. Inspect the relevant source, tests, package scripts, environment examples,
   and deployment files before editing.
2. Preserve existing user work. Never use destructive git commands or broad
   overwrites to resolve uncertainty.
3. Never print, commit, persist in fixtures, or send to an LLM secrets,
   authorization headers, mailbox passwords, session cookies, raw email bodies,
   private customer addresses, or unredacted personal data.
4. Validate all external input at the boundary with the project’s existing
   validation approach. Keep tenant/customer scope explicit in every read and
   write.
5. Make durable side effects idempotent. A retry, duplicate webhook, repeated
   sync, or repeated workflow task must not create duplicate orders, events,
   charges, messages, or customer links.
6. Keep extraction, normalization, enrichment, and loading as separate stages
   with explicit contracts and observable outcomes.
7. Do not invent current Render, OpenAI, SDK, model, pricing, limit, or API
   behavior. Verify volatile behavior against primary documentation before
   implementation and record the verification date in technical notes when it
   affects a decision.
8. Prefer deterministic code for parsing and business rules. Use an LLM only
   where it creates measurable value, and retain confidence, provenance, and
   validation results for every model-derived field.
9. Do not put OpenAI calls, long-running ETL, IMAP polling, or unbounded batch
   work in an HTTP request handler. Route them through an appropriate worker,
   job, or Render Workflow task.
10. Every change must include focused tests or explain why a test is not
    practical. Run the broadest affordable validation before handoff.

## Coordinator workflow

For each non-trivial request:

1. Classify the work as frontend, backend, Render/ETL, OpenAI data, Codex
   orchestration, or a combination.
2. Read the applicable specialist file(s) and inspect relevant code only.
3. Write an execution contract: goal, assumptions, owned files, interfaces,
   data sensitivity, failure behavior, tests, and acceptance criteria.
4. Resolve contracts/schema and ownership before implementation. Use stable
   IDs, versioned payloads, and explicit status transitions.
5. Implement in dependency order: contracts/schema → backend/workflow → API →
   frontend → tests/observability → deployment documentation.
6. Review the diff for security, scope isolation, retries, cost, and rollback.
7. Report changed files, behavior, validation commands/results, unresolved
   risks, and the next safe step.

## Definition of done

A change is complete only when the intended behavior works, scoped data access
is preserved, secrets are protected, retries cannot duplicate durable effects,
errors are actionable, tests cover important paths, observability is adequate,
and deployment/runtime assumptions are documented.

## Specialist selection matrix

| Request | Primary specialist | Required review |
|---|---|---|
| React screen, browser state, UX, accessibility | frontend | backend if API changes |
| API, database, mailbox, auth, encryption | backend | security-sensitive review |
| Long-running ETL or distributed task chain | render-workflows | backend; openai-data if model calls |
| Batch classification/extraction/enrichment | openai-data | backend; render-workflows if async |
| Agent delegation, model, effort, or review choice | codex-routing | coordinator |

