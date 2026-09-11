import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";
import { createLogger, type Logger } from "../utils/logger.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Correlates every line emitted while handling this request. */
    requestId: string;
    log: Logger;
  }
}

const httpLogger = createLogger("http");

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function queryFields(req: Request): Record<string, unknown> | undefined {
  const keys = Object.keys(req.query);
  if (keys.length === 0) return undefined;
  // Values pass through the logger's redaction, which drops token-like keys.
  return req.query as Record<string, unknown>;
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();
  // Express rewrites req.url/req.path while dispatching into a mounted router,
  // so the original path has to be captured before next() runs.
  const requestPath = req.path;
  req.requestId = randomUUID().slice(0, 8);
  req.log = httpLogger.child("req", { req: req.requestId });
  res.setHeader("X-Request-Id", req.requestId);

  // Static asset traffic is high volume and rarely interesting, so only API
  // calls get an info-level access line.
  const isApi = requestPath.startsWith("/api");

  req.log.debug("request started", {
    method: req.method,
    path: requestPath,
    query: queryFields(req),
    ip: clientIp(req),
    userAgent: req.headers["user-agent"],
  });

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields = {
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      bytes: Number(res.getHeader("content-length") ?? 0) || undefined,
      ip: clientIp(req),
    };

    if (res.statusCode >= 500) req.log.error("request failed", fields);
    else if (res.statusCode >= 400) req.log.warn("request rejected", fields);
    else if (isApi) req.log.info("request completed", fields);
    else req.log.debug("request completed", fields);
  });

  next();
}
