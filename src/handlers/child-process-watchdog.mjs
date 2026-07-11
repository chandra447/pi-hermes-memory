import { spawn } from "node:child_process";

const [timeoutValue, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);

if (!command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write("pi-hermes-memory watchdog: invalid invocation\n");
  process.exit(2);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

let timedOut = false;
let terminating = false;
let forceTimer;

function signalTree(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function terminateTree() {
  if (terminating) return;
  terminating = true;
  signalTree("SIGTERM");
  forceTimer = setTimeout(() => signalTree("SIGKILL"), 500);
  forceTimer.unref();
}

const timeout = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`[pi-hermes-memory] child timed out after ${timeoutMs}ms; terminating process tree\n`);
  terminateTree();
}, timeoutMs);
timeout.unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, terminateTree);
}

child.once("error", (error) => {
  clearTimeout(timeout);
  if (forceTimer) clearTimeout(forceTimer);
  process.stderr.write(`pi-hermes-memory watchdog: ${error.message}\n`);
  process.exitCode = timedOut ? 124 : 127;
});

child.once("close", (code, signal) => {
  clearTimeout(timeout);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) {
    process.exitCode = 124;
  } else if (typeof code === "number") {
    process.exitCode = code;
  } else {
    process.exitCode = signal === "SIGTERM" ? 143 : 1;
  }
});
