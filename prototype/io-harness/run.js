#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const SCRIPT_DIR = __dirname;
const BACKENDS_DIR = path.join(SCRIPT_DIR, "backends");
const SCENARIOS_DIR = path.join(SCRIPT_DIR, "scenarios");
const DEFAULT_SCENARIO = "quick-smoke";

function parseArgs(argv) {
  const out = {
    backend: null,
    scenario: DEFAULT_SCENARIO,
    project: process.cwd(),
    logDir: path.join(SCRIPT_DIR, "logs"),
    list: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--backend") {
      out.backend = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--scenario") {
      out.scenario = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--project") {
      out.project = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--log-dir") {
      out.logDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--list") {
      out.list = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function printHelp() {
  console.log(`Usage:
  node run.js --backend <claude|codex|codex-sandboxed> [options]

Options:
  --backend <name>        Backend config name (required unless --list)
  --scenario <name|path>  Scenario name in scenarios/ or path to a JSON file
  --project <path>        Project directory used as backend cwd
  --log-dir <path>        Directory to write JSONL logs and summary
  --list                  List available backends and scenarios
  -h, --help              Show this help
`);
}

function listNames(dir, ext = ".json") {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => name.slice(0, -ext.length))
    .sort();
}

function sanitizeText(text) {
  let out = text;
  out = out.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  out = out.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(/[^\x09\x0A\x20-\x7E]/g, "");
  return out;
}

function normalizeRegex(regexSource, flags) {
  const safeFlags = (flags || "i").replaceAll("g", "");
  return new RegExp(regexSource, safeFlags);
}

function clipForLog(text, maxLen = 700) {
  if (!text || text.length <= maxLen) {
    return text || "";
  }
  return `${text.slice(0, maxLen)}...`;
}

function nowIso() {
  return new Date().toISOString();
}

function timestampForFile() {
  return nowIso().replaceAll(":", "-").replaceAll(".", "-");
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveScenarioPath(scenarioArg) {
  if (scenarioArg.endsWith(".json") || scenarioArg.includes(path.sep)) {
    return path.resolve(scenarioArg);
  }
  return path.join(SCENARIOS_DIR, `${scenarioArg}.json`);
}

function resolveBackendPath(name) {
  return path.join(BACKENDS_DIR, `${name}.json`);
}

function withProjectTokens(value, projectDir) {
  if (typeof value !== "string") {
    return value;
  }
  return value.replaceAll("{project}", projectDir);
}

function withTokens(value, tokens) {
  let out = value;
  for (const [key, tokenValue] of Object.entries(tokens)) {
    out = out.replaceAll(`{${key}}`, String(tokenValue ?? ""));
  }
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codex JSON parser — extracts assistant text, session ID, and sandbox denials
// from `codex exec --json` JSONL output.
// ---------------------------------------------------------------------------

function parseCodexJson(stdout, stderr, exitCode) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  let sessionId = null;
  const assistantParts = [];
  const sandboxHints = [];
  const errors = [];

  const sandboxDenialRe =
    /operation not permitted|permission denied|sandbox.*(?:block|denied|restrict)|read.only.*file.?system/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const event = parseJsonLine(trimmed);
    if (!event) {
      if (/^error[:\s]/i.test(trimmed)) {
        errors.push(trimmed.replace(/^error[:\s]*/i, ""));
      }
      continue;
    }

    if (event.type === "thread.started" && event.thread_id) {
      sessionId = event.thread_id;
      continue;
    }

    if (
      event.type === "item.completed" &&
      event.item &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      assistantParts.push(event.item.text);
      if (sandboxDenialRe.test(event.item.text)) {
        sandboxHints.push(`SANDBOX_DENIAL ${event.item.text.slice(0, 200)}`);
      }
      continue;
    }

    if (
      event.type === "item.completed" &&
      event.item &&
      event.item.type === "command_execution" &&
      event.item.exit_code !== 0 &&
      typeof event.item.aggregated_output === "string"
    ) {
      if (sandboxDenialRe.test(event.item.aggregated_output)) {
        sandboxHints.push(
          `SANDBOX_DENIAL command=${event.item.command || "unknown"} output=${event.item.aggregated_output.slice(0, 200)}`
        );
      }
      continue;
    }

    if (event.type === "error" && event.message) {
      errors.push(event.message);
      continue;
    }

    if (event.type === "turn.failed" && event.error && event.error.message) {
      errors.push(event.error.message);
      continue;
    }
  }

  if (exitCode !== 0 && errors.length === 0) {
    errors.push(`Codex exited with code ${exitCode}`);
  }

  const combinedText = [...assistantParts, ...sandboxHints]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    sessionId,
    assistantText: combinedText,
    errorMessage: errors.length > 0 ? errors[0] : null,
  };
}

// ---------------------------------------------------------------------------
// Claude stream-json parser — extracts assistant text, session ID,
// permission_denials, and permission context from Claude Code's
// `--output-format stream-json` JSONL output.
// ---------------------------------------------------------------------------

function extractClaudeText(message) {
  if (!message || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseClaudeStreamJson(stdout, stderr, exitCode) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  let sessionId = null;
  const assistantParts = [];
  const permissionHints = [];
  const errors = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const event = parseJsonLine(trimmed);
    if (!event) {
      if (/^error[:\s]/i.test(trimmed)) {
        errors.push(trimmed.replace(/^error[:\s]*/i, ""));
      }
      continue;
    }

    if (
      event.type === "system" &&
      event.subtype === "init" &&
      typeof event.session_id === "string"
    ) {
      sessionId = event.session_id;
      continue;
    }

    if (event.type === "assistant") {
      const text = extractClaudeText(event.message);
      if (text) {
        assistantParts.push(text);
      }
      continue;
    }

    if (event.type === "result" && Array.isArray(event.permission_denials)) {
      for (const denial of event.permission_denials) {
        if (!denial || typeof denial !== "object") {
          continue;
        }
        const toolName = denial.tool_name || "unknown_tool";
        const toolInput =
          denial.tool_input && typeof denial.tool_input === "object"
            ? JSON.stringify(denial.tool_input)
            : "";
        permissionHints.push(
          `PERMISSION_DENIAL ${toolName}${toolInput ? ` ${toolInput}` : ""}`
        );
      }
    }

    if (
      event.type === "user" &&
      event.message &&
      Array.isArray(event.message.content)
    ) {
      for (const part of event.message.content) {
        if (!part || typeof part !== "object" || !part.is_error) {
          continue;
        }
        if (typeof part.content === "string") {
          const text = part.content.trim();
          if (/permission|blocked|not granted|denied/i.test(text)) {
            permissionHints.push(`PERMISSION_CONTEXT ${text}`);
          }
        }
      }
    }

    if (event.type === "result" && event.is_error) {
      if (Array.isArray(event.errors) && event.errors.length > 0) {
        errors.push(String(event.errors[0]));
      } else {
        errors.push(`Claude execution failed (${event.subtype || "unknown"})`);
      }
      continue;
    }
  }

  if (exitCode !== 0 && errors.length === 0) {
    errors.push(`Claude exited with code ${exitCode}`);
  }

  const combinedAssistantText = [...assistantParts, ...permissionHints]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    sessionId,
    assistantText: combinedAssistantText,
    errorMessage: errors.length > 0 ? errors[0] : null,
  };
}

function parseOneShotOutput(parser, stdout, stderr, exitCode) {
  if (parser === "codex-json") {
    return parseCodexJson(stdout, stderr, exitCode);
  }
  if (parser === "claude-stream-json") {
    return parseClaudeStreamJson(stdout, stderr, exitCode);
  }
  return {
    sessionId: null,
    assistantText: sanitizeText(`${stdout}\n${stderr}`),
    errorMessage: exitCode === 0 ? null : `Command exited with code ${exitCode}`,
  };
}

// ---------------------------------------------------------------------------
// Command execution — spawns a child process, collects stdout/stderr, logs
// raw output events as they arrive.
// ---------------------------------------------------------------------------

function runCommandCollect(command, args, cwd, env, logEvent) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      logEvent("raw_output", { stream: "stdout", text: sanitizeText(text) });
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      logEvent("raw_output", { stream: "stderr", text: sanitizeText(text) });
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code, signal) =>
      resolve({
        stdout,
        stderr,
        exitCode: code === null ? 1 : code,
        signal: signal || null,
      })
    );
  });
}

// ---------------------------------------------------------------------------
// BackendSession — oneshot mode only. Each send() spawns a CLI invocation,
// collects structured JSON output, and feeds it through the output buffer.
// Session continuity via CLI-native resume flags (Claude -r, Codex resume).
// ---------------------------------------------------------------------------

class BackendSession extends EventEmitter {
  constructor(config, projectDir, logEvent) {
    super();
    this.config = config;
    this.projectDir = projectDir;
    this.logEvent = logEvent;

    this.outputBuffer = "";
    this.maxBufferChars = 48000;
    this.outputCount = 0;
    this.lastOutputAt = Date.now();
    this.lastSendOutputCount = 0;

    this.sessionId = null;
  }

  async start() {
    // Oneshot mode — nothing to start. Each send() spawns its own process.
  }

  _onData(text) {
    if (!text) {
      return;
    }

    this.outputCount += 1;
    this.lastOutputAt = Date.now();
    this.outputBuffer += text;
    if (this.outputBuffer.length > this.maxBufferChars) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferChars);
    }

    this.logEvent("output", { text });
    this.emit("output", { text, ts: Date.now() });
  }

  async send(text) {
    const oneshot = this.config.fallbackOneShot;
    if (!oneshot) {
      throw new Error("Backend config missing fallbackOneShot");
    }

    const useResume =
      Boolean(this.sessionId) && Array.isArray(oneshot.resumeArgs);
    const argsTemplate = useResume ? oneshot.resumeArgs : oneshot.startArgs;
    if (!Array.isArray(argsTemplate) || argsTemplate.length === 0) {
      throw new Error("oneshot args template is missing");
    }

    const command = oneshot.command || this.config.command;
    const cwd = path.resolve(
      withProjectTokens(
        oneshot.cwd || this.config.cwd || "{project}",
        this.projectDir
      )
    );
    const env = {
      ...process.env,
      TERM: "xterm-256color",
    };
    for (const key of this.config.unsetEnv || []) {
      delete env[key];
    }
    for (const [key, value] of Object.entries(oneshot.env || this.config.env || {})) {
      env[key] = withProjectTokens(String(value), this.projectDir);
    }

    const tokens = {
      project: this.projectDir,
      prompt: text,
      session_id: this.sessionId || "",
    };
    const args = argsTemplate.map((arg) => withTokens(String(arg), tokens));

    this.logEvent("stdin", {
      mode: "oneshot",
      text,
      useResume,
      command,
      args,
    });
    this.lastSendOutputCount = this.outputCount;

    const result = await runCommandCollect(command, args, cwd, env, this.logEvent);
    const parsed = parseOneShotOutput(
      oneshot.parser,
      result.stdout,
      result.stderr,
      result.exitCode
    );

    if (parsed.sessionId) {
      this.sessionId = parsed.sessionId;
    }
    if (parsed.assistantText) {
      this._onData(parsed.assistantText + "\n");
    }
    if (parsed.errorMessage) {
      throw new Error(parsed.errorMessage);
    }
  }

  kill() {
    this.sessionId = null;
    this.logEvent("session_reset", { note: "session id cleared" });
  }

  async stop() {
    // Oneshot mode — nothing to stop.
  }
}

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

async function waitForPattern(session, regexSource, flags, timeoutMs) {
  const regex = normalizeRegex(regexSource, flags || "i");

  if (regex.test(session.outputBuffer)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      session.removeListener("output", onOutput);
      reject(
        new Error(
          `Pattern not found within ${timeoutMs}ms: /${regexSource}/${flags || "i"}`
        )
      );
    }, timeoutMs);

    const onOutput = () => {
      if (regex.test(session.outputBuffer)) {
        clearTimeout(deadline);
        session.removeListener("output", onOutput);
        resolve();
      }
    };
    session.on("output", onOutput);
  });
}

async function waitForPatternTimeoutExpected(
  session,
  regexSource,
  flags,
  timeoutMs
) {
  try {
    await waitForPattern(session, regexSource, flags, timeoutMs);
  } catch (err) {
    if (err.message.includes("Pattern not found within")) {
      return;
    }
    throw err;
  }
  throw new Error(
    `Pattern unexpectedly appeared within ${timeoutMs}ms: /${regexSource}/${flags || "i"}`
  );
}

async function waitForQuiet(session, quietMs, timeoutMs, opts = {}) {
  const requireOutputSinceLastSend = opts.requireOutputSinceLastSend !== false;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const hasOutputSinceLastSend =
      session.outputCount > session.lastSendOutputCount;
    if (requireOutputSinceLastSend && !hasOutputSinceLastSend) {
      await delay(100);
      continue;
    }

    if (Date.now() - session.lastOutputAt >= quietMs) {
      return;
    }
    await delay(100);
  }

  throw new Error(
    `Quiet period of ${quietMs}ms not reached within ${timeoutMs}ms`
  );
}

async function runScenario(session, scenario, logEvent) {
  const steps = scenario.steps || [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const label = `${i + 1}/${steps.length} ${step.type}`;
    logEvent("step_started", { index: i + 1, total: steps.length, step });
    console.log(`-> ${label}`);

    try {
      await runStep(session, step, logEvent);
      logEvent("step_completed", { index: i + 1, status: "ok" });
    } catch (err) {
      if (step.optional) {
        logEvent("step_completed", {
          index: i + 1,
          status: "optional_failed",
          message: err.message,
        });
        console.log(`   optional step failed: ${err.message}`);
      } else {
        logEvent("step_failed", { index: i + 1, message: err.message });
        throw err;
      }
    }
  }
}

async function runStep(session, step, logEvent) {
  if (step.type === "send") {
    await session.send(step.text || "");
    return;
  }

  if (step.type === "send_if_pattern") {
    const regex = normalizeRegex(step.regex, step.flags || "i");
    if (regex.test(session.outputBuffer)) {
      await session.send(step.text || "");
      logEvent("conditional_send", { sent: true, regex: step.regex });
    } else {
      logEvent("conditional_send", { sent: false, regex: step.regex });
    }
    return;
  }

  if (step.type === "sleep") {
    await delay(step.ms || 500);
    return;
  }

  if (step.type === "wait_pattern") {
    await waitForPattern(
      session,
      step.regex,
      step.flags || "i",
      step.timeoutMs || 30000
    );
    return;
  }

  if (step.type === "wait_pattern_timeout_expected") {
    await waitForPatternTimeoutExpected(
      session,
      step.regex,
      step.flags || "i",
      step.timeoutMs || 3000
    );
    return;
  }

  if (step.type === "wait_quiet") {
    await waitForQuiet(
      session,
      step.quietMs || 2000,
      step.timeoutMs || 30000,
      {
        requireOutputSinceLastSend: step.requireOutputSinceLastSend,
      }
    );
    return;
  }

  if (step.type === "kill") {
    session.kill();
    return;
  }

  if (step.type === "restart") {
    session.kill();
    return;
  }

  throw new Error(`Unknown step type: ${step.type}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log("Backends:");
    for (const backendName of listNames(BACKENDS_DIR)) {
      console.log(`  - ${backendName}`);
    }
    console.log("Scenarios:");
    for (const scenarioName of listNames(SCENARIOS_DIR)) {
      console.log(`  - ${scenarioName}`);
    }
    return;
  }

  if (!args.backend) {
    throw new Error("--backend is required");
  }

  const backendPath = resolveBackendPath(args.backend);
  const scenarioPath = resolveScenarioPath(args.scenario);
  if (!fs.existsSync(backendPath)) {
    throw new Error(`Backend config not found: ${backendPath}`);
  }
  if (!fs.existsSync(scenarioPath)) {
    throw new Error(`Scenario config not found: ${scenarioPath}`);
  }

  const backend = loadJson(backendPath);
  const scenario = loadJson(scenarioPath);
  const projectDir = path.resolve(args.project);
  const logDir = path.resolve(args.logDir);
  fs.mkdirSync(logDir, { recursive: true });

  const stamp = `${timestampForFile()}-${backend.name}-${scenario.name || path.basename(scenarioPath, ".json")}`;
  const eventsPath = path.join(logDir, `${stamp}.events.jsonl`);
  const summaryPath = path.join(logDir, `${stamp}.summary.json`);
  const eventsStream = fs.createWriteStream(eventsPath, { flags: "a" });

  function logEvent(type, data = {}) {
    eventsStream.write(`${JSON.stringify({ ts: nowIso(), type, ...data })}\n`);
  }

  const session = new BackendSession(backend, projectDir, logEvent);
  const startedAt = Date.now();
  let status = "passed";
  let errorMessage = null;

  console.log(`Backend: ${backend.name}`);
  console.log(`Scenario: ${scenario.name || path.basename(scenarioPath)}`);
  console.log(`Project: ${projectDir}`);
  console.log(`Events: ${eventsPath}`);

  logEvent("run_started", {
    backend: backend.name,
    scenario: scenario.name || path.basename(scenarioPath),
    projectDir,
  });

  try {
    await session.start();
    await runScenario(session, scenario, logEvent);
  } catch (err) {
    status = "failed";
    errorMessage = err.message;
    console.error(`Run failed: ${err.message}`);
  } finally {
    eventsStream.end();
  }

  const summary = {
    backend: backend.name,
    scenario: scenario.name || path.basename(scenarioPath),
    projectDir,
    status,
    errorMessage,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    eventsPath,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Summary: ${summaryPath}`);
  console.log(`Status: ${status}`);

  if (status !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
