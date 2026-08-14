import type { BudgetConfig } from '../config/screening-schema.js';
import type { LlmCallRepository } from '../db/repositories/screenings.js';
import { nowIso } from '../util/time.js';

/**
 * Budget enforcement.
 *
 * A budget is a hard stop, not a warning. When it is reached the run ends
 * cleanly and reports what remains queued, because a tool that quietly keeps
 * spending is worse than one that stops early.
 */

export interface BudgetState {
  jobsEvaluated: number;
  scanCostUsd: number;
  monthCostUsd: number;
}

export type BudgetVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; limit: string };

export class BudgetGuard {
  private jobsEvaluated = 0;
  private scanCostUsd = 0;

  constructor(
    private readonly config: BudgetConfig,
    private readonly monthCostUsd: number,
  ) {}

  /** Month-to-date spend, so a long-running search cannot creep past the cap. */
  static monthToDateCost(calls: LlmCallRepository): number {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return calls.totalCost(start.toISOString());
  }

  check(): BudgetVerdict {
    if (this.jobsEvaluated >= this.config.max_jobs_per_scan) {
      return {
        allowed: false,
        reason: `reached the per-run limit of ${this.config.max_jobs_per_scan} roles`,
        limit: 'max_jobs_per_scan',
      };
    }

    if (this.scanCostUsd >= this.config.max_cost_per_scan_usd) {
      return {
        allowed: false,
        reason: `reached the per-run spend limit of $${this.config.max_cost_per_scan_usd.toFixed(2)}`,
        limit: 'max_cost_per_scan_usd',
      };
    }

    if (this.monthCostUsd + this.scanCostUsd >= this.config.max_cost_per_month_usd) {
      return {
        allowed: false,
        reason: `reached the monthly spend limit of $${this.config.max_cost_per_month_usd.toFixed(2)}`,
        limit: 'max_cost_per_month_usd',
      };
    }

    return { allowed: true };
  }

  recordJob(costUsd: number): void {
    this.jobsEvaluated += 1;
    this.scanCostUsd += costUsd;
  }

  /** Spend that happened without completing a job, e.g. a failed call. */
  recordCost(costUsd: number): void {
    this.scanCostUsd += costUsd;
  }

  state(): BudgetState {
    return {
      jobsEvaluated: this.jobsEvaluated,
      scanCostUsd: Number(this.scanCostUsd.toFixed(6)),
      monthCostUsd: Number((this.monthCostUsd + this.scanCostUsd).toFixed(6)),
    };
  }

  get stopsOnExhaustion(): boolean {
    return this.config.on_exhausted === 'stop';
  }

  static timestamp(): string {
    return nowIso();
  }
}
