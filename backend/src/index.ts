import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { CLIENT_LOG_MAX_BODY_BYTES, config } from "./config.js";
import { httpsRedirect } from "./middleware/httpsRedirect.js";
import { accessAuth } from "./middleware/accessAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { setupWsProxy } from "./services/wsProxy.js";
import authRoutes from "./routes/auth.js";
import searchRoutes from "./routes/search.js";
import downloadRoutes from "./routes/downloads.js";
import packageRoutes from "./routes/packages.js";
import installRoutes from "./routes/install.js";
import settingsRoutes from "./routes/settings.js";
import bagRoutes from "./routes/bag.js";
import logRoutes from "./routes/logs.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { installConsoleBridge } from "./utils/consoleBridge.js";
import {
  closeLogging,
  createLogger,
  getLogLevel,
  logDirectory,
} from "./utils/logger.js";

// Capture third-party console output (notably wisp-js) before anything logs.
installConsoleBridge();
const log = createLogger("server");

const app = express();

// Middleware
app.use(httpsRedirect);
app.use(requestLogger);
// Browser log batches get a much tighter body limit than the IPA metadata
// uploads below; the first parser to run wins, so this must be registered first.
app.use("/api/client-logs", express.json({ limit: CLIENT_LOG_MAX_BODY_BYTES }));
app.use(express.json({ limit: "50mb" }));

// API routes
app.use("/api", accessAuth);
app.use("/api", authRoutes);
app.use("/api", searchRoutes);
app.use("/api", downloadRoutes);
app.use("/api", packageRoutes);
app.use("/api", installRoutes);
app.use("/api", settingsRoutes);
app.use("/api", bagRoutes);
app.use("/api", logRoutes);

// Serve static frontend files
const publicDir = path.resolve(import.meta.dirname, "../public");
app.use(express.static(publicDir));

// SPA fallback: serve index.html for non-API routes
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }
  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// Error handler (must be last)
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

// WebSocket proxy for Apple TCP connections
setupWsProxy(server);

// Ensure data directory exists
fs.mkdirSync(config.dataDir, { recursive: true });

server.listen(config.port, () => {
  log.info("server started", {
    port: config.port,
    dataDir: path.resolve(config.dataDir),
    logLevel: getLogLevel(),
    logFormat: config.logFormat,
    logDir: logDirectory() || undefined,
    buildCommit: config.buildCommit,
    accessControl: config.accessPassword ? "password" : "open",
  });
});

process.on("uncaughtException", (err: Error) => {
  log.error("uncaught exception", { error: err });
});

process.on("unhandledRejection", (reason: unknown) => {
  log.error("unhandled promise rejection", {
    error: reason instanceof Error ? reason : String(reason),
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("shutting down", { signal });
    server.close(() => {
      closeLogging();
      process.exit(0);
    });
  });
}

export { app, server };
