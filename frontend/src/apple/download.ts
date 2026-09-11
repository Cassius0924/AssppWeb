import type { Account, Software, DownloadOutput, Sinf } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";
import { createLogger } from "../utils/logger";
import i18n from "../i18n";

const log = createLogger("apple:download");

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{ output: DownloadOutput; updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  log.info("requesting download info", {
    bundleId: app.bundleID,
    trackId: app.id,
    host: endpoint.host,
    pod: account.pod,
    externalVersionId,
  });
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
    };

    if (externalVersionId) {
      payload[endpoint.externalVersionIdKey] = externalVersionId;
    }

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: "POST",
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    if (response.status === 302) {
      const location = response.headers["location"];
      if (!location) {
        log.error("redirect without a Location header", {
          host: requestHost,
          status: response.status,
          responseHeaders: Object.keys(response.headers),
          redirectAttempt,
        });
        throw new DownloadError(i18n.t("errors.download.redirectLocation"));
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    const dict = parsePlist(response.body) as Record<string, any>;

    if (dict.failureType) {
      const failureType = String(dict.failureType);

      // volumeStore intermittently returns 5002; retry once via the
      // redownload dispatch endpoint, which serves the same payload.
      if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
        log.info("retrying via the redownload dispatch endpoint", {
          bundleId: app.bundleID,
          failureType,
        });
        triedRedownload = true;
        endpoint = redownloadEndpoint(deviceId);
        requestHost = endpoint.host;
        requestPath = endpoint.path;
        redirectAttempt = 0;
        continue;
      }

      const customerMessage = dict.customerMessage as string | undefined;
      log.warn("download info returned a failure", {
        bundleId: app.bundleID,
        host: requestHost,
        failureType,
        customerMessage,
      });
      switch (failureType) {
        case "2034":
        case "2042":
          throw new DownloadError(
            i18n.t("errors.download.passwordExpired"),
            failureType,
          );
        case "9610":
          throw new DownloadError(
            i18n.t("errors.download.licenseRequired"),
            "9610",
          );
        default: {
          if (customerMessage === "Your password has changed.") {
            throw new DownloadError(
              i18n.t("errors.download.passwordExpired"),
              failureType,
            );
          }
          // If apple provides a specific string, we fall back to it, otherwise we use the localized default.
          throw new DownloadError(
            customerMessage ??
              i18n.t("errors.download.downloadFailed", { failureType }),
            failureType,
          );
        }
      }
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      // Reached when the account holds no license for the app: Apple answers
      // 200 with a plist that carries neither a failureType nor any item.
      log.error("response contained no items", {
        bundleId: app.bundleID,
        host: requestHost,
        status: response.status,
        bodyBytes: response.body.length,
        keys: Object.keys(dict),
        // Whether Apple considers the session authorized, and whether the
        // library holds anything at all, separates "no license" from
        // "not signed in".
        authorized: dict.authorized,
        customerMessage: dict.customerMessage,
        queueItemCount: dict["download-queue-item-count"],
        jingleDocType: dict.jingleDocType,
        jingleAction: dict.jingleAction,
        statusValue: dict.status,
        metrics: dict.metrics,
      });
      throw new DownloadError(i18n.t("errors.download.noItems"));
    }

    const item = songList[0];
    const url = item.URL as string;
    if (!url) {
      log.error("item carried no download URL", {
        bundleId: app.bundleID,
        itemKeys: Object.keys(item),
      });
      throw new DownloadError(i18n.t("errors.download.missingUrl"));
    }

    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      log.error("item carried no metadata", {
        bundleId: app.bundleID,
        itemKeys: Object.keys(item),
      });
      throw new DownloadError(i18n.t("errors.download.missingMetadata"));
    }

    const version = metadata.bundleShortVersionString as string;
    const bundleVersion = metadata.bundleVersion as string;
    if (!version || !bundleVersion) {
      log.error("metadata carried no version", {
        bundleId: app.bundleID,
        hasShortVersion: Boolean(version),
        hasBundleVersion: Boolean(bundleVersion),
      });
      throw new DownloadError(i18n.t("errors.download.missingVersion"));
    }

    const sinfs: Sinf[] = [];
    const sinfData = item.sinfs as Record<string, any>[] | undefined;
    if (sinfData) {
      for (const sinfItem of sinfData) {
        const id = sinfItem.id as number;
        const sinf = sinfItem.sinf;
        if (id !== undefined && sinf) {
          let sinfBase64: string;
          if (sinf instanceof Uint8Array || sinf instanceof ArrayBuffer) {
            const bytes =
              sinf instanceof ArrayBuffer ? new Uint8Array(sinf) : sinf;
            sinfBase64 = base64FromBytes(bytes);
          } else if (typeof sinf === "string") {
            sinfBase64 = sinf;
          } else {
            throw new DownloadError(i18n.t("errors.download.invalidSinf"));
          }
          sinfs.push({ id, sinf: sinfBase64 });
        }
      }
    }

    if (sinfs.length === 0) {
      log.error("item carried no sinfs", {
        bundleId: app.bundleID,
        itemKeys: Object.keys(item),
      });
      throw new DownloadError(i18n.t("errors.download.noSinf"));
    }

    // Build iTunesMetadata plist
    const metadataDict: Record<string, any> = { ...metadata };
    metadataDict["apple-id"] = account.email;
    metadataDict["userName"] = account.email;
    delete metadataDict.passwordToken;
    delete metadataDict["passwordToken"];
    const iTunesMetadata = base64FromString(buildPlist(metadataDict));

    log.info("download info resolved", {
      bundleId: app.bundleID,
      version,
      bundleVersion,
      sinfCount: sinfs.length,
      downloadHost: safeHost(url),
      redirects: redirectAttempt,
    });

    return {
      output: {
        downloadURL: url,
        sinfs,
        bundleShortVersionString: version,
        bundleVersion,
        iTunesMetadata,
      },
      updatedCookies: cookies,
    };
  }

  log.error("gave up after too many redirects", {
    bundleId: app.bundleID,
    host: requestHost,
    redirects: redirectAttempt,
  });
  throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
}

/** CDN URLs carry signed query parameters, so only the host is logged. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return base64FromBytes(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
