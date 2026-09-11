import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { RotatingFileWriter } from "../src/utils/logFile.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-log-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RotatingFileWriter", () => {
  it("appends newline-terminated lines", () => {
    const writer = new RotatingFileWriter({
      dir,
      baseName: "asspp.log",
      maxBytes: 1024,
      maxFiles: 3,
    });
    writer.write("first");
    writer.write("second\n");
    writer.close();

    expect(fs.readFileSync(path.join(dir, "asspp.log"), "utf8")).toBe(
      "first\nsecond\n",
    );
  });

  it("rotates once the size limit is exceeded and drops the oldest file", () => {
    const writer = new RotatingFileWriter({
      dir,
      baseName: "asspp.log",
      maxBytes: 40,
      maxFiles: 2,
    });
    for (let i = 0; i < 12; i++) writer.write(`line-${i}-padding-padding`);
    writer.close();

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(["asspp.log", "asspp.log.1", "asspp.log.2"]);
    // The newest generation is the live file; the retention cap is honoured.
    expect(fs.readFileSync(path.join(dir, "asspp.log"), "utf8")).toContain(
      "line-11",
    );
  });

  it("reads back only whole trailing lines", () => {
    const writer = new RotatingFileWriter({
      dir,
      baseName: "asspp.log",
      maxBytes: 1 << 20,
      maxFiles: 2,
    });
    for (let i = 0; i < 5; i++) writer.write(`entry-${i}`);
    writer.close();

    expect(writer.readTail(1 << 20)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2",
      "entry-3",
      "entry-4",
    ]);
    // A short tail starts mid-line, so the partial fragment is discarded.
    expect(writer.readTail(20).every((line) => /^entry-\d$/.test(line))).toBe(
      true,
    );
  });

  it("degrades to a no-op instead of throwing when the directory is unusable", () => {
    const writer = new RotatingFileWriter({
      dir: path.join(dir, "file-in-the-way", "logs"),
      baseName: "asspp.log",
      maxBytes: 1024,
      maxFiles: 2,
    });
    fs.writeFileSync(path.join(dir, "file-in-the-way"), "not a directory");

    expect(() => writer.write("line")).not.toThrow();
    expect(writer.isHealthy).toBe(false);
    expect(writer.readTail(1024)).toEqual([]);
  });
});
