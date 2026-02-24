/**
 * Scheduler for OpenBridge scheduled sessions.
 *
 * Runs a periodic check loop that fires due schedules by creating
 * threads and running full backend sessions via the router.
 */

import { CronExpressionParser } from 'cron-parser';

/** Default scheduler tick interval in milliseconds (60 seconds). */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * Compute the next run time from a cron expression.
 * Returns an ISO 8601 datetime string.
 * Throws if the cron expression is invalid.
 */
export function computeNextRun(cronExpression: string): string {
  const interval = CronExpressionParser.parse(cronExpression);
  const next = interval.next();
  return next.toISOString()!;
}
