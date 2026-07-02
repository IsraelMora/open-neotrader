import { execFile } from 'child_process';
import { existsSync } from 'fs';

/**
 * Absolute path to the `unshare` binary, resolved from fixed, unwriteable
 * system directories only (never from $PATH — sonarjs/no-os-command-from-path).
 * util-linux installs it at /usr/bin/unshare on Debian/Ubuntu (the base
 * images used by this repo's Dockerfiles); /bin/unshare is kept as a
 * fallback for distros that still symlink /bin to /usr/bin or ship it there.
 */
export function resolveUnshareBinary(): string {
  const candidates = ['/usr/bin/unshare', '/bin/unshare'];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Command + args to hand to `spawn(...)`, with or without netns wrapping. */
export interface SandboxSpawnCommand {
  command: string;
  args: string[];
}

/**
 * Builds the argv used to spawn the sandbox python subprocess.
 *
 * When `netnsActive` is true, wraps the python invocation with
 * `unshare -rn <python3Bin> <runnerPath>`:
 *   -r, --map-root-user  → unshares a user namespace and maps the current
 *                           (unprivileged) user to root inside it — this is
 *                           what makes -n usable without CAP_SYS_ADMIN.
 *   -n, --net             → unshares a new network namespace with no
 *                           interfaces configured (only loopback), so the
 *                           child process has no route to the outside world.
 *
 * `unshare` is invoked WITHOUT `--fork`, so (per `man unshare`) it does not
 * fork a child: it calls unshare(2) in-process and then execvp()s directly
 * into the target program, replacing its own image. The resulting OS
 * process keeps the same PID that Node's `spawn()` returned — there is no
 * extra intermediary process to orphan. This is why timeout handling can
 * keep killing `proc.pid` directly instead of switching to a process-group
 * kill (see sandbox.gateway.ts).
 *
 * When `netnsActive` is false, returns the plain, unwrapped python command.
 *
 * The `unshare` command is resolved via `resolveUnshareBinary()` — the same
 * absolute-path allowlist resolver used by the probe (`defaultNetnsProber`)
 * — rather than a bare `'unshare'` string. Using the bare string here would
 * let this, the REAL production spawn, resolve a *different* binary via
 * $PATH than the one the probe actually verified, defeating the hardening.
 * `netnsActive` is only ever true after the probe has confirmed `unshare`
 * exists at one of the allowlisted absolute paths, so by the time this
 * function is called with `netnsActive: true` the resolved path is expected
 * to exist on disk.
 */
export function buildSandboxSpawnCommand(
  python3Bin: string,
  runnerPath: string,
  netnsActive: boolean,
): SandboxSpawnCommand {
  if (netnsActive) {
    return { command: resolveUnshareBinary(), args: ['-rn', python3Bin, runnerPath] };
  }
  return { command: python3Bin, args: [runnerPath] };
}

/** Function that probes whether unprivileged netns isolation is usable on this host. */
export type NetnsProber = () => Promise<boolean>;

const PROBE_TIMEOUT_MS = 2000;

/**
 * Default prober: runs `unshare -rn true` via execFile (no shell — avoids
 * shell-injection surface) and reports success/failure. Times out after
 * ~2s in case the kernel call hangs.
 */
export function defaultNetnsProber(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(resolveUnshareBinary(), ['-rn', 'true'], { timeout: PROBE_TIMEOUT_MS }, (error) => {
      resolve(!error);
    });
  });
}

let cachedDetection: Promise<boolean> | null = null;

/**
 * Detects (once) whether unprivileged network-namespace isolation is
 * available, memoizing the result so repeated calls don't re-probe.
 * Accepts an injectable prober for deterministic testing.
 */
export function detectNetnsIsolation(prober: NetnsProber = defaultNetnsProber): Promise<boolean> {
  if (!cachedDetection) {
    cachedDetection = prober();
  }
  return cachedDetection;
}

/** Resets the memoized detection result — for tests, or to force a re-probe. */
export function resetNetnsDetectionCache(): void {
  cachedDetection = null;
}
