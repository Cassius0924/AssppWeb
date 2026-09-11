import { writeRecord, type LogLevel } from "./logger.js";

type ConsoleMethod = "debug" | "info" | "log" | "warn" | "error";

const METHOD_LEVEL: Record<ConsoleMethod, LogLevel> = {
  debug: "debug",
  info: "info",
  log: "info",
  warn: "warn",
  error: "error",
};

// @mercuryworkshop/wisp-js writes straight to console with its own prefix,
// e.g. "[2026/09/11 - 12:44:10] info: new connection on /wisp/". Recognising
// that shape lets proxy output land in the structured pipeline with the right
// level and scope instead of arriving as an opaque string.
const WISP_PREFIX =
  /^\[(\d{4})\/(\d{2})\/(\d{2}) - (\d{2}:\d{2}:\d{2})\] (debug|info|log|warn|error):\s*/;

// Wisp tags each line with the stream it belongs to: "(9bfda19a) opening …".
const WISP_CONNECTION = /^\(([0-9a-f]{4,})\)\s*/i;

function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toRecord(method: ConsoleMethod, args: unknown[]) {
  const text = args.map(formatArgument).join(" ");
  const wisp = WISP_PREFIX.exec(text);
  if (!wisp) {
    return { level: METHOD_LEVEL[method], scope: "console", msg: text };
  }

  let msg = text.slice(wisp[0].length);
  const fields: Record<string, unknown> = {};
  const connection = WISP_CONNECTION.exec(msg);
  if (connection) {
    fields.connection = connection[1];
    msg = msg.slice(connection[0].length);
  }

  return {
    level: METHOD_LEVEL[wisp[5] as ConsoleMethod],
    scope: "wisp",
    msg,
    fields,
  };
}

let installed = false;

/**
 * Routes third-party console output into the structured logger. Our own
 * transports write through process.stdout/stderr, so this cannot recurse.
 */
export function installConsoleBridge(): void {
  if (installed) return;
  installed = true;

  for (const method of Object.keys(METHOD_LEVEL) as ConsoleMethod[]) {
    console[method] = (...args: unknown[]) => {
      const record = toRecord(method, args);
      writeRecord(record.level, record.scope, record.msg, record.fields);
    };
  }
}
