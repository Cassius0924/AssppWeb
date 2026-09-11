import { createHash } from "crypto";
import { timingSafeEqual } from "crypto";

export const LOG_LEVEL_NAMES = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

export const config = {
  port: parseInt(process.env.PORT || "8080"),
  dataDir: process.env.DATA_DIR || "./data",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  disableHttpsRedirect:
    process.env.UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT === "true",
  // Auto-cleanup: 0 disables
  autoCleanupDays: parseInt(process.env.AUTO_CLEANUP_DAYS || "0", 10) || 0,
  autoCleanupMaxMB: parseInt(process.env.AUTO_CLEANUP_MAX_MB || "0", 10) || 0,
  // Max download file size in MB (0 disables)
  maxDownloadMB: parseInt(process.env.MAX_DOWNLOAD_MB || "0", 10) || 0,
  // Build info (injected via Docker build args)
  buildCommit: process.env.BUILD_COMMIT || "unknown",
  buildDate: process.env.BUILD_DATE || "unknown",
  // Access password protection (empty = disabled)
  accessPassword: process.env.ACCESS_PASSWORD || "",
  // Logging
  logLevel: normalizeLogLevel(process.env.LOG_LEVEL),
  logFormat: process.env.LOG_FORMAT === "json" ? "json" : "pretty",
  logToFile: process.env.LOG_TO_FILE !== "false",
  logDir: process.env.LOG_DIR || "",
  logMaxFileMB: clampInt(process.env.LOG_MAX_FILE_MB, 16, 1, 1024),
  logMaxFiles: clampInt(process.env.LOG_MAX_FILES, 5, 1, 50),
  // Browser-side log ingestion via POST /api/client-logs (opt-in per browser)
  clientLogsEnabled: process.env.CLIENT_LOGS !== "false",
  // GET /api/logs. Without ACCESS_PASSWORD this endpoint is reachable by anyone
  // who can reach the app, so it can be turned off entirely.
  logsApiEnabled: process.env.LOGS_API !== "false",
};

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = parseInt(raw || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeLogLevel(raw: string | undefined): LogLevelName {
  const value = (raw || "").toLowerCase();
  return LOG_LEVEL_NAMES.includes(value as LogLevelName)
    ? (value as LogLevelName)
    : "info";
}

export const accessPasswordHash = config.accessPassword
  ? createHash("sha256").update(config.accessPassword).digest("hex")
  : "";

/** Timing-safe comparison of a client-supplied token against the precomputed hash. */
export function verifyAccessToken(token: string): boolean {
  const expected = Buffer.from(accessPasswordHash, "utf8");
  const actual = Buffer.from(token, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const MAX_DOWNLOAD_SIZE = 8 * 1024 * 1024 * 1024; // 8 GB
export const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours
export const BAG_TIMEOUT_MS = 15_000; // 15 seconds
export const BAG_MAX_BYTES = 1024 * 1024; // 1 MB
export const MIN_ACCOUNT_HASH_LENGTH = 8;

// Logging limits
export const LOG_BUFFER_SIZE = 2000; // in-memory records served when no log file
export const LOG_TAIL_MAX_BYTES = 4 * 1024 * 1024; // bytes re-read from the log file
export const LOG_QUERY_MAX_LIMIT = 2000;
export const LOG_MAX_FIELD_CHARS = 512; // longer strings are truncated
export const CLIENT_LOG_MAX_ENTRIES = 200; // per POST /api/client-logs batch
export const CLIENT_LOG_MAX_BODY_BYTES = 256 * 1024;
export const CLIENT_LOG_MAX_MESSAGE_CHARS = 512;

// Chunked download settings
export const DOWNLOAD_THREADS = Math.max(
  1,
  Math.min(32, parseInt(process.env.DOWNLOAD_THREADS || "8", 10) || 8),
);
export const CHUNK_RETRY_COUNT = 3;
export const CHUNK_RETRY_DELAY_MS = 2000;
