import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadAction } from "../../src/hooks/useDownloadAction";
import { PurchaseError, purchaseApp } from "../../src/apple/purchase";
import { authenticate } from "../../src/apple/authenticate";
import { getDownloadInfo } from "../../src/apple/download";
import type { Account, Software } from "../../src/types";

const mocks = vi.hoisted(() => ({
  updateAccount: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({ updateAccount: mocks.updateAccount }),
}));

vi.mock("../../src/store/toast", () => ({
  useToastStore: (selector: (s: unknown) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

vi.mock("../../src/store/downloads", () => ({
  useDownloadsStore: (selector: (s: unknown) => unknown) =>
    selector({ fetchTasks: vi.fn() }),
}));

// The real modules reach libcurl.js, whose WASM cannot initialize under Node,
// so the error class is redefined here — the hook and the test then share one
// constructor and `instanceof` still means what it means in the browser.
vi.mock("../../src/apple/purchase", () => {
  class PurchaseError extends Error {
    constructor(
      message: string,
      public readonly code?: string,
      public readonly tokenExpired: boolean = false,
    ) {
      super(message);
      this.name = "PurchaseError";
    }
  }
  return { PurchaseError, purchaseApp: vi.fn() };
});

vi.mock("../../src/apple/authenticate", () => ({ authenticate: vi.fn() }));

vi.mock("../../src/apple/download", () => ({ getDownloadInfo: vi.fn() }));

const account = {
  email: "user@example.com",
  password: "secret",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
} as unknown as Account;

const app = { id: 1, bundleID: "com.example.app", name: "App" } as Software;

describe("useDownloadAction / acquireLicense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("purchases without re-authenticating first", async () => {
    vi.mocked(purchaseApp).mockResolvedValue({ updatedCookies: [] } as never);

    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);

    // A preemptive renewal sent one request to the authenticate endpoint per
    // button press, which is what drew Apple's throttling.
    expect(authenticate).not.toHaveBeenCalled();
    expect(purchaseApp).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates once and retries when the token expired", async () => {
    vi.mocked(purchaseApp)
      .mockRejectedValueOnce(new PurchaseError("expired", "2034", true))
      .mockResolvedValue({ updatedCookies: [] } as never);
    vi.mocked(authenticate).mockResolvedValue({
      ...account,
      passwordToken: "fresh",
    } as never);

    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(purchaseApp).toHaveBeenCalledTimes(2);
  });

  it("treats 5002 as already owned when the license actually resolves", async () => {
    vi.mocked(purchaseApp).mockRejectedValue(
      new PurchaseError("unknown error", "5002"),
    );
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: {},
      updatedCookies: [],
    } as never);

    const { result } = renderHook(() => useDownloadAction());
    await result.current.acquireLicense(account, app);

    // 5002 does not distinguish "declined" from "you already have it";
    // the download endpoint does, so it decides.
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.anything(),
      "success",
      "toast.title.licenseAlreadyOwned",
    );
  });

  it("reports 5002 when there is no license either", async () => {
    const failure = new PurchaseError("unknown error", "5002");
    vi.mocked(purchaseApp).mockRejectedValue(failure);
    vi.mocked(getDownloadInfo).mockRejectedValue(new Error("no items"));

    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toBe(
      failure,
    );
  });

  it("surfaces other purchase failures instead of hiding them", async () => {
    const failure = new PurchaseError("unavailable", "2059");
    vi.mocked(purchaseApp).mockRejectedValue(failure);

    const { result } = renderHook(() => useDownloadAction());
    await expect(result.current.acquireLicense(account, app)).rejects.toBe(
      failure,
    );

    expect(authenticate).not.toHaveBeenCalled();
    expect(getDownloadInfo).not.toHaveBeenCalled();
    expect(purchaseApp).toHaveBeenCalledTimes(1);
  });
});
