/**
 * Scheduler for OpenBridge scheduled sessions.
 *
 * Runs a periodic check loop that fires due schedules by creating
 * threads and running full backend sessions via the router.
 */

import { CronExpressionParser } from 'cron-parser';
import type { Store, Schedule } from './store.js';
import type { Router } from './router.js';
import type { Adapter } from './types/adapter.js';

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

export interface SchedulerOptions {
  /** Tick interval in milliseconds. Defaults to DEFAULT_TICK_INTERVAL_MS (60s). */
  tickIntervalMs?: number;
}

export class Scheduler {
  private store: Store;
  private router: Router;
  private adapters: Map<string, Adapter>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickIntervalMs: number;
  private ticking = false;

  constructor(
    store: Store,
    router: Router,
    adapters: Map<string, Adapter>,
    options?: SchedulerOptions,
  ) {
    this.store = store;
    this.router = router;
    this.adapters = adapters;
    this.tickIntervalMs = options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /** Start the scheduler loop. Runs an immediate tick, then repeats at the configured interval. */
  start(): void {
    if (this.timer) return;
    console.log(`[scheduler] started (interval: ${this.tickIntervalMs}ms)`);
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    // Fire immediately on start
    this.tick();
  }

  /** Stop the scheduler loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[scheduler] stopped');
    }
  }

  /** Check for due schedules and fire them. */
  async tick(): Promise<void> {
    // Prevent overlapping ticks
    if (this.ticking) return;
    this.ticking = true;

    try {
      const now = new Date().toISOString();
      const due = this.store.getDueSchedules(now);
      if (due.length > 0) {
        console.log(`[scheduler] ${due.length} schedule(s) due`);
      }
      for (const schedule of due) {
        try {
          await this.fire(schedule);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] failed to fire schedule ${schedule.id}: ${msg}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Fire a single schedule: create thread, run session, handle aftermath. */
  private async fire(schedule: Schedule): Promise<void> {
    const project = this.store.getProjectById(schedule.project_id);
    if (!project) {
      console.warn(`[scheduler] schedule ${schedule.id}: project ${schedule.project_id} not found — deactivating`);
      this.store.deactivateSchedule(schedule.id);
      return;
    }

    const adapter = this.adapters.get(project.platform);
    if (!adapter) {
      console.warn(`[scheduler] schedule ${schedule.id}: no adapter for platform '${project.platform}' — deactivating`);
      this.store.deactivateSchedule(schedule.id);
      return;
    }

    console.log(`[scheduler] firing schedule ${schedule.id}: "${schedule.original_request}"`);

    // One-time schedules with a stored thread_id reply in the original thread.
    // Recurring schedules always create a new thread.
    let threadId: string;
    if (!schedule.is_recurring && schedule.thread_id) {
      threadId = schedule.thread_id;
      console.log(`[scheduler] schedule ${schedule.id}: replying in original thread ${threadId}`);
    } else {
      threadId = await adapter.createThread(
        schedule.channel_id,
        `Scheduled: ${schedule.original_request}`,
      );
    }

    // Run the session through the router (same path as user messages)
    try {
      const result = await this.router.send(schedule.channel_id, threadId, schedule.prompt);

      // Post any assistant_text events that weren't already posted via post_message MCP tool
      for (const event of result.events) {
        if (event.type === 'assistant_text' && event.text) {
          await adapter.sendMessage(schedule.channel_id, threadId, event.text);
        } else if (event.type === 'error') {
          await adapter.sendMessage(schedule.channel_id, threadId, `Error: ${event.message}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] session failed for schedule ${schedule.id}: ${msg}`);
      await adapter.sendMessage(schedule.channel_id, threadId, `Scheduled session failed: ${msg}`);
    }

    // Update schedule: advance next_run_at for recurring, deactivate one-time
    if (schedule.is_recurring && schedule.cron_expression) {
      try {
        const nextRun = computeNextRun(schedule.cron_expression);
        this.store.updateNextRun(schedule.id, nextRun);
        console.log(`[scheduler] schedule ${schedule.id}: next run at ${nextRun}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to compute next run for schedule ${schedule.id}: ${msg} — deactivating`);
        this.store.deactivateSchedule(schedule.id);
      }
    } else {
      this.store.deactivateSchedule(schedule.id);
      console.log(`[scheduler] schedule ${schedule.id}: one-time schedule completed`);
    }
  }
}
