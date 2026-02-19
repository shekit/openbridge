# I/O Prototype Harness

Local test harness for OpenBridge's biggest V1 risk: CLI I/O, session continuity, and interactive prompt passthrough.

It does not implement bridge logic. It only exercises backend process behavior and records event logs.

## What It Tests

- Persistent process send/receive loop
- Output chunking + quiet period detection
- Interactive-prompt detection (prompt-shape + regex cues)
- Kill/restart behavior in the same project directory
- Fallback one-shot mode when PTY session startup is unavailable

## Run

From `/Users/abhishek/Documents/bigmac/openbridge`:

```bash
node prototype/io-harness/run.js --list
```

```bash
node prototype/io-harness/run.js --backend codex --scenario quick-smoke --project /Users/abhishek/Documents/bigmac/openbridge
```

```bash
node prototype/io-harness/run.js --backend claude --scenario io-risk --project /Users/abhishek/Documents/bigmac/openbridge
```

```bash
node prototype/io-harness/run.js --backend claude --scenario claude-permission-text-option --project /Users/abhishek/Documents/bigmac/openbridge
```

Run the full matrix for one backend:

```bash
node prototype/io-harness/run-matrix.js --backend claude --project /Users/abhishek/Documents/bigmac/openbridge
```

Run the full matrix for both backends:

```bash
node prototype/io-harness/run-matrix.js --backend claude,codex --project /Users/abhishek/Documents/bigmac/openbridge
```

## Output

Runs write two files in `prototype/io-harness/logs/`:

- `*.events.jsonl` (full event stream)
- `*.summary.json` (pass/fail + metadata)
- `*.matrix.summary.json` (multi-scenario pass/fail matrix)

## Notes

- Backend configs are in `prototype/io-harness/backends/`.
- Scenarios are in `prototype/io-harness/scenarios/`.
- Primary mode uses `node-pty` to create a true PTY so interactive prompts can be detected and answered.
- If PTY spawn fails in the current environment, the harness automatically falls back to one-shot structured mode (`codex exec --json`, `claude -p --output-format stream-json` with resume).
- In Claude one-shot mode, trust/setup prompts are skipped by `-p`; permission requests appear as structured denial events and can be handled by sending follow-up user guidance in the same resumed session.
- Prompt candidates are logged as `prompt_candidate` events with parsed options (`index` + `label`) when present.
- `npm install` has already been run in `prototype/io-harness/` to install dependencies.
