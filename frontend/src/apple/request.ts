import { libcurl, initLibcurl } from "./libcurl-init";
import { buildCookieHeader } from "./cookies";
import { createLogger } from "../utils/logger";
import { userAgent } from "./config";
import type { Cookie } from "../types";

const log = createLogger("apple:request");

/**
 * Describes a response body without quoting it. Apple's auth responses carry
 * password tokens and DSIDs, so the shape is logged and the content never is.
 */
function bodyKind(body: string): string {
  const head = body.trimStart().slice(0, 64).toLowerCase();
  if (!head) return "empty";
  if (head.startsWith("<?xml") || head.startsWith("<plist")) {
    return head.includes("<plist") ? "plist" : "xml";
  }
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "html";
  }
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  return "other";
}

export interface AppleRequestOptions {
  host: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  cookies?: Cookie[];
}

export interface AppleResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: [string, string][];
  body: string;
}

export async function appleRequest(
  opts: AppleRequestOptions,
): Promise<AppleResponse> {
  await initLibcurl();

  const url = `https://${opts.host}${opts.path}`;
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    ...opts.headers,
  };

  if (opts.cookies?.length) {
    const cookieHeader = buildCookieHeader(opts.cookies, url);
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }
  }

  const startedAt = Date.now();
  // Header names are safe to log; values are not (Cookie, X-Apple-ActionSignature).
  log.debug("request", {
    method: opts.method,
    host: opts.host,
    path: opts.path,
    requestHeaders: Object.keys(headers),
    requestBytes: opts.body ? new Blob([opts.body]).size : 0,
    cookieCount: opts.cookies?.length ?? 0,
  });

  let resp;
  try {
    resp = await libcurl.fetch(url, {
      method: opts.method,
      headers,
      body: opts.body,
      redirect: "manual",
      _libcurl_http_version: 1.1,
    });
  } catch (error) {
    log.error("transport failure", {
      method: opts.method,
      host: opts.host,
      path: opts.path,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of resp.raw_headers) {
    responseHeaders[key.toLowerCase()] = value;
  }

  const body = await resp.text();

  log.debug("response", {
    method: opts.method,
    host: opts.host,
    path: opts.path,
    status: resp.status,
    durationMs: Date.now() - startedAt,
    responseHeaders: Object.keys(responseHeaders),
    contentType: responseHeaders["content-type"],
    location: responseHeaders["location"],
    bodyBytes: body.length,
    bodyKind: bodyKind(body),
  });

  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: responseHeaders,
    rawHeaders: resp.raw_headers,
    body,
  };
}
