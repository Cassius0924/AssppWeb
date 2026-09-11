import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLogBuffer,
  createLogger,
  exportLogs,
  getLogBuffer,
  getLoggerSettings,
  maskEmail,
  sanitizeFields,
  setLoggerSettings,
} from "../../src/utils/logger";

describe("utils/logger redaction", () => {
  it("drops credential-bearing keys", () => {
    const fields = sanitizeFields({
      password: "hunter2",
      passwordToken: "abc",
      Cookie: "sid=1",
      dsPersonId: "1",
      sinfs: ["x"],
      "X-Apple-ActionSignature": "AAAA",
    });

    for (const value of Object.values(fields ?? {})) {
      expect(value).toBe("[redacted]");
    }
  });

  it("keeps the fields that explain a failure", () => {
    expect(
      sanitizeFields({
        status: 204,
        host: "buy.itunes.apple.com",
        signatureLength: 2048,
        responseHeaders: ["content-type", "location"],
      }),
    ).toEqual({
      status: 204,
      host: "buy.itunes.apple.com",
      signatureLength: 2048,
      responseHeaders: ["content-type", "location"],
    });
  });

  it("masks Apple IDs in messages and values", () => {
    expect(maskEmail("someone@example.com")).toBe("s******@example.com");
    expect(sanitizeFields({ appleId: "user@icloud.com" })).toEqual({
      appleId: "u***@icloud.com",
    });
  });

  it("redacts nested objects", () => {
    const result = sanitizeFields({
      request: { headers: { cookie: "sid=1" }, host: "buy.itunes.apple.com" },
    }) as Record<string, any>;
    expect(result.request.headers.cookie).toBe("[redacted]");
    expect(result.request.host).toBe("buy.itunes.apple.com");
  });
});

describe("utils/logger buffer", () => {
  beforeEach(() => {
    clearLogBuffer();
    setLoggerSettings({ level: "info", remote: false });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honours the configured level", () => {
    const log = createLogger("test");
    log.debug("hidden");
    log.info("kept");
    expect(getLogBuffer().map((e) => e.msg)).toEqual(["kept"]);
  });

  it("records scope, level and redacted fields", () => {
    createLogger("apple:auth").warn("attempt failed", {
      status: 204,
      password: "hunter2",
    });

    const [entry] = getLogBuffer();
    expect(entry.scope).toBe("apple:auth");
    expect(entry.level).toBe("warn");
    expect(entry.fields).toEqual({ status: 204, password: "[redacted]" });
  });

  it("namespaces child loggers", () => {
    createLogger("apple").child("sap").info("ready");
    expect(getLogBuffer()[0].scope).toBe("apple:sap");
  });

  it("exports one JSON object per line", () => {
    const log = createLogger("test");
    log.info("first");
    log.info("second");

    const lines = exportLogs().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).msg).toBe("first");
  });
});

describe("utils/logger forwarding", () => {
  beforeEach(() => {
    clearLogBuffer();
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setLoggerSettings({ remote: false });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends nothing while forwarding is off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setLoggerSettings({ level: "info", remote: false });

    createLogger("test").info("local only");
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("batches entries to /api/client-logs once enabled", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    setLoggerSettings({ level: "info", remote: true });

    const log = createLogger("apple:auth");
    log.info("first", { password: "hunter2" });
    log.warn("second", { status: 204 });
    await vi.advanceTimersByTimeAsync(2500);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/client-logs");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].fields.password).toBe("[redacted]");
    expect(body.entries[1].fields.status).toBe(204);
    expect(body.session).toMatch(/^[0-9a-f]+$/);
  });

  it("backs off after the server refuses the batch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 429 }));
    setLoggerSettings({ level: "info", remote: true });

    createLogger("test").info("flood");
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    createLogger("test").info("more");
    await vi.advanceTimersByTimeAsync(2500);
    // Still one call: the 429 parked forwarding for a minute.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("persists the opt-in across reloads", () => {
    setLoggerSettings({ level: "debug", remote: true });
    expect(JSON.parse(localStorage.getItem("asspp-logging") ?? "{}")).toEqual({
      level: "debug",
      remote: true,
    });
    expect(getLoggerSettings()).toEqual({ level: "debug", remote: true });
  });
});
