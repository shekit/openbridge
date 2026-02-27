/**
 * Router for OpenBridge.
 *
 * Maps channel/thread pairs to projects and sessions, manages backend
 * lifecycle, and enforces session state machine transitions.
 */

import type { Backend, FileAttachment, SendResult, McpServerEntry } from './types/backend.js';
import type { NormalizedEvent } from './types/events.js';
import { Store, type Project, type Session } from './store.js';
import { cleanupStagingFiles } from './utils.js';

/** Factory function that creates a Backend instance given a backend name. */
export type BackendFactory = (backendName: string) => Backend;

export interface ResolveResult {
  project: Project;
  session: Session;
}

export interface RouteResult {
  events: NormalizedEvent[];
  session: Session;
}

/** Default timeout for backend.send() in milliseconds (0 = disabled). */
const DEFAULT_TIMEOUT_MS = 0;

/** Context passed to mcpConfigFactory for generating per-session MCP config. */
export interface McpConfigContext {
  channelId: string;
  threadId: string;
  projectDir: string;
  platform: string;
}

/** Factory that creates MCP config for a backend session. */
export type McpConfigFactory = (ctx: McpConfigContext) => McpServerEntry;

export interface RouterOptions {
  /** Timeout for backend.send() in milliseconds. Default: 300000 (5 minutes). */
  timeoutMs?: number;
  /** Factory to generate MCP config for each backend session. */
  mcpConfigFactory?: McpConfigFactory;
  /** IPC server info for permission hook scripts. */
  ipc?: { port: number; secret: string };
  /** Path to compiled hook scripts directory (dist/hooks/). */
  hookScriptDir?: string;
}

/** Default idle timeout for persistent backends in ms (5 minutes). */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** How often to check for idle backends (60 seconds). */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export class Router {
  private store: Store;
  private backendFactory: BackendFactory;
  private activeBackends: Map<string, Backend> = new Map();
  private timeoutMs: number;
  private mcpConfigFactory?: McpConfigFactory;
  private ipc?: { port: number; secret: string };
  private hookScriptDir?: string;
  /** Per-thread lock to serialize concurrent sends/responds to the same thread. */
  private threadLocks: Map<string, Promise<void>> = new Map();
  /** Last activity timestamp per thread for idle timeout cleanup. */
  private lastActivity: Map<string, number> = new Map();
  /** Idle cleanup interval handle. */
  private idleCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, backendFactory: BackendFactory, options?: RouterOptions) {
    this.store = store;
    this.backendFactory = backendFactory;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mcpConfigFactory = options?.mcpConfigFactory;
    this.ipc = options?.ipc;
    this.hookScriptDir = options?.hookScriptDir;

    // Start periodic idle cleanup
    this.idleCleanupInterval = setInterval(() => this.cleanupIdleBackends(), IDLE_CHECK_INTERVAL_MS);
    // Don't prevent process exit
    if (this.idleCleanupInterval.unref) {
      this.idleCleanupInterval.unref();
    }
  }

  /**
   * Clean up backends that have been idle for longer than the timeout.
   */
  private cleanupIdleBackends(): void {
    const now = Date.now();
    for (const [threadId, lastTime] of this.lastActivity) {
      if (now - lastTime > DEFAULT_IDLE_TIMEOUT_MS) {
        // Don't kill backends with active sessions (running or waiting_for_input)
        const session = this.store.getSessionByThreadId(threadId);
        if (session && (session.state === 'running' || session.state === 'waiting_for_input')) {
          continue;
        }

        const backend = this.activeBackends.get(threadId);
        if (backend) {
          console.log(`[router] cleaning up idle backend for thread ${threadId}`);
          backend.stop().catch(() => {});
          this.activeBackends.delete(threadId);
        }
        this.lastActivity.delete(threadId);
      }
    }
  }

  /**
   * Get an existing alive backend for a thread, or create and start a new one.
   * Returns the backend ready for send().
   */
  private async getOrCreateBackend(
    threadId: string,
    project: Project,
    channelId: string,
  ): Promise<Backend> {
    // Check for existing alive backend
    const existing = this.activeBackends.get(threadId);
    if (existing && existing.isAlive()) {
      console.log(`[router] reusing persistent backend for thread ${threadId}`);
      return existing;
    }

    // Clean up dead backend if present
    if (existing) {
      this.activeBackends.delete(threadId);
    }

    // Create and initialize a new backend
    const backend = this.backendFactory(project.backend_name);

    // Set session ID before start() so SDK backends can resume the conversation
    const storedSession = this.store.getSessionByThreadId(threadId);
    if (storedSession?.backend_session_id) {
      backend.setSessionId(storedSession.backend_session_id);
      console.log(`[router] restoring session ${storedSession.backend_session_id} for thread ${threadId}`);
    }

    const mcpConfig = this.mcpConfigFactory?.({
      channelId,
      threadId,
      projectDir: project.project_dir,
      platform: project.platform,
    });
    await backend.start({
      projectDir: project.project_dir,
      mcpConfig,
      ipc: this.ipc,
      channelId,
      threadId,
      platform: project.platform,
      hookScriptDir: this.hookScriptDir,
      permissionMode: project.permission_mode,
      sandboxMode: project.sandbox_mode,
    });

    this.activeBackends.set(threadId, backend);
    return backend;
  }

  /**
   * Acquire a per-thread lock. If another operation is in progress for this
   * thread, the returned promise won't resolve until it finishes.
   * Returns a release function to call when the operation completes.
   */
  private acquireThreadLock(threadId: string): Promise<() => void> {
    const existing = this.threadLocks.get(threadId);
    let release: () => void;
    const newLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, newLock);

    const acquire = async (): Promise<() => void> => {
      if (existing) {
        console.log(`[router] thread ${threadId} is busy — queuing message`);
        await existing;
      }
      return () => {
        // Only clear if this is still the active lock (another may have queued)
        if (this.threadLocks.get(threadId) === newLock) {
          this.threadLocks.delete(threadId);
        }
        release!();
      };
    };
    return acquire();
  }

  /** Send with timeout — races backend.send() against a timeout. */
  private async sendWithTimeout(backend: Backend, text: string, files?: FileAttachment[]): Promise<SendResult> {
    if (this.timeoutMs <= 0) {
      return backend.send(text, files);
    }

    let timer: ReturnType<typeof setTimeout>;

    const result = await Promise.race([
      backend.send(text, files).then((r) => {
        clearTimeout(timer);
        return r;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(async () => {
          // Kill the orphaned backend process
          try {
            await backend.stop();
          } catch {
            // Ignore stop errors during timeout cleanup
          }
          reject(new Error(
            `Backend timed out after ${Math.round(this.timeoutMs / 1000)} seconds. ` +
            'The operation took too long and was killed.',
          ));
        }, this.timeoutMs);
      }),
    ]);

    return result;
  }

  /**
   * Resolve a channel + thread to a project and session.
   * Returns null if the channel is not bound to a project.
   * Creates a new session if the thread is unknown in a bound channel.
   */
  resolve(channelId: string, threadId: string): ResolveResult | null {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) {
      return null;
    }

    let session = this.store.getSessionByThreadId(threadId);
    if (!session) {
      session = this.store.createSession(threadId, project.id);
      console.log(`[router] created new session for thread ${threadId} in project ${project.id}`);
    }

    return { project, session };
  }

  /** Prepend context metadata (time, source platform) so the backend can reason about relative dates and message origin. */
  private prependContext(text: string, platform: string): string {
    const now = new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `[Current time: ${now}]\n[Source: ${platform}]\n[You are responding in a chat thread. Keep your final text responses succinct and scannable.]\n\n${text}`;
  }

  /** Augment prompt text with upload info for files that have staging metadata. */
  private augmentTextWithUploadInfo(text: string, files?: FileAttachment[]): string {
    if (!files || files.length === 0) return text;

    const uploadLines: string[] = [];
    for (const f of files) {
      if (f.uploadId && f.filename) {
        uploadLines.push(
          `[Uploaded file: ${f.filename} (upload_id: ${f.uploadId}). ` +
          `To save this file to the project, use the save_uploaded_file tool.]`,
        );
      }
    }

    if (uploadLines.length === 0) return text;
    return `${text}\n\n${uploadLines.join('\n')}`;
  }

  /** Clean up staging files from file attachments. */
  private cleanupFileStaging(files?: FileAttachment[]): void {
    if (!files) return;
    const paths = files
      .map((f) => f.stagingPath)
      .filter((p): p is string => !!p);
    if (paths.length > 0) {
      cleanupStagingFiles(paths);
    }
  }

  /**
   * Send a message through the backend and return normalized events.
   * Manages session state transitions and persists backend session ID.
   */
  async send(channelId: string, threadId: string, text: string, files?: FileAttachment[]): Promise<RouteResult> {
    const release = await this.acquireThreadLock(threadId);
    try {
      return await this._send(channelId, threadId, text, files);
    } finally {
      release();
    }
  }

  private async _send(channelId: string, threadId: string, text: string, files?: FileAttachment[]): Promise<RouteResult> {
    const resolved = this.resolve(channelId, threadId);
    if (!resolved) {
      throw new Error(`Channel ${channelId} is not connected to a project`);
    }

    const { project, session } = resolved;

    // If session crashed previously, auto-recover: dead → idle, clear backend session
    if (session.state === 'dead') {
      this.store.updateSessionState(session.id, 'idle');
      this.store.updateBackendSessionId(session.id, null);
      console.log(`[router] auto-recovered dead session ${session.id} — starting fresh`);
    }

    // If session is stuck in running (e.g. backend was killed without state cleanup),
    // force-recover: running → dead → idle
    if (session.state === 'running') {
      this.store.updateSessionState(session.id, 'dead');
      this.store.updateSessionState(session.id, 'idle');
      console.log(`[router] force-recovered stuck running session ${session.id}`);
    }

    // Transition to running
    this.store.updateSessionState(session.id, 'running');

    // Get or create a backend for this thread (persistent pool)
    const backend = await this.getOrCreateBackend(threadId, project, channelId);

    // Load accumulated allowed tools from the store (P12.6)
    const accumulatedTools = this.store.getAllowedTools(project.id).map(t => t.tool_pattern);
    if (accumulatedTools.length > 0) {
      backend.setAllowedTools(accumulatedTools);
    }

    // Prepend context (time + source platform) so backend can reason about dates and message origin
    const timedText = this.prependContext(text, project.platform);

    // Augment prompt with upload info so backend knows about staged files
    const augmentedText = this.augmentTextWithUploadInfo(timedText, files);

    // Track activity for idle timeout
    this.lastActivity.set(threadId, Date.now());

    let result: SendResult;
    try {
      result = await this.sendWithTimeout(backend, augmentedText, files);
    } catch (err) {
      // Backend crashed or timed out — clean up and transition to dead
      // But if cancelBackend already cleaned up, skip state transition
      try { await backend.stop(); } catch { /* ignore stop errors */ }
      this.activeBackends.delete(session.thread_id);
      this.lastActivity.delete(session.thread_id);
      // TODO: Re-enable staging cleanup once per-session TTL is implemented
      // this.cleanupFileStaging(files);
      const currentState = this.store.getSessionById(session.id)?.state;
      if (currentState === 'running') {
        this.store.updateSessionState(session.id, 'dead');
      }
      console.log(`[router] backend failed for session ${session.id}:`, err);
      throw err;
    }

    // Update activity timestamp
    this.lastActivity.set(threadId, Date.now());

    // If the backend died after send (CLI backends exit after each call),
    // clean up so the next send creates a fresh one.
    if (!backend.isAlive()) {
      this.activeBackends.delete(session.thread_id);
      this.lastActivity.delete(session.thread_id);
    }

    // If cancelBackend already intervened, the session is no longer running.
    // Skip state transitions and just return the partial events.
    const postSendSession = this.store.getSessionById(session.id);
    if (!postSendSession || postSendSession.state !== 'running') {
      console.log(`[router] session ${session.id} already transitioned (state: ${postSendSession?.state}), skipping post-send transition`);
      return { events: result.events, session: postSendSession ?? session };
    }

    // Store the backend session ID for future resume
    if (result.sessionId) {
      this.store.updateBackendSessionId(session.id, result.sessionId);
    }

    // Check if any events are PermissionDenied
    const hasPermissionDenied = result.events.some((e) => e.type === 'permission_denied');

    if (hasPermissionDenied) {
      // Transition to waiting_for_input
      this.store.updateSessionState(session.id, 'waiting_for_input');
      console.log(`[router] session ${session.id} waiting for input (permission denied)`);
    } else {
      // Transition back to idle
      this.store.updateSessionState(session.id, 'idle');
    }

    // TODO: Re-enable staging cleanup once per-session TTL is implemented
    // this.cleanupFileStaging(files);

    // Fetch the updated session
    const updatedSession = this.store.getSessionById(session.id)!;

    return {
      events: result.events,
      session: updatedSession,
    };
  }

  /**
   * Handle a user response when a session is waiting_for_input.
   * This resumes the backend with the user's response text.
   * When allowedTools is provided, the backend will auto-approve those tools.
   */
  async respond(channelId: string, threadId: string, text: string, allowedTools?: string[]): Promise<RouteResult> {
    const release = await this.acquireThreadLock(threadId);
    try {
      return await this._respond(channelId, threadId, text, allowedTools);
    } finally {
      release();
    }
  }

  private async _respond(channelId: string, threadId: string, text: string, allowedTools?: string[]): Promise<RouteResult> {
    const resolved = this.resolve(channelId, threadId);
    if (!resolved) {
      throw new Error(`Channel ${channelId} is not connected to a project`);
    }

    const { project, session } = resolved;

    if (session.state !== 'waiting_for_input') {
      throw new Error(`Session ${session.id} is not waiting for input (state: ${session.state})`);
    }

    // Transition to running
    this.store.updateSessionState(session.id, 'running');

    // Get or create a backend for this thread (persistent pool)
    const backend = await this.getOrCreateBackend(threadId, project, channelId);

    // Merge one-shot allowed tools with accumulated tools from the store (P12.6)
    const accumulatedTools = this.store.getAllowedTools(project.id).map(t => t.tool_pattern);
    const mergedTools = [...new Set([...(allowedTools ?? []), ...accumulatedTools])];
    if (mergedTools.length > 0) {
      backend.setAllowedTools(mergedTools);
    }

    // Prepend context (time + source platform) so backend can reason about dates and message origin
    const timedText = this.prependContext(text, project.platform);

    // Track activity for idle timeout
    this.lastActivity.set(threadId, Date.now());

    let result: SendResult;
    try {
      result = await this.sendWithTimeout(backend, timedText);
    } catch (err) {
      try { await backend.stop(); } catch { /* ignore stop errors */ }
      this.activeBackends.delete(session.thread_id);
      this.lastActivity.delete(session.thread_id);
      const currentState = this.store.getSessionById(session.id)?.state;
      if (currentState === 'running') {
        this.store.updateSessionState(session.id, 'dead');
      }
      throw err;
    }

    // Update activity timestamp
    this.lastActivity.set(threadId, Date.now());

    // If the backend died after send, clean up
    if (!backend.isAlive()) {
      this.activeBackends.delete(session.thread_id);
      this.lastActivity.delete(session.thread_id);
    }

    // If cancelBackend already intervened, skip state transitions
    const postRespondSession = this.store.getSessionById(session.id);
    if (!postRespondSession || postRespondSession.state !== 'running') {
      console.log(`[router] session ${session.id} already transitioned (state: ${postRespondSession?.state}), skipping post-respond transition`);
      return { events: result.events, session: postRespondSession ?? session };
    }

    // Store updated session ID
    if (result.sessionId) {
      this.store.updateBackendSessionId(session.id, result.sessionId);
    }

    // Check for another permission denied
    const hasPermissionDenied = result.events.some((e) => e.type === 'permission_denied');

    if (hasPermissionDenied) {
      this.store.updateSessionState(session.id, 'waiting_for_input');
    } else {
      this.store.updateSessionState(session.id, 'idle');
    }

    const updatedSession = this.store.getSessionById(session.id)!;

    return {
      events: result.events,
      session: updatedSession,
    };
  }

  /**
   * Reset a session — clear the backend session ID so next message starts fresh.
   */
  resetSession(channelId: string, threadId: string): Session {
    const resolved = this.resolve(channelId, threadId);
    if (!resolved) {
      throw new Error(`Channel ${channelId} is not connected to a project`);
    }

    const { session } = resolved;

    // Stop any persistent backend for this thread
    const backend = this.activeBackends.get(threadId);
    if (backend) {
      backend.stop().catch(() => {});
      this.activeBackends.delete(threadId);
      this.lastActivity.delete(threadId);
    }

    // If session is in a non-idle state, transition to idle
    if (session.state === 'running' || session.state === 'waiting_for_input') {
      // Force to dead first, then idle
      if (session.state === 'running') {
        this.store.updateSessionState(session.id, 'dead');
        this.store.updateSessionState(session.id, 'idle');
      } else {
        // waiting_for_input → running → dead → idle
        this.store.updateSessionState(session.id, 'running');
        this.store.updateSessionState(session.id, 'dead');
        this.store.updateSessionState(session.id, 'idle');
      }
    } else if (session.state === 'dead') {
      this.store.updateSessionState(session.id, 'idle');
    }
    // If already idle, nothing to do for state

    // Clear backend session ID so next send starts fresh
    this.store.updateBackendSessionId(session.id, null);

    const updatedSession = this.store.getSessionById(session.id)!;
    console.log(`[router] session ${session.id} reset`);
    return updatedSession;
  }

  /**
   * Cancel a running backend for a thread. Uses interrupt() for clean
   * cancellation, then stop() to terminate. Transitions the session back to idle.
   * Returns true if a backend was cancelled, false if nothing was running.
   */
  async cancelBackend(channelId: string, threadId: string): Promise<boolean> {
    const backend = this.activeBackends.get(threadId);
    if (!backend) {
      return false;
    }

    console.log(`[router] cancelling backend for thread ${threadId}`);
    try {
      // Try clean interrupt first
      await backend.interrupt();
    } catch {
      // Fall through to stop
    }
    try {
      await backend.stop();
    } catch {
      // Ignore stop errors during cancel
    }
    this.activeBackends.delete(threadId);
    this.lastActivity.delete(threadId);

    // Transition session back to idle
    const resolved = this.resolve(channelId, threadId);
    if (resolved) {
      const { session } = resolved;
      if (session.state === 'running') {
        this.store.updateSessionState(session.id, 'dead');
        this.store.updateSessionState(session.id, 'idle');
        console.log(`[router] session ${session.id} cancelled and reset to idle`);
      }
    }

    return true;
  }

  /**
   * Graceful shutdown — stop all active backend sessions and clean up.
   */
  async shutdown(): Promise<void> {
    // Stop idle cleanup
    if (this.idleCleanupInterval) {
      clearInterval(this.idleCleanupInterval);
      this.idleCleanupInterval = null;
    }

    console.log(`[router] shutting down ${this.activeBackends.size} active backend(s)`);
    for (const [threadId, backend] of this.activeBackends) {
      try {
        await backend.stop();
        console.log(`[router] stopped backend for thread ${threadId}`);
      } catch (err) {
        console.error(`[router] error stopping backend for thread ${threadId}:`, err);
      }
    }
    this.activeBackends.clear();
    this.lastActivity.clear();
  }
}
