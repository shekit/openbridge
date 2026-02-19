import { describe, it, expect } from 'vitest';
import type {
  AssistantText,
  ToolUse,
  ToolResult,
  CommandExecution,
  PermissionDenied,
  SessionStarted,
  TurnCompleted,
  ErrorEvent,
  NormalizedEvent,
} from '../types/events.js';

describe('Normalized event types', () => {
  it('AssistantText has discriminant type field', () => {
    const event: AssistantText = { type: 'assistant_text', text: 'hello' };
    expect(event.type).toBe('assistant_text');
    expect(event.text).toBe('hello');
  });

  it('ToolUse has discriminant type field', () => {
    const event: ToolUse = {
      type: 'tool_use',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolUseId: 'toolu_01',
    };
    expect(event.type).toBe('tool_use');
    expect(event.toolName).toBe('Bash');
  });

  it('ToolResult has discriminant type field', () => {
    const event: ToolResult = {
      type: 'tool_result',
      toolUseId: 'toolu_01',
      content: 'file.txt',
      isError: false,
    };
    expect(event.type).toBe('tool_result');
  });

  it('CommandExecution has discriminant type field', () => {
    const event: CommandExecution = {
      type: 'command_execution',
      command: 'ls',
      exitCode: 0,
      output: 'file.txt',
    };
    expect(event.type).toBe('command_execution');
  });

  it('PermissionDenied has toolName, toolInput, and context fields', () => {
    const event: PermissionDenied = {
      type: 'permission_denied',
      toolName: 'Write',
      toolInput: { file_path: 'foo.txt', content: 'bar' },
      context: 'Write access not granted',
    };
    expect(event.type).toBe('permission_denied');
    expect(event.toolName).toBe('Write');
    expect(event.toolInput).toEqual({ file_path: 'foo.txt', content: 'bar' });
    expect(event.context).toBe('Write access not granted');
  });

  it('PermissionDenied context is optional', () => {
    const event: PermissionDenied = {
      type: 'permission_denied',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
    };
    expect(event.context).toBeUndefined();
  });

  it('SessionStarted has discriminant type field', () => {
    const event: SessionStarted = {
      type: 'session_started',
      sessionId: 'sess_123',
    };
    expect(event.type).toBe('session_started');
    expect(event.sessionId).toBe('sess_123');
  });

  it('TurnCompleted has discriminant type field', () => {
    const event: TurnCompleted = { type: 'turn_completed' };
    expect(event.type).toBe('turn_completed');
  });

  it('ErrorEvent has discriminant type field', () => {
    const event: ErrorEvent = { type: 'error', message: 'something broke' };
    expect(event.type).toBe('error');
    expect(event.message).toBe('something broke');
  });

  it('NormalizedEvent union discriminates by type field', () => {
    const events: NormalizedEvent[] = [
      { type: 'assistant_text', text: 'hi' },
      { type: 'tool_use', toolName: 'Read', toolInput: { path: '/a' } },
      { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
      { type: 'command_execution', command: 'ls', exitCode: 0, output: '' },
      { type: 'permission_denied', toolName: 'Bash', toolInput: {} },
      { type: 'session_started', sessionId: 's1' },
      { type: 'turn_completed' },
      { type: 'error', message: 'oops' },
    ];

    // Every event in the union has a unique type discriminant
    const types = events.map((e) => e.type);
    expect(new Set(types).size).toBe(events.length);
  });
});
