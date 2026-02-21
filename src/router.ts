/**
 * Router for OpenBridge.
 *
 * Maps channel/thread pairs to projects and sessions, manages backend
 * lifecycle, and enforces session state machine transitions.
 */

import type { Backend, SendResult, McpServerEntry } from './types/backend.js';
import type { NormalizedEvent } from './types/events.js';
import { Store, type Project, type Session } from './store.js';

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
}

export class Router {
  private store: Store;
  private backendFactory: BackendFactory;
  private activeBackends: Map<string, Backend> = new Map();
  private timeoutMs: number;
  private mcpConfigFactory?: McpConfigFactory;

  constructor(store: Store, backendFactory: BackendFactory, options?: RouterOptions) {
    this.store = store;
    this.backendFactory = backendFactory;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mcpConfigFactory = options?.mcpConfigFactory;
  }

  /** Send with timeout — races backend.send() against a timeout. */
  private async sendWithTimeout(backend: Backend, text: string): Promise<SendResult> {
    if (this.timeoutMs <= 0) {
      return backend.send(text);
    }

    let timer: ReturnType<typeof setTimeout>;

    const result = await Promise.race([
      backend.send(text).then((r) => {
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

  /**
   * Send a message through the backend and return normalized events.
   * Manages session state transitions and persists backend session ID.
   */
  async send(channelId: string, threadId: string, text: string): Promise<RouteResult> {
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

    // Transition to running
    this.store.updateSessionState(session.id, 'running');

    const backend = this.backendFactory(project.backend_name);

    // Initialize the backend with the project dir and optional MCP config
    const mcpConfig = this.mcpConfigFactory?.({
      channelId,
      threadId,
      projectDir: project.project_dir,
      platform: project.platform,
    });
    await backend.start({ projectDir: project.project_dir, mcpConfig });

    // Track as active for graceful shutdown
    this.activeBackends.set(session.thread_id, backend);

    // If there's a stored backend session ID, set it on the backend for resume
    // (will be null if session was auto-recovered from dead)
    const currentSession = this.store.getSessionByThreadId(session.thread_id);
    if (currentSession?.backend_session_id) {
      backend.setSessionId(currentSession.backend_session_id);
    }

    let result: SendResult;
    try {
      result = await this.sendWithTimeout(backend, text);
    } catch (err) {
      // Backend crashed or timed out — clean up and transition to dead
      try { await backend.stop(); } catch { /* ignore stop errors */ }
      this.activeBackends.delete(session.thread_id);
      this.store.updateSessionState(session.id, 'dead');
      console.log(`[router] backend failed for session ${session.id}:`, err);
      throw err;
    }

    // Clean up active backend tracking (oneshot — process already exited)
    this.activeBackends.delete(session.thread_id);

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

    const backend = this.backendFactory(project.backend_name);
    const mcpConfig = this.mcpConfigFactory?.({
      channelId,
      threadId,
      projectDir: project.project_dir,
      platform: project.platform,
    });
    await backend.start({ projectDir: project.project_dir, mcpConfig });

    // Track as active for graceful shutdown
    this.activeBackends.set(session.thread_id, backend);

    // Must have a backend session ID for resume
    if (session.backend_session_id) {
      backend.setSessionId(session.backend_session_id);
    }

    // Set allowed tools if provided (e.g., user clicked Allow on a permission prompt)
    if (allowedTools && allowedTools.length > 0) {
      backend.setAllowedTools(allowedTools);
    }

    let result: SendResult;
    try {
      result = await this.sendWithTimeout(backend, text);
    } catch (err) {
      try { await backend.stop(); } catch { /* ignore stop errors */ }
      this.activeBackends.delete(session.thread_id);
      this.store.updateSessionState(session.id, 'dead');
      throw err;
    }

    // Clean up active backend tracking (oneshot — process already exited)
    this.activeBackends.delete(session.thread_id);

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
   * Cancel a running backend for a thread. Kills the process (and all its
   * children via process group) and transitions the session back to idle.
   * Returns true if a backend was cancelled, false if nothing was running.
   */
  async cancelBackend(channelId: string, threadId: string): Promise<boolean> {
    const backend = this.activeBackends.get(threadId);
    if (!backend) {
      return false;
    }

    console.log(`[router] cancelling backend for thread ${threadId}`);
    try {
      await backend.stop();
    } catch {
      // Ignore stop errors during cancel
    }
    this.activeBackends.delete(threadId);

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
   * Graceful shutdown — stop all active backend sessions.
   */
  async shutdown(): Promise<void> {
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
  }
}
