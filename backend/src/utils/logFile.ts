import fs from "fs";
import path from "path";

export interface RotatingFileOptions {
  dir: string;
  /** Base file name, e.g. "asspp.log". Rotated copies get ".1", ".2", … suffixes. */
  baseName: string;
  maxBytes: number;
  maxFiles: number;
}

/**
 * Append-only writer with size-based rotation.
 *
 * Writes are synchronous on purpose: the lines worth having are the ones
 * written just before a crash, and a buffered stream loses exactly those.
 * Every failure is swallowed, so a full disk or a read-only volume degrades to
 * stdout-only logging instead of throwing from whatever code path emitted the
 * line.
 */
export class RotatingFileWriter {
  private fd: number | null = null;
  private bytes = 0;
  private disabled = false;

  constructor(private readonly options: RotatingFileOptions) {}

  get filePath(): string {
    return path.join(this.options.dir, this.options.baseName);
  }

  get isHealthy(): boolean {
    return !this.disabled;
  }

  write(line: string): void {
    if (this.disabled) return;
    const data = line.endsWith("\n") ? line : `${line}\n`;
    const size = Buffer.byteLength(data);

    try {
      if (this.fd === null) this.open();
      if (this.bytes > 0 && this.bytes + size > this.options.maxBytes) {
        this.rotate();
      }
      fs.writeSync(this.fd!, data);
      this.bytes += size;
    } catch {
      this.disable();
    }
  }

  /** Reads back the trailing `maxBytes` of the live file, newest line last. */
  readTail(maxBytes: number): string[] {
    try {
      const stat = fs.statSync(this.filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      if (length <= 0) return [];

      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(this.filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }

      const lines = buffer.toString("utf8").split("\n");
      // A non-zero offset almost certainly lands mid-line; drop that fragment.
      if (start > 0) lines.shift();
      return lines.filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
    } catch {
      // Nothing actionable during shutdown.
    }
    this.fd = null;
  }

  private open(): void {
    fs.mkdirSync(this.options.dir, { recursive: true });
    this.fd = fs.openSync(this.filePath, "a");
    this.bytes = fs.fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();

    // Drop the oldest generation, then shift every survivor one slot down.
    const oldest = `${this.filePath}.${this.options.maxFiles}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = this.options.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
    }
    if (fs.existsSync(this.filePath)) {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    }

    this.open();
  }

  private disable(): void {
    this.disabled = true;
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
    } catch {
      // The descriptor is already unusable; nothing left to do.
    }
    this.fd = null;
  }
}
