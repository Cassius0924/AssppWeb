import type { Account, Software } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { purchaseAPIHost, RETRYABLE_FAILURE_TYPE } from "./config";
import { createLogger } from "../utils/logger";
import i18n from "../i18n";

const log = createLogger("apple:purchase");

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    /** Apple rejected the stored password token; one re-authentication may fix it. */
    public readonly tokenExpired: boolean = false,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

export async function purchaseApp(
  account: Account,
  app: Software,
): Promise<{ updatedCookies: typeof account.cookies }> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t("errors.purchase.paidNotSupported"));
  }

  log.info("acquiring license", {
    bundleId: app.bundleID,
    trackId: app.id,
    store: account.store,
    pod: account.pod,
  });

  try {
    return await purchaseWithParams(account, app, "STDQ");
  } catch (e) {
    // Rely on error code instead of translated message string to prevent matching issues
    if (e instanceof PurchaseError && e.code === "2059") {
      log.info("retrying license with GAME pricing", {
        bundleId: app.bundleID,
      });
      return await purchaseWithParams(account, app, "GAME");
    }

    // 5002 is Apple's catch-all, and the download flow already treats it as
    // something a different endpoint may answer differently. The pod host is
    // the only one this call has ever used, so give the generic store host a
    // turn before giving up.
    if (
      e instanceof PurchaseError &&
      e.code === RETRYABLE_FAILURE_TYPE &&
      account.pod
    ) {
      log.info("retrying license on the generic store host", {
        bundleId: app.bundleID,
        from: purchaseAPIHost(account.pod),
        to: purchaseAPIHost(),
      });
      return await purchaseWithParams(
        { ...account, pod: undefined },
        app,
        "STDQ",
      );
    }
    log.warn("license acquisition failed", {
      bundleId: app.bundleID,
      code: e instanceof PurchaseError ? e.code : undefined,
      error: e,
    });
    throw e;
  }
}

async function purchaseWithParams(
  account: Account,
  app: Software,
  pricingParameters: string,
): Promise<{ updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;
  const host = purchaseAPIHost(account.pod);
  const path = "/WebObjects/MZFinance.woa/wa/buyProduct";

  const payload: Record<string, any> = {
    appExtVrsId: "0",
    hasAskedToFulfillPreorder: "true",
    buyWithoutAuthorization: "true",
    hasDoneAgeCheck: "true",
    guid: deviceId,
    needDiv: "0",
    origPage: `Software-${app.id}`,
    origPageLocation: "Buy",
    price: "0",
    pricingParameters,
    productType: "C",
    salableAdamId: app.id,
  };

  const plistBody = buildPlist(payload);

  // Echo the storefront Apple itself sent. Reassembling one from the numeric
  // id guesses at the suffix, and a storefront Apple does not recognise comes
  // back as a generic failure rather than a specific one.
  const storeFront = account.storeFront || `${account.store}-1`;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Dsid": account.directoryServicesIdentifier,
    "X-Apple-Store-Front": storeFront,
    "X-Token": account.passwordToken,
  };

  const response = await appleRequest({
    method: "POST",
    host,
    path,
    headers,
    body: plistBody,
    cookies: account.cookies,
  });

  const updatedCookies = extractAndMergeCookies(
    response.rawHeaders,
    account.cookies,
  );

  const dict = parsePlist(response.body) as Record<string, any>;

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;
    log.warn("purchase returned a failure", {
      bundleId: app.bundleID,
      pricingParameters,
      failureType,
      customerMessage,
      status: response.status,
      storeFront,
      storeFrontEchoed: Boolean(account.storeFront),
      // Rules out the trivial explanations. The names live in the value, not
      // the key, so redaction does not swallow the answer.
      missingCredentials: [
        account.passwordToken ? '' : 'passwordToken',
        account.directoryServicesIdentifier ? '' : 'dsid',
      ].filter(Boolean),
      // The whole body: four keys, none of them secret, and `m-allowed` has
      // never been read. Redaction still applies on the way out.
      body: dict,
      dialog: dict.dialog,
      action: dict.action,
    });
    switch (failureType) {
      // 5002 is Apple's catch-all: the response carries no dialog or action,
      // and it comes back for every app, so it describes the account or the
      // device rather than the request.
      case "5002":
        throw new PurchaseError(
          i18n.t("errors.purchase.licenseDeclined"),
          "5002",
        );
      case "2059":
        throw new PurchaseError(i18n.t("errors.purchase.unavailable"), "2059");
      case "2034":
      case "2042":
        throw new PurchaseError(
          i18n.t("errors.purchase.passwordExpired"),
          failureType,
          true,
        );
      default: {
        if (customerMessage === "Your password has changed.") {
          throw new PurchaseError(
            i18n.t("errors.purchase.passwordExpired"),
            failureType,
            true,
          );
        }
        if (customerMessage === "Subscription Required") {
          throw new PurchaseError(
            i18n.t("errors.purchase.subscriptionRequired"),
            failureType,
          );
        }
        // Check for terms page action
        const action = dict.action as Record<string, any> | undefined;
        if (action) {
          const actionUrl = (action.url || action.URL) as string | undefined;
          if (actionUrl && actionUrl.endsWith("termsPage")) {
            throw new PurchaseError(
              i18n.t("errors.purchase.termsRequired", { url: actionUrl }),
              failureType,
            );
          }
        }

        // Handle unknown error specific fallback mappings
        let msg = customerMessage;
        if (
          msg === "An unknown error has occurred" ||
          msg === "An unknown error has occurred."
        ) {
          msg = i18n.t("errors.purchase.unknownError");
        }

        throw new PurchaseError(
          msg ?? i18n.t("errors.purchase.failed", { failureType }),
          failureType,
        );
      }
    }
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (jingleDocType !== "purchaseSuccess" || status !== 0) {
    throw new PurchaseError(i18n.t("errors.purchase.failedGeneral"));
  }

  return { updatedCookies };
}
