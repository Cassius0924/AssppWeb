import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  authenticate,
  AuthThrottledError,
} from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { signAuthBody } from '../../src/apple/sap/client';

vi.mock('../../src/apple/sap/client', () => ({ signAuthBody: vi.fn() }));

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs the exact body on redirects and includes the 2FA code', async () => {
    const sap = { version: 200 as const, certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist', setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy' };
    vi.mocked(fetchBag).mockResolvedValue({ authURL: 'https://buy.itunes.apple.com/authenticate', sap });
    vi.mocked(signAuthBody).mockResolvedValueOnce('first-signature').mockResolvedValue('second-signature');
    const success = { status: 200, statusText: 'OK', headers: {}, rawHeaders: [], body: buildPlist({ accountInfo: { address: {} }, passwordToken: 'token', dsPersonId: '123' }) };
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...success, status: 307, headers: { location: 'https://p25-buy.itunes.apple.com/authenticate' }, body: '' }).mockResolvedValue(success);
    await authenticate('user@example.com', '密码<&', '123456', undefined, 'aabbccddeeff');
    expect(signAuthBody).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 2; index++) {
      const request = vi.mocked(appleRequest).mock.calls[index][0];
      expect(vi.mocked(signAuthBody).mock.calls[index]).toEqual(['aabbccddeeff', sap, request.body]);
      expect(request.body).toContain('密码&lt;&amp;123456');
      expect(request.headers?.['X-Apple-ActionSignature']).toBe(index ? 'second-signature' : 'first-signature');
    }
  });

  it('does not send credentials when signing fails', async () => {
    vi.mocked(fetchBag).mockResolvedValue({ authURL: 'https://buy.itunes.apple.com/authenticate', sap: { version: 200, certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist', setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy' } });
    vi.mocked(signAuthBody).mockRejectedValue(new Error('Signing failed'));
    await expect(authenticate('user@example.com', 'secret', undefined, undefined, 'aabbccddeeff')).rejects.toThrow('Signing failed');
    expect(appleRequest).not.toHaveBeenCalled();
  });

  // Apple's edge answers throttled requests itself — a 301 with no Location or
  // an empty 204 — and those responses lack the Jingle correlation key that
  // every store-application response carries.
  const edgeHeaders = {
    server: "Apple",
    "strict-transport-security": "max-age=31536000",
  };
  const appHeaders = {
    ...edgeHeaders,
    "x-apple-jingle-correlation-key": "LMAJWGEYXRRYHBDCQW6CBMKRFI",
  };

  function response(over: Record<string, unknown>) {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: "",
      ...over,
    } as any;
  }

  it("reports edge throttling for a 301 without a Location header", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://buy.itunes.apple.com/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue(
      response({ status: 301, headers: edgeHeaders, body: "<html></html>" }),
    );

    await expect(
      authenticate("user@example.com", "secret", undefined, undefined, "aabb"),
    ).rejects.toBeInstanceOf(AuthThrottledError);

    // Retrying would spend another request against the limit that just rejected us.
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("reports edge throttling for an empty 204", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://buy.itunes.apple.com/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue(
      response({ status: 204, headers: edgeHeaders }),
    );

    await expect(
      authenticate("user@example.com", "secret", undefined, undefined, "aabb"),
    ).rejects.toBeInstanceOf(AuthThrottledError);
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the original error when the store application answered", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://buy.itunes.apple.com/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue(
      response({ status: 302, headers: appHeaders }),
    );

    const error = await authenticate(
      "user@example.com",
      "secret",
      undefined,
      undefined,
      "aabb",
    ).catch((e) => e);

    expect(error).not.toBeInstanceOf(AuthThrottledError);
    // A real application response still gets the existing two attempts.
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });
});
