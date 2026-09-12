import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { purchaseApp } from "../../src/apple/purchase";
import { appleRequest } from "../../src/apple/request";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({ appleRequest: vi.fn() }));

const app = { id: 6473753684, bundleID: "com.example.app", price: 0 } as Software;

function account(over: Partial<Account> = {}): Account {
  return {
    email: "user@example.com",
    password: "secret",
    appleId: "user@example.com",
    store: "143441",
    firstName: "A",
    lastName: "B",
    passwordToken: "token",
    directoryServicesIdentifier: "1234",
    cookies: [],
    deviceIdentifier: "aabbccddeeff",
    pod: "32",
    ...over,
  } as Account;
}

describe("apple/purchase 5002 fallback", () => {
  const failure = buildPlist({
    failureType: "5002",
    customerMessage: "An unknown error has occurred",
  });
  const success = buildPlist({ jingleDocType: "purchaseSuccess", status: 0 });

  function reply(body: string) {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body,
    } as never;
  }

  beforeEach(() => vi.clearAllMocks());

  it("gives the generic store host a turn before giving up", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(reply(failure))
      .mockResolvedValueOnce(reply(success));

    await purchaseApp(account(), app);

    const hosts = vi.mocked(appleRequest).mock.calls.map((c) => c[0].host);
    expect(hosts).toEqual([
      "p32-buy.itunes.apple.com",
      "buy.itunes.apple.com",
    ]);
  });

  it("reports the failure when the generic host refuses too", async () => {
    vi.mocked(appleRequest).mockResolvedValue(reply(failure));

    await expect(purchaseApp(account(), app)).rejects.toMatchObject({
      code: "5002",
    });
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it("does not retry when there is no pod host to move off", async () => {
    vi.mocked(appleRequest).mockResolvedValue(reply(failure));

    await expect(
      purchaseApp(account({ pod: undefined }), app),
    ).rejects.toMatchObject({ code: "5002" });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });
});

describe("apple/purchase storefront header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({ jingleDocType: "purchaseSuccess", status: 0 }),
    } as never);
  });

  it("echoes the storefront Apple sent, suffix and all", async () => {
    await purchaseApp(account({ storeFront: "143441-1,29" }), app);

    expect(
      vi.mocked(appleRequest).mock.calls[0][0].headers?.[
        "X-Apple-Store-Front"
      ],
    ).toBe("143441-1,29");
  });

  it("falls back to the reassembled storefront for accounts saved before", async () => {
    await purchaseApp(account({ storeFront: undefined }), app);

    expect(
      vi.mocked(appleRequest).mock.calls[0][0].headers?.[
        "X-Apple-Store-Front"
      ],
    ).toBe("143441-1");
  });
});
