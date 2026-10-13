export const DEFAULT_ANTIGRAVITY_OUTPUT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const ANTIGRAVITY_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS = 5000;

/**
 * Resolves the inactivity monitor timeout from adapter configuration.
 * - null -> disabled (explicit escape hatch)
 * - number > 0 -> configured timeout in ms
 * - undefined or non-positive -> default 30m
 */
export function resolveInactivityTimeout(rawValue) {
  if (rawValue === null) {
    return { mode: 'disabled', reason: 'explicit_null' };
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    if (rawValue > 0) {
      return { mode: 'configured', timeoutMs: rawValue };
    }
    return { mode: 'default', timeoutMs: DEFAULT_ANTIGRAVITY_OUTPUT_INACTIVITY_TIMEOUT_MS, reason: 'non_positive' };
  }
  return { mode: 'default', timeoutMs: DEFAULT_ANTIGRAVITY_OUTPUT_INACTIVITY_TIMEOUT_MS };
}

/**
 * Formats canonical inactivity failure message matching Paperclip conventions:
 * "monitor: no antigravity activity (output or process) for {N}m {S}s"
 */
export function formatInactivityErrorMessage(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `monitor: no antigravity activity (output or process) for ${minutes}m ${seconds}s`;
}

/**
 * Creates an output inactivity monitor that tracks stdout/stderr chunks and heartbeats.
 */
export function createOutputInactivityMonitor(options) {
  const {
    timeoutMs,
    onFire,
    now = () => Date.now(),
    setTimer = (cb, ms) => setTimeout(cb, ms),
    clearTimer = (h) => clearTimeout(h),
    isHeartbeatLine,
  } = options;

  if (!(timeoutMs > 0)) {
    throw new Error(`createOutputInactivityMonitor requires timeoutMs > 0 (got ${timeoutMs})`);
  }

  const spawnedAt = now();
  const state = {
    fired: false,
    spawnedAt,
    lastEventAt: spawnedAt,
    firedAt: null,
    outputChunkCount: 0,
    outputBytes: 0,
    parsedEventCount: 0,
  };

  let timerHandle = null;
  let stopped = false;

  const fire = () => {
    if (state.fired || stopped) return;
    state.fired = true;
    state.firedAt = now();
    timerHandle = null;
    onFire({ ...state });
  };

  const arm = () => {
    if (stopped || state.fired) return;
    if (timerHandle != null) clearTimer(timerHandle);
    timerHandle = setTimer(fire, timeoutMs);
  };

  arm();

  return {
    noteOutputChunk(stream, chunk) {
      if (stopped || state.fired || !chunk || chunk.length === 0) return;
      state.outputChunkCount += 1;
      state.outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (typeof isHeartbeatLine === 'function') {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim() && isHeartbeatLine(line)) {
            state.parsedEventCount += 1;
          }
        }
      }
      state.lastEventAt = now();
      arm();
    },
    state() {
      return { ...state };
    },
    stop() {
      stopped = true;
      if (timerHandle != null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      return { ...state };
    },
  };
}
