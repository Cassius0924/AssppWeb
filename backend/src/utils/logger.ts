import path from "path";
import {
  config,
  LOG_BUFFER_SIZE,
  LOG_LEVEL_NAMES,
  LOG_MAX_FIELD_CHARS,
  LOG_QUERY_MAX_LIMIT,
  LOG_TAIL_MAX_BYTES,
  type LogLevelName,
} from "../config.js";
import { RotatingFileWriter } from "./logFile.js";

export type LogLevel = LogLevelName;
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  msg: string;
  [field: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const RESERVED_FIELDS = new Set(["time", "level", "scope", "msg"]);

// Keys whose values never reach a log line. Matching is done on the key with
// every non-letter stripped, so "X-Access-Token" and "access_token" both hit.
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

const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (normalized.includes("cookie")) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Masks addresses so a log line can say which account without naming it. */
export function maskEmail(value: string): string {
  return value.replace(EMAIL_PATTERN, (address) => {
    const [local, domain] = address.split("@");
    const head = local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
  });
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const masked = maskEmail(value);
    return masked.length > LOG_MAX_FIELD_CHARS
      ? `${masked.slice(0, LOG_MAX_FIELD_CHARS)}…(+${masked.length - LOG_MAX_FIELD_CHARS} chars)`
      : masked;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeValue(value.message, depth + 1),
      stack:
        config.logLevel === "debug" || config.logLevel === "trace"
          ? sanitizeValue(value.stack ?? "", depth + 1)
          : undefined,
    };
  }

  if (depth >= 4) return "[depth limit]";

  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > 50) items.push(`…(+${value.length - 50} items)`);
    return items;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

/** Strips credentials out of a free-form field bag before it is serialized. */
export function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const name = RESERVED_FIELDS.has(key) ? `f_${key}` : key;
    out[name] = isSensitiveKey(key) ? REDACTED : sanitizeValue(value, 0);
  }
  return out;
}

const buffer: LogRecord[] = [];
const currentLevel: LogLevel = config.logLevel;

const fileWriter = config.logToFile
  ? new RotatingFileWriter({
      dir: config.logDir || path.join(config.dataDir, "logs"),
      baseName: "asspp.log",
      maxBytes: config.logMaxFileMB * 1024 * 1024,
      maxFiles: config.logMaxFiles,
    })
  : null;

export function logDirectory(): string {
  return fileWriter ? path.dirname(fileWriter.filePath) : "";
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function formatPretty(record: LogRecord): string {
  const time = record.time.slice(11, 23);
  const level = record.level.toUpperCase().padEnd(5);
  const extras: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_FIELDS.has(key)) continue;
    extras.push(
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }
  const tail = extras.length ? ` ${extras.join(" ")}` : "";
  return `${time} ${level} [${record.scope}] ${record.msg}${tail}`;
}

function emit(record: LogRecord): void {
  const json = JSON.stringify(record);

  const line = config.logFormat === "json" ? json : formatPretty(record);
  const target = record.level === "error" ? process.stderr : process.stdout;
  target.write(`${line}\n`);

  // The file always gets JSON so /api/logs can read structured records back
  // regardless of how stdout is formatted.
  fileWriter?.write(json);

  buffer.push(record);
  if (buffer.length > LOG_BUFFER_SIZE) buffer.shift();
}

/** Writes a record that was built elsewhere (browser logs, console bridge). */
export function writeRecord(
  level: LogLevel,
  scope: string,
  msg: string,
  fields?: LogFields,
  time?: string,
): void {
  if (!isLevelEnabled(level)) return;
  emit({
    time: time ?? new Date().toISOString(),
    level,
    scope,
    msg: sanitizeValue(msg, 0) as string,
    ...sanitizeFields(fields),
  });
}

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  trace(msg: string, fields?: LogFields): void;
  child(scope: string, fields?: LogFields): Logger;
}

export function createLogger(scope: string, bound: LogFields = {}): Logger {
  const write = (level: LogLevel) => (msg: string, fields?: LogFields) =>
    writeRecord(level, scope, msg, { ...bound, ...fields });

  return {
    error: write("error"),
    warn: write("warn"),
    info: write("info"),
    debug: write("debug"),
    trace: write("trace"),
    child: (childScope, fields) =>
      createLogger(`${scope}:${childScope}`, { ...bound, ...fields }),
  };
}

export const logger = createLogger("app");

export interface LogQuery {
  level?: LogLevel;
  scope?: string;
  search?: string;
  limit?: number;
  since?: string;
}

/**
 * Returns the newest records first. The rotating file is the source of truth
 * when it is healthy; the in-memory ring buffer covers file-less setups.
 */
export function queryLogs(query: LogQuery): {
  source: "file" | "memory";
  records: LogRecord[];
} {
  const source = fileWriter?.isHealthy ? "file" : "memory";
  let records: LogRecord[];

  if (source === "file") {
    records = [];
    for (const line of fileWriter!.readTail(LOG_TAIL_MAX_BYTES)) {
      try {
        const parsed = JSON.parse(line) as LogRecord;
        if (parsed && typeof parsed.msg === "string") records.push(parsed);
      } catch {
        // A truncated or hand-edited line is skipped rather than failing the query.
      }
    }
  } else {
    records = [...buffer];
  }

  const maxOrder = query.level ? LEVEL_ORDER[query.level] : undefined;
  const search = query.search?.toLowerCase();
  const sinceMs = query.since ? Date.parse(query.since) : NaN;

  const filtered = records.filter((record) => {
    if (maxOrder !== undefined && LEVEL_ORDER[record.level] > maxOrder) {
      return false;
    }
    if (query.scope && !record.scope.startsWith(query.scope)) return false;
    if (!Number.isNaN(sinceMs) && Date.parse(record.time) <= sinceMs) {
      return false;
    }
    if (search) {
      const haystack = `${record.scope} ${record.msg} ${JSON.stringify(record)}`;
      if (!haystack.toLowerCase().includes(search)) return false;
    }
    return true;
  });

  const limit = Math.min(query.limit || 200, LOG_QUERY_MAX_LIMIT);
  return { source, records: filtered.slice(-limit).reverse() };
}

export function logLevelNames(): readonly string[] {
  return LOG_LEVEL_NAMES;
}

/** Flushes and releases the log file; call once during shutdown. */
export function closeLogging(): void {
  fileWriter?.close();
}

/** Test seam: drops buffered records so assertions start from a clean slate. */
export function resetLogBuffer(): void {
  buffer.length = 0;
}
