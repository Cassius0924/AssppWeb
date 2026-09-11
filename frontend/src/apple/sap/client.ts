import { useSapStore } from '../../store/sap';
import { loadAssets } from './assets';
import { exchangeCertificate, fetchCertificate } from './protocol';
import { createLogger } from '../../utils/logger';
import type { SapEndpoints } from './protocol';
import type { WorkerReply, WorkerRequest } from './worker';

const log = createLogger('apple:sap');

type Command = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;
const WORKER_DEADLINE = 180000;
const IDLE_LIFETIME = 10 * 60 * 1000;

class Signer {
  private readonly worker = new Worker(
    new URL('./worker.ts', import.meta.url),
    { type: 'module' },
  );
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (reply: WorkerReply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const item = this.pending.get(event.data.id);
      if (!item) return;
      this.pending.delete(event.data.id);
      clearTimeout(item.timer);
      if (event.data.error) item.reject(new Error(event.data.error));
      else item.resolve(event.data);
    };
    this.worker.onerror = () => this.close();
    this.worker.onmessageerror = () => this.close();
  }

  request(command: Command): Promise<WorkerReply> {
    if (this.closed)
      return Promise.reject(new Error('Signing session has closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), WORKER_DEADLINE);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...command, id });
      } catch {
        // A failed structured clone must release every pending deadline too.
        this.close();
      }
    });
  }

  close(): void {
    this.closed = true;
    this.worker.terminate();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error('Signing session stopped or timed out; please retry'),
      );
    }
    this.pending.clear();
  }
}

let active: { key: string; signer: Signer; ready: Promise<void> } | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();

export function clearSigningSession(): void {
  clearTimeout(idleTimer);
  active?.signer.close();
  active = undefined;
}

async function prepare(
  device: string,
  endpoints: SapEndpoints,
): Promise<Signer> {
  const key = JSON.stringify([device, endpoints]);
  if (active?.key !== key) {
    clearSigningSession();
    const signer = new Signer();
    const ready = (async () => {
      const startedAt = Date.now();
      const update = useSapStore.getState().update;
      update('assets');
      log.info('signing session starting', {
        setupURL: endpoints.setupURL,
        certificateURL: endpoints.certificateURL,
        version: endpoints.version,
      });

      const assets = await loadAssets((percent) => update('assets', percent));
      log.debug('assets loaded', {
        count: Object.keys(assets).length,
        durationMs: Date.now() - startedAt,
      });

      update('initializing');
      await signer.request({ type: 'open', device, assets });
      log.debug('emulator initialized', { durationMs: Date.now() - startedAt });

      const certificate = await fetchCertificate(endpoints);
      const first = await signer.request({
        type: 'exchange',
        bytes: certificate,
      });
      log.debug('certificate exchanged', {
        certificateBytes: certificate.length,
        state: first.state,
        replyBytes: first.bytes?.length ?? 0,
      });
      if (first.state !== 1 || !first.bytes?.length)
        throw new Error('Unexpected SAP setup state');

      const response = await exchangeCertificate(endpoints, first.bytes);
      const second = await signer.request({
        type: 'exchange',
        bytes: response,
      });
      log.debug('setup exchange completed', {
        responseBytes: response.length,
        state: second.state,
      });
      if (second.state !== 0) throw new Error('SAP setup did not complete');

      update('ready');
      log.info('signing session ready', { durationMs: Date.now() - startedAt });
    })();
    active = { key, signer, ready };
  }
  await active.ready;
  return active.signer;
}

/** Serialize account switches and 2FA attempts; never reuse another device's context. */
export function signAuthBody(
  device: string,
  endpoints: SapEndpoints,
  body: string,
): Promise<string> {
  const operation = queue.then(async () => {
    clearTimeout(idleTimer);
    const bytes = new TextEncoder().encode(body);
    try {
      const signer = await prepare(device, endpoints);
      const startedAt = Date.now();
      const result = await signer.request({ type: 'sign', bytes });
      log.debug('body signed', {
        inputBytes: bytes.length,
        signatureBytes: result.bytes?.length ?? 0,
        durationMs: Date.now() - startedAt,
      });
      if (!result.bytes?.length || result.bytes.length > 65536)
        throw new Error('Invalid Apple signature');
      let binary = '';
      for (const byte of result.bytes) binary += String.fromCharCode(byte);
      idleTimer = setTimeout(clearSigningSession, IDLE_LIFETIME);
      return btoa(binary);
    } catch (error) {
      log.error('signing failed', { error });
      clearSigningSession();
      useSapStore.getState().update('error');
      throw error;
    } finally {
      bytes.fill(0);
    }
  });
  queue = operation.catch(() => undefined);
  return operation;
}
