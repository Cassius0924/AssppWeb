import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { getDownloadInfo } from "../apple/download";
import { purchaseApp, PurchaseError } from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { apiPost, apiGet } from "../api/client";
import { accountHash } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { createLogger } from "../utils/logger";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

const log = createLogger("download-action");

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>("/api/settings");
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t("toast.downloadLimit.message", {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    const { output, updatedCookies } = await getDownloadInfo(
      account,
      app,
      versionId,
    );
    await updateAccount({ ...account, cookies: updatedCookies });
    const hash = await accountHash(account);

    await apiPost("/api/downloads", {
      software: { ...app, version: output.bundleShortVersionString },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      iTunesMetadata: output.iTunesMetadata,
    });

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    // The token is renewed only when Apple actually reports it expired.
    // Re-authenticating before every purchase used to send one request to the
    // authenticate endpoint per button press, which is what draws Apple's
    // throttling — and because that failure was swallowed, the purchase then
    // ran with a dead token and surfaced a misleading error instead.
    let currentAccount = account;
    let result;
    try {
      result = await purchaseApp(currentAccount, app);
    } catch (e) {
      if (!(e instanceof PurchaseError)) throw e;

      // 5002 says only that Apple declined; it does not say whether the
      // license is missing or already held. The download endpoint knows,
      // so ask it rather than reporting a failure the account may not have.
      if (e.code === "5002") {
        log.info("5002 — checking whether the license already exists", {
          bundleId: app.bundleID,
        });
        try {
          const { updatedCookies } = await getDownloadInfo(currentAccount, app);
          await updateAccount({ ...currentAccount, cookies: updatedCookies });
          log.info("license already held", { bundleId: app.bundleID });
          addToast(
            t("toast.msg", { appName, ...ctx }),
            "success",
            t("toast.title.licenseAlreadyOwned"),
          );
          return;
        } catch {
          // No license either — the original refusal stands.
          throw e;
        }
      }

      if (!e.tokenExpired) throw e;

      log.info("password token expired, re-authenticating once", {
        bundleId: app.bundleID,
        code: e.code,
      });
      const renewed = await authenticate(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
        account.pod,
      );
      await updateAccount(renewed);
      currentAccount = renewed;
      result = await purchaseApp(currentAccount, app);
    }

    await updateAccount({ ...currentAccount, cookies: result.updatedCookies });

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "success",
      t("toast.title.licenseSuccess"),
    );
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.downloadFailed")),
      }),
      "error",
      t("toast.title.downloadFailed"),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.licenseFailed")),
      }),
      "error",
      t("toast.title.licenseFailed"),
    );
  }

  return {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
