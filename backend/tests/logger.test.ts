import { describe, it, expect, beforeEach } from "vitest";

// The logger reads its configuration once at import time, so the environment
// has to be prepared before the dynamic import below.
process.env.LOG_TO_FILE = "false";
process.env.LOG_LEVEL = "debug";

const {
  createLogger,
  maskEmail,
  queryLogs,
  resetLogBuffer,
  sanitizeFields,
  writeRecord,
} = await import("../src/utils/logger.js");

describe("log redaction", () => {
  it("drops credential-bearing keys regardless of spelling", () => {
    const fields = sanitizeFields({
      password: "hunter2",
      passwordToken: "abc",
      "X-Access-Token": "abc",
      access_token: "abc",
      Cookie: "sid=1",
      setCookie: "sid=1",
      dsPersonId: "123456",
      sinfs: ["blob"],
      iTunesMetadata: "base64",
      signature: "AAAA",
      apiKey: "k",
    });

    for (const value of Object.values(fields)) {
      expect(value).toBe("[redacted]");
    }
  });

  it("keeps diagnostic fields intact", () => {
    expect(
      sanitizeFields({
        status: 204,
        host: "buy.itunes.apple.com",
        signatureLength: 1234,
        authURL: "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      }),
    ).toEqual({
      status: 204,
      host: "buy.itunes.apple.com",
      signatureLength: 1234,
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
  });

  it("keeps measurements of secrets, which are diagnostics rather than secrets", () => {
    expect(
      sanitizeFields({ cookieCount: 4, signatureLength: 668, sinfCount: 2 }),
    ).toEqual({ cookieCount: 4, signatureLength: 668, sinfCount: 2 });
  });

  it("still redacts the size of a credential itself", () => {
    expect(sanitizeFields({ passwordLength: 12, tokenBytes: 64 })).toEqual({
      passwordLength: "[redacted]",
      tokenBytes: "[redacted]",
    });
  });

  it("masks email addresses wherever they appear", () => {
    expect(maskEmail("someone@example.com")).toBe("s******@example.com");
    expect(sanitizeFields({ note: "login for user@icloud.com failed" })).toEqual(
      { note: "login for u***@icloud.com failed" },
    );
  });

  it("truncates oversized strings instead of writing them whole", () => {
    const long = "x".repeat(900);
    const result = sanitizeFields({ body: long }).body as string;
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("(+388 chars)");
  });

  it("redacts nested values and caps recursion", () => {
    const nested = sanitizeFields({
      response: { headers: { cookie: "sid=1", status: 204 } },
    }) as Record<string, any>;
    expect(nested.response.headers.cookie).toBe("[redacted]");
    expect(nested.response.headers.status).toBe(204);
  });

  it("never lets a field overwrite a reserved record key", () => {
    expect(sanitizeFields({ msg: "spoofed", level: "error" })).toEqual({
      f_msg: "spoofed",
      f_level: "error",
    });
  });

  it("omits undefined fields", () => {
    expect(sanitizeFields({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });
});

describe("log buffer and queries", () => {
  beforeEach(() => resetLogBuffer());

  it("honours the configured level", () => {
    writeRecord("trace", "test", "too verbose");
    writeRecord("info", "test", "kept");
    const { records } = queryLogs({ limit: 10, scope: "test" });
    expect(records.map((r) => r.msg)).toEqual(["kept"]);
  });

  it("filters by level, scope and search text", () => {
    const log = createLogger("alpha");
    log.error("boom", { task: "t1" });
    log.info("fine", { task: "t2" });
    createLogger("beta").error("other", {});

    expect(
      queryLogs({ level: "error", scope: "alpha" }).records.map((r) => r.msg),
    ).toEqual(["boom"]);
    expect(queryLogs({ scope: "alpha" }).records).toHaveLength(2);
    expect(queryLogs({ search: "t2" }).records.map((r) => r.msg)).toEqual([
      "fine",
    ]);
  });

  it("returns newest records first", () => {
    const log = createLogger("order");
    log.info("first");
    log.info("second");
    expect(
      queryLogs({ scope: "order" }).records.map((r) => r.msg),
    ).toEqual(["second", "first"]);
  });

  it("reports the memory source when the log file is disabled", () => {
    expect(queryLogs({}).source).toBe("memory");
  });
});
