#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SCRIPT_DIR = __dirname;
const RUNNER_PATH = path.join(SCRIPT_DIR, "run.js");
const MATRICES_DIR = path.join(SCRIPT_DIR, "matrices");

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return nowIso().replaceAll(":", "-").replaceAll(".", "-");
}

function parseArgs(argv) {
  const out = {
    backend: null,
    matrix: "full-io-matrix",
    project: process.cwd(),
    logDir: path.join(SCRIPT_DIR, "logs"),
    maxAttempts: 1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--backend") {
      out.backend = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--matrix") {
      out.matrix = argv[i + 1];
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
    if (arg === "--max-attempts") {
      out.maxAttempts = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!out.backend) {
    throw new Error("--backend is required");
  }
  if (!Number.isFinite(out.maxAttempts) || out.maxAttempts < 1) {
    throw new Error("--max-attempts must be >= 1");
  }

  return out;
}

function printHelp() {
  console.log(`Usage:
  node prototype/io-harness/run-matrix.js --backend <claude|codex|claude,codex> [options]

Options:
  --matrix <name|path>    Matrix name in matrices/ or path to a JSON file
  --project <path>        Project directory for all scenarios
  --log-dir <path>        Directory for matrix output and scenario logs
  --max-attempts <n>      Default max attempts per case (default: 1)
  -h, --help              Show this help
`);
}

function resolveMatrixPath(matrixArg) {
  if (matrixArg.endsWith(".json") || matrixArg.includes(path.sep)) {
    return path.resolve(matrixArg);
  }
  return path.join(MATRICES_DIR, `${matrixArg}.json`);
}

function parseSummaryPath(outputText) {
  const lines = outputText.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^Summary:\s+(.*)$/);
    if (m) {
      return m[1].trim();
    }
  }
  return null;
}

function caseAppliesToBackend(caseDef, backend) {
  if (!Array.isArray(caseDef.backends) || caseDef.backends.length === 0) {
    return true;
  }
  return caseDef.backends.includes(backend);
}

function compilePattern(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }
}

function evaluateAssertions(caseDef, summary) {
  const assertions = caseDef.assertions || {};
  const contains = Array.isArray(assertions.contains) ? assertions.contains : [];
  const notContains = Array.isArray(assertions.notContains)
    ? assertions.notContains
    : [];

  if (contains.length === 0 && notContains.length === 0) {
    return { ok: true, message: null };
  }

  if (!summary || !summary.eventsPath || !fs.existsSync(summary.eventsPath)) {
    return {
      ok: false,
      message: "Assertions requested but events log is missing",
    };
  }

  const eventsText = fs.readFileSync(summary.eventsPath, "utf8");

  for (const pattern of contains) {
    const regex = compilePattern(pattern);
    if (!regex.test(eventsText)) {
      return {
        ok: false,
        message: `Assertion failed: missing pattern '${pattern}'`,
      };
    }
  }

  for (const pattern of notContains) {
    const regex = compilePattern(pattern);
    if (regex.test(eventsText)) {
      return {
        ok: false,
        message: `Assertion failed: unexpected pattern '${pattern}'`,
      };
    }
  }

  return { ok: true, message: null };
}

function isRetryableFailure(text) {
  return /stream disconnected|reconnecting|timed out|timeout|ECONNRESET|EAI_AGAIN|Pattern not found within/i.test(
    text || ""
  );
}

function spawnCollect(command, args, options) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try { proc.kill("SIGTERM"); } catch {}
      }
    }, options.timeout || 70000);

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code, signal, timedOut });
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status: 1, signal: null, timedOut, error: err });
    });
  });
}

async function runCase({
  backend,
  projectDir,
  logDir,
  defaultMaxAttempts,
  caseDef,
}) {
  const caseId = caseDef.id || caseDef.scenario;
  const expectedStatus = caseDef.expectedStatus || "passed";
  const maxAttempts = Math.max(1, Number(caseDef.maxAttempts || defaultMaxAttempts));
  const timeoutMs = Number(caseDef.timeoutMs || 70000);

  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(
      `Case ${caseId} (${backend}) attempt ${attempt}/${maxAttempts} -> ${caseDef.scenario}`
    );

    const proc = await spawnCollect(
      process.execPath,
      [
        RUNNER_PATH,
        "--backend",
        backend,
        "--scenario",
        caseDef.scenario,
        "--project",
        projectDir,
        "--log-dir",
        logDir,
      ],
      {
        timeout: timeoutMs,
      }
    );

    const stdout = proc.stdout || "";
    const stderr = proc.stderr || "";
    const combined = `${stdout}\n${stderr}`;

    const summaryPath = parseSummaryPath(combined);
    let summary = null;
    if (summaryPath && fs.existsSync(summaryPath)) {
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      } catch {
        summary = null;
      }
    }

    const observedStatus =
      summary && summary.status
        ? summary.status
        : proc.status === 0
          ? "passed"
          : "failed";
    const assertion = evaluateAssertions(caseDef, summary);
    const statusMatches = observedStatus === expectedStatus;
    const passed = statusMatches && assertion.ok;

    const attemptRecord = {
      attempt,
      exitCode: proc.status,
      signal: proc.signal || null,
      timedOut: proc.timedOut,
      expectedStatus,
      observedStatus,
      assertionOk: assertion.ok,
      assertionMessage: assertion.message,
      summaryPath,
      eventsPath: summary ? summary.eventsPath : null,
      errorMessage: summary ? summary.errorMessage : null,
      stdoutTail: stdout.split(/\r?\n/).slice(-20).join("\n"),
      stderrTail: stderr.split(/\r?\n/).slice(-20).join("\n"),
    };

    attempts.push(attemptRecord);

    if (passed) {
      return {
        id: caseId,
        scenario: caseDef.scenario,
        expectedStatus,
        observedStatus,
        passed: true,
        attempts,
        summaryPath,
        eventsPath: summary ? summary.eventsPath : null,
        errorMessage: null,
      };
    }

    const retryable = isRetryableFailure(combined);
    const hasMoreAttempts = attempt < maxAttempts;
    if (!retryable || !hasMoreAttempts) {
      return {
        id: caseId,
        scenario: caseDef.scenario,
        expectedStatus,
        observedStatus,
        passed: false,
        attempts,
        summaryPath,
        eventsPath: summary ? summary.eventsPath : null,
        errorMessage:
          attemptRecord.errorMessage ||
          attemptRecord.assertionMessage ||
          "Scenario failed",
      };
    }
  }

  return {
    id: caseId,
    scenario: caseDef.scenario,
    expectedStatus,
    observedStatus: "failed",
    passed: false,
    attempts,
    summaryPath: null,
    eventsPath: null,
    errorMessage: "Scenario failed",
  };
}

async function runBackendMatrix({ backend, matrix, projectDir, logDir, maxAttempts }) {
  const startedAt = nowIso();
  const applicableCases = (matrix.cases || []).filter((caseDef) =>
    caseAppliesToBackend(caseDef, backend)
  );

  const results = [];
  for (const caseDef of applicableCases) {
    const result = await runCase({
      backend,
      projectDir,
      logDir,
      defaultMaxAttempts: maxAttempts,
      caseDef,
    });
    results.push(result);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;

  return {
    backend,
    matrix: matrix.name || "matrix",
    projectDir,
    startedAt,
    endedAt: nowIso(),
    totalCases: results.length,
    passedCount,
    failedCount,
    status: failedCount === 0 ? "passed" : "failed",
    results,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixPath = resolveMatrixPath(args.matrix);
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`Matrix config not found: ${matrixPath}`);
  }

  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  const projectDir = path.resolve(args.project);
  const logDir = path.resolve(args.logDir);
  fs.mkdirSync(logDir, { recursive: true });

  const backends = args.backend
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (backends.length === 0) {
    throw new Error("No backend provided");
  }

  const summaries = [];
  const matrixName = matrix.name || path.basename(matrixPath, ".json");

  for (const backend of backends) {
    const backendSummary = await runBackendMatrix({
      backend,
      matrix,
      projectDir,
      logDir,
      maxAttempts: args.maxAttempts,
    });

    const outPath = path.join(
      logDir,
      `${stamp()}-${backend}-${matrixName}.matrix.summary.json`
    );
    fs.writeFileSync(outPath, `${JSON.stringify(backendSummary, null, 2)}\n`, "utf8");

    console.log(`Backend: ${backend}`);
    console.log(`Matrix: ${matrixName}`);
    console.log(`Status: ${backendSummary.status}`);
    console.log(
      `Cases: ${backendSummary.passedCount}/${backendSummary.totalCases} passed`
    );
    console.log(`Summary: ${outPath}`);

    summaries.push({ backend, summaryPath: outPath, status: backendSummary.status });
  }

  if (summaries.some((s) => s.status !== "passed")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
