import { Router, Request, Response } from "express";
import {
  CLIENT_LOG_MAX_ENTRIES,
  CLIENT_LOG_MAX_MESSAGE_CHARS,
  LOG_LEVEL_NAMES,
  LOG_QUERY_MAX_LIMIT,
  config,
  type LogLevelName,
} from "../config.js";
import {
  createLogger,
  getLogLevel,
  queryLogs,
  writeRecord,
} from "../utils/logger.js";

const router = Router();
const log = createLogger("logs");

function asLevel(value: unknown): LogLevelName | undefined {
  return typeof value === "string" &&
    LOG_LEVEL_NAMES.includes(value as LogLevelName)
    ? (value as LogLevelName)
    : undefined;
}

router.get("/logs", (req: Request, res: Response) => {
  if (!config.logsApiEnabled) {
    res.status(403).json({ error: "Log API is disabled" });
    return;
  }

  const limitParam = parseInt(String(req.query.limit ?? ""), 10);
  const { source, records } = queryLogs({
    level: asLevel(req.query.level),
    scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
    search: typeof req.query.q === "string" ? req.query.q : undefined,
    since: typeof req.query.since === "string" ? req.query.since : undefined,
    limit: Number.isFinite(limitParam)
      ? Math.max(1, Math.min(limitParam, LOG_QUERY_MAX_LIMIT))
      : 200,
  });

  res.json({
    source,
    serverLevel: getLogLevel(),
    levels: LOG_LEVEL_NAMES,
    count: records.length,
    records,
  });
});

// Browser-side logs. The client decides whether to send anything at all; this
// endpoint additionally re-runs the shared redaction so a buggy or malicious
// caller still cannot park credentials in the server's log file.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ENTRIES = 2000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function overRateLimit(key: string, entries: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: entries, resetAt: now + RATE_WINDOW_MS });
    // Opportunistic sweep so abandoned client sessions cannot grow the map.
    if (rateBuckets.size > 512) {
      for (const [id, value] of rateBuckets) {
        if (value.resetAt <= now) rateBuckets.delete(id);
      }
    }
    return false;
  }

  bucket.count += entries;
  return bucket.count > RATE_MAX_ENTRIES;
}

/** Test seam: clears the per-address budget between cases. */
export function resetClientLogRateLimit(): void {
  rateBuckets.clear();
}

function sanitizeScope(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const cleaned = raw.replace(/[^A-Za-z0-9:_.-]/g, "").slice(0, 64);
  return cleaned || "browser";
}

router.post("/client-logs", (req: Request, res: Response) => {
  if (!config.clientLogsEnabled) {
    res.status(403).json({ error: "Client logging is disabled" });
    return;
  }

  const body = req.body as { session?: unknown; entries?: unknown } | undefined;
  const entries = Array.isArray(body?.entries) ? body.entries : null;
  if (!entries) {
    res.status(400).json({ error: "Missing entries array" });
    return;
  }
  if (entries.length > CLIENT_LOG_MAX_ENTRIES) {
    res.status(413).json({ error: "Too many entries" });
    return;
  }

  const session = sanitizeScope(body?.session).slice(0, 16);
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  // Keyed on the address alone: the session id comes from the client, so a
  // flooder could otherwise mint a fresh bucket for every batch.
  if (overRateLimit(ip, entries.length)) {
    res.status(429).json({ error: "Too many log entries" });
    return;
  }

  let accepted = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const level = asLevel(entry.level) ?? "info";
    const msg =
      typeof entry.msg === "string"
        ? entry.msg.slice(0, CLIENT_LOG_MAX_MESSAGE_CHARS)
        : "";
    if (!msg) continue;

    const fields =
      entry.fields && typeof entry.fields === "object"
        ? Object.fromEntries(
            Object.entries(entry.fields as Record<string, unknown>).slice(0, 30),
          )
        : {};

    writeRecord(level, `client:${sanitizeScope(entry.scope)}`, msg, {
      ...fields,
      session,
      clientTime: typeof entry.time === "string" ? entry.time : undefined,
      req: req.requestId,
    });
    accepted++;
  }

  log.debug("ingested browser logs", {
    session,
    received: entries.length,
    accepted,
  });
  res.json({ accepted });
});

export default router;
