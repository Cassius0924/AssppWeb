import { getAccessToken } from "../components/Auth/PasswordGate";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export const LOG_LEVELS: LogLevel[] = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export interface LogEntry {
  time: string;
  level: LogLevel;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface LoggerSettings {
  level: LogLevel;
  /** Forward entries to POST /api/client-logs. Off unless the user opts in. */
  remote: boolean;
}

const SETTINGS_KEY = "asspp-logging";
const BUFFER_LIMIT = 500;
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 20;
const MAX_QUEUE = 200;
const MAX_FIELD_CHARS = 512;

// Mirrors the backend redaction list. Apple credentials must never leave the
// browser, so anything credential-shaped is dropped before it reaches the
// console, the export file, or the network.
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "dsid",
  "dspersonid",
  "directoryservicesidentifier",
  "itunesmetadata",
  "otp",
  "sinf",
  "sinfs",
  "verificationcode",
]);

const SENSITIVE_SUFFIXES = [
  "password",
  "passwd",
  "pwd",
  "token",
  "secret",
  "signature",
  "apikey",
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (normalized.includes("cookie")) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function maskEmail(value: string): string {
  return value.replace(EMAIL_PATTERN, (address) => {
    const [local, domain] = address.split("@");
    return `${local.slice(0, 1)}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
  });
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const masked = maskEmail(value);
    return masked.length > MAX_FIELD_CHARS
      ? `${masked.slice(0, MAX_FIELD_CHARS)}…(+${masked.length - MAX_FIELD_CHARS} chars)`
      : masked;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Error) {
    return { name: value.name, message: maskEmail(value.message) };
  }

  if (depth >= 3) return "[depth limit]";

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

export function sanitizeFields(
  fields?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function loadSettings(): LoggerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LoggerSettings>;
      return {
        level: LOG_LEVELS.includes(parsed.level as LogLevel)
          ? (parsed.level as LogLevel)
          : "info",
        remote: parsed.remote === true,
      };
    }
  } catch {
    // Corrupted settings fall back to the defaults below.
  }
  return { level: "info", remote: false };
}

let settings = loadSettings();
const buffer: LogEntry[] = [];
let queue: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
let remoteDisabledUntil = 0;

function sessionId(): string {
  const existing = sessionStorage.getItem("asspp-log-session");
  if (existing) return existing;
  const id = Math.random().toString(16).slice(2, 10);
  sessionStorage.setItem("asspp-log-session", id);
  return id;
}

export function getLoggerSettings(): LoggerSettings {
  return { ...settings };
}

export function setLoggerSettings(next: Partial<LoggerSettings>): void {
  settings = { ...settings, ...next };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing modes can refuse writes; the in-memory value still applies.
  }
  if (!settings.remote) queue = [];
}

export function getLogBuffer(): LogEntry[] {
  return [...buffer];
}

export function clearLogBuffer(): void {
  buffer.length = 0;
}

/** Serializes the in-browser buffer for the "export logs" action. */
export function exportLogs(): string {
  return buffer.map((entry) => JSON.stringify(entry)).join("\n");
}

async function flush(): Promise<void> {
  flushTimer = undefined;
  if (flushing || queue.length === 0) return;
  if (!settings.remote || Date.now() < remoteDisabledUntil) {
    queue = [];
    return;
  }

  const entries = queue;
  queue = [];
  flushing = true;
  const token = getAccessToken();
  try {
    const res = await fetch("/api/client-logs", {
      method: "POST",
      // authHeaders() lives in api/client, which logs through this module; the
      // token is read directly to keep the import graph acyclic.
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Access-Token": token } : {}),
      },
      body: JSON.stringify({ session: sessionId(), entries }),
      keepalive: true,
    });
    // 403 (server-side opt-out) and 429 (flooding) both mean "stop for a while"
    // rather than "retry immediately".
    if (res.status === 403 || res.status === 429) {
      remoteDisabledUntil = Date.now() + 60_000;
    }
  } catch {
    // Losing diagnostic logs is never worth surfacing an error to the user.
  } finally {
    flushing = false;
  }
}

function scheduleFlush(): void {
  if (queue.length >= FLUSH_THRESHOLD) {
    void flush();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
}

const CONSOLE_METHOD: Record<LogLevel, "error" | "warn" | "info" | "debug"> = {
  error: "error",
  warn: "warn",
  info: "info",
  debug: "debug",
  trace: "debug",
};

function record(
  level: LogLevel,
  scope: string,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[settings.level]) return;

  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    scope,
    msg: maskEmail(msg),
    fields: sanitizeFields(fields),
  };

  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();

  const prefix = `[${scope}] ${entry.msg}`;
  if (entry.fields) console[CONSOLE_METHOD[level]](prefix, entry.fields);
  else console[CONSOLE_METHOD[level]](prefix);

  if (settings.remote) {
    queue.push(entry);
    if (queue.length > MAX_QUEUE) queue.shift();
    scheduleFlush();
  }
}

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  trace(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    error: (msg, fields) => record("error", scope, msg, fields),
    warn: (msg, fields) => record("warn", scope, msg, fields),
    info: (msg, fields) => record("info", scope, msg, fields),
    debug: (msg, fields) => record("debug", scope, msg, fields),
    trace: (msg, fields) => record("trace", scope, msg, fields),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export const logger = createLogger("app");

if (typeof window !== "undefined") {
  // A tab closing mid-login would otherwise drop the batch that explains why.
  window.addEventListener("pagehide", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}
