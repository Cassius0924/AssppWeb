import { authHeaders } from '../api/client';
import { parsePlist } from './plist';
import { sapEndpoints, SapConfigurationError } from './sap/protocol';
import { createLogger } from '../utils/logger';
import type { SapEndpoints } from './sap/protocol';

const log = createLogger('apple:bag');

export interface BagOutput {
  authURL: string;
  sap?: SapEndpoints;
}

export const defaultAuthURL =
  'https://auth.itunes.apple.com/auth/v1/native/fast/';

const NATIVE_AUTH_HOST = 'auth.itunes.apple.com';

// The bag advertises the native auth endpoint without the /fast/ sub-path that
// the login flow requires; the no-trailing-slash variant 301s to an HTML page.
// Legacy endpoints on other hosts pass through unchanged.
export function normalizeAuthURL(rawURL: string): string {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (url.hostname !== NATIVE_AUTH_HOST) {
    return rawURL;
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/fast')) {
    path += '/fast';
  }
  url.pathname = `${path}/`;
  return url.toString();
}

// Fetches the bag via the backend proxy.
// The backend fetches it using Node.js native HTTPS.
// The bag response is public data (Apple service URLs, no credentials).
export async function fetchBag(deviceId: string): Promise<BagOutput> {
  try {
    const resp = await fetch(`/api/bag?guid=${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      log.warn('proxy request failed, using default auth endpoint', {
        status: resp.status,
        error: err.error || `HTTP ${resp.status}`,
        fallback: defaultAuthURL,
      });
      return { authURL: defaultAuthURL };
    }

    const xml = await resp.text();
    const dict = parsePlist(xml) as Record<string, any>;

    // authenticateAccount used to live inside the urlBag dict; newer bag
    // responses move it to the plist root, so prefer the root and fall back.
    const urlBag = dict.urlBag as Record<string, any> | undefined;
    const sap = sapEndpoints({ ...urlBag, ...dict });
    const authURL =
      (dict.authenticateAccount as string | undefined) ??
      (urlBag?.authenticateAccount as string | undefined);

    if (!authURL) {
      log.warn('authenticateAccount missing from bag, using default endpoint', {
        bytes: xml.length,
        fallback: defaultAuthURL,
        sapConfigured: Boolean(sap),
      });
      return { authURL: defaultAuthURL, sap };
    }

    const resolved = normalizeAuthURL(authURL);
    log.info('bag resolved', {
      bytes: xml.length,
      authURL: resolved,
      normalized: resolved !== authURL,
      sapConfigured: Boolean(sap),
      sapSetupURL: sap?.setupURL,
      sapCertificateURL: sap?.certificateURL,
    });
    return { authURL: resolved, sap };
  } catch (error) {
    if (error instanceof SapConfigurationError) throw error;
    log.warn('failed to fetch/parse bag, using default auth endpoint', {
      error,
      fallback: defaultAuthURL,
    });
    return { authURL: defaultAuthURL };
  }
}
