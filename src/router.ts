/**
 * Router for OpenBridge.
 *
 * Maps channel/thread pairs to projects and sessions, manages backend
 * lifecycle, and enforces session state machine transitions.
 */

import type { Backend, SendResult } from './types/backend.js';
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

export class Router {
  private store: Store;
  private backendFactory: BackendFactory;

  constructor(store: Store, backendFactory: BackendFactory) {
    this.store = store;
    this.backendFactory = backendFactory;
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
      throw new Error(`Channel ${channelId} is not bound to a project`);
    }

    const { project, session } = resolved;

    // Transition to running
    this.store.updateSessionState(session.id, 'running');

    const backend = this.backendFactory(project.backend_name);

    // Initialize the backend with the project dir
    await backend.start({ projectDir: project.project_dir });

    // If there's a stored backend session ID, set it on the backend for resume
    if (session.backend_session_id) {
      // The backend's internal session ID must be set for resume
      (backend as any).sessionId = session.backend_session_id;
    }

    let result: SendResult;
    try {
      result = await backend.send(text);
    } catch (err) {
      // Backend crashed — transition to dead
      this.store.updateSessionState(session.id, 'dead');
      console.log(`[router] backend crashed for session ${session.id}:`, err);
      throw err;
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
   */
  async respond(channelId: string, threadId: string, text: string): Promise<RouteResult> {
    const resolved = this.resolve(channelId, threadId);
    if (!resolved) {
      throw new Error(`Channel ${channelId} is not bound to a project`);
    }

    const { project, session } = resolved;

    if (session.state !== 'waiting_for_input') {
      throw new Error(`Session ${session.id} is not waiting for input (state: ${session.state})`);
    }

    // Transition to running
    this.store.updateSessionState(session.id, 'running');

    const backend = this.backendFactory(project.backend_name);
    await backend.start({ projectDir: project.project_dir });

    // Must have a backend session ID for resume
    if (session.backend_session_id) {
      (backend as any).sessionId = session.backend_session_id;
    }

    let result: SendResult;
    try {
      result = await backend.send(text);
    } catch (err) {
      this.store.updateSessionState(session.id, 'dead');
      throw err;
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
      throw new Error(`Channel ${channelId} is not bound to a project`);
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
}
