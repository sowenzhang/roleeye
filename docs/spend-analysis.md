# Spend Analysis

Written before Phase 2 so that scope filtering, caching, and budget enforcement
are designed in rather than retrofitted after the first surprising bill.

All token figures come from real postings, not estimates.
`scripts/measure-corpus.ts` reproduces the measurement.

## Measured corpus

227 postings from three public Greenhouse boards (Airtable, Discord, Figma):

| Metric | Value |
|---|---|
| Median description | 1,532 tokens |
| Mean description | 1,520 tokens |
| p90 / p99 | 1,883 / 2,145 tokens |
| Largest board sampled | 159 postings |
| Estimated boilerplate share | ~44% |

Two facts drive everything below: descriptions are **uniformly ~1,500 tokens**
(there is no long tail to optimize away), and **~44% of that is benefits, EEO,
privacy, and marketing text** that contributes nothing to a fit judgement.

## What the naive design costs

Assume a realistic watch list: 30 boards averaging 80 postings ≈ 2,400 postings.
A four-call evaluation (extract → advocate → skeptic → judge), each call carrying
the profile plus the full description, is roughly **10,800 input + 1,500 output
tokens per role**.

| | Input tokens | Output tokens |
|---|---:|---:|
| First full pass (2,400 roles) | 25.9M | 3.6M |
| Every subsequent scan, uncached | 25.9M | 3.6M |

At frontier pricing around $1.25/M input and $10/M output that is roughly **$68
for the first pass**, repeated on every scan if nothing is cached. Even at a 3%
daily churn rate, re-evaluating unchanged postings dominates the bill.

The problem is not the price of the model. It is evaluating roles the user never
wanted, re-evaluating roles that did not change, and sending boilerplate.

## What the designed pipeline costs

| Stage | Cost | Corpus after |
|---|---|---:|
| Discovery scope filter (§36) | free | ~200 |
| Hard filters | free | ~120 |
| Authenticity signals (§37) | free | ghosts and scams removed |
| Cache on `description_hash` + profile/criteria version | free | steady state → ~0 |
| Boilerplate stripping | free | 1,500 → ~850 tokens each |
| Triage on a small model | ~$0.06 | ~25 |
| Advocate / Skeptic / Judge | ~$0.50 | ~25 evaluated |

**First pass ≈ $0.60 against ≈ $68.** Steady-state daily scans cost cents,
because unchanged postings and reposts with identical content are free.

The two orders of magnitude come from filtering and caching. No analysis quality
is sacrificed: roles that matter still get the full three-perspective treatment.

## Where the savings actually come from

Ranked by impact:

1. **Scope filtering** (~92% reduction). The largest single lever, and it is
   free, deterministic, and user-controlled. It is also the fix for the noise
   problem, not only the cost problem.
2. **Content caching** (~95% of steady-state calls). Keyed by content hash plus
   profile and criteria versions, so changing preferences correctly invalidates.
3. **Triage escalation** (~80% of remaining roles). A small model separates
   plausible from implausible; only plausible roles reach a frontier model.
4. **Boilerplate stripping** (~44% of tokens on every call that does happen).
5. **Authenticity screening**. Cheap deterministic signals prevent paying to
   analyze a ghost listing.

## Budget enforcement

Limits live in configuration, are enforced in code, and are hard stops:

```yaml
budget:
  max_jobs_per_scan: 40
  max_cost_per_scan_usd: 1.00
  max_cost_per_month_usd: 20.00
  on_exhausted: stop
```

When a budget is exhausted the scan stops cleanly, reports what remains queued,
and exits with the warning code. Remaining work is picked up on the next run. It
never silently continues spending.

## Accounting

Every model call records stage, provider, model, input tokens, output tokens,
estimated cost, and whether it was a cache hit (`llm_calls`, architecture §38).
`roleeye stats --cost` reports spend by day, stage, and model.

Providers billed per request rather than per token — Copilot CLI, for example —
record `request_count` and leave cost null. The interface must not assume
token-based billing.

## Assumptions and how to revisit them

- Token estimate uses ~4 characters per token. Adequate for budgeting, not for
  billing; real usage figures replace it once a provider is wired up.
- Prices are illustrative and live in configuration, never in code.
- The 30-board / 80-posting profile is an assumption. `roleeye scope test`
  reports the real number for a given user's configuration.
- Boilerplate share was estimated by keyword-anchored section detection; the
  actual stripper should be measured against this baseline when it lands.
