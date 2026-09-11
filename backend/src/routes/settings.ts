import { Router, Request, Response } from "express";
import { config, DOWNLOAD_THREADS } from "../config.js";
import { getLogLevel, logDirectory } from "../utils/logger.js";

const router = Router();
const startedAt = Date.now();

router.get("/settings", (_req: Request, res: Response) => {
  res.json({
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    buildCommit: config.buildCommit,
    buildDate: config.buildDate,
    port: config.port,
    dataDir: config.dataDir,
    publicBaseUrl: config.publicBaseUrl,
    disableHttpsRedirect: config.disableHttpsRedirect,
    autoCleanupDays: config.autoCleanupDays,
    autoCleanupMaxMB: config.autoCleanupMaxMB,
    maxDownloadMB: config.maxDownloadMB,
    downloadThreads: DOWNLOAD_THREADS,
    logLevel: getLogLevel(),
    logFormat: config.logFormat,
    logDir: logDirectory(),
    logMaxFileMB: config.logMaxFileMB,
    logMaxFiles: config.logMaxFiles,
    clientLogsEnabled: config.clientLogsEnabled,
    logsApiEnabled: config.logsApiEnabled,
  });
});

export default router;
