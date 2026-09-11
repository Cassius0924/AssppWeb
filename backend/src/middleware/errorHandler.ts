import { Request, Response, NextFunction } from "express";
import { createLogger } from "../utils/logger.js";

const log = createLogger("http:error");

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  (req.log ?? log).error("unhandled request error", {
    method: req.method,
    path: req.path,
    error: err,
  });
  res.status(500).json({ error: "Internal server error" });
}
