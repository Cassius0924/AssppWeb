import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

process.env.LOG_TO_FILE = "false";
process.env.LOG_LEVEL = "debug";

const logsModule = await import("../src/routes/logs.js");
const logRoutes = logsModule.default;
const { resetClientLogRateLimit } = logsModule;
const { queryLogs, resetLogBuffer } = await import("../src/utils/logger.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", logRoutes);
  return app;
}

const app = createApp();

function batch(entries: unknown[], session = "s1") {
  return request(app).post("/api/client-logs").send({ session, entries });
}

describe("POST /api/client-logs", () => {
  beforeEach(() => {
    resetLogBuffer();
    resetClientLogRateLimit();
  });

  it("rejects a body without an entries array", async () => {
    const res = await request(app).post("/api/client-logs").send({});
    expect(res.status).toBe(400);
  });

  it("rejects oversized batches", async () => {
    const entries = Array.from({ length: 201 }, () => ({
      level: "info",
      msg: "x",
    }));
    const res = await batch(entries);
    expect(res.status).toBe(413);
  });

  it("stores accepted entries under a client scope", async () => {
    const res = await batch([
      { level: "warn", scope: "apple:auth", msg: "auth failed", fields: { status: 204 } },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 1 });

    const [record] = queryLogs({ scope: "client:apple:auth" }).records;
    expect(record.level).toBe("warn");
    expect(record.msg).toBe("auth failed");
    expect(record.status).toBe(204);
  });

  it("re-runs redaction on browser-supplied fields", async () => {
    await batch([
      {
        level: "info",
        scope: "apple:auth",
        msg: "sent request",
        fields: {
          password: "hunter2",
          cookie: "sid=1",
          appleId: "someone@example.com",
          host: "buy.itunes.apple.com",
        },
      },
    ]);

    const [record] = queryLogs({ scope: "client:" }).records;
    expect(record.password).toBe("[redacted]");
    expect(record.cookie).toBe("[redacted]");
    expect(record.appleId).toBe("s******@example.com");
    expect(record.host).toBe("buy.itunes.apple.com");
  });

  it("skips malformed entries but keeps the rest of the batch", async () => {
    const res = await batch([
      null,
      "not an object",
      { level: "info", msg: "" },
      { level: "nonsense", scope: "weird/scope!", msg: "kept" },
    ]);

    expect(res.body.accepted).toBe(1);
    const [record] = queryLogs({ search: "kept" }).records;
    // An unknown level falls back to info and the scope is stripped to safe characters.
    expect(record.level).toBe("info");
    expect(record.scope).toBe("client:weirdscope");
  });

  it("rate limits a flooding address", async () => {
    const entries = Array.from({ length: 200 }, () => ({
      level: "info",
      msg: "flood",
    }));
    let lastStatus = 200;
    for (let i = 0; i < 12; i++) {
      lastStatus = (await batch(entries, "flood")).status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("GET /api/logs", () => {
  beforeEach(() => {
    resetLogBuffer();
    resetClientLogRateLimit();
  });

  it("returns records newest first with level metadata", async () => {
    await batch([
      { level: "error", scope: "apple:sap", msg: "signing failed" },
      { level: "info", scope: "apple:sap", msg: "handshake complete" },
    ]);

    const res = await request(app).get("/api/logs?scope=client&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.serverLevel).toBe("debug");
    expect(res.body.levels).toContain("trace");
    expect(res.body.records[0].msg).toBe("handshake complete");
  });

  it("filters by level", async () => {
    await batch([
      { level: "error", scope: "apple:sap", msg: "signing failed" },
      { level: "info", scope: "apple:sap", msg: "handshake complete" },
    ]);

    const res = await request(app).get("/api/logs?level=error&scope=client");
    expect(res.body.records.map((r: { msg: string }) => r.msg)).toEqual([
      "signing failed",
    ]);
  });
});
