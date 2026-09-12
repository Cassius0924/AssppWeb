import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { fetchBag, defaultAuthURL } from './bag';
import { storeAPIHost } from './config';
import { signAuthBody } from './sap/client';
import { createLogger } from '../utils/logger';
import type { Account, Cookie } from '../types';

const log = createLogger('apple:auth');

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** Apple answered without a response the sign-in flow can act on. */
export class AuthEndpointError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AuthEndpointError';
  }
}

// Every response produced by Apple's store application carries a Jingle
// correlation key. Responses without one — a 3xx with no Location, an empty
// 204, a bare 403 — were synthesized at the edge and hold nothing to act on,
// so they end the attempt loop rather than consuming another retry against a
// host that just produced one.
function refusedByEdge(headers: Record<string, string>): boolean {
  return !('x-apple-jingle-correlation-key' in headers);
}

/** The pod host rejects the bare path with 404; Apple's redirect adds these. */
function podPath(endpoint: URL, pod: string): string {
  const url = new URL(endpoint.toString());
  url.searchParams.set('Pod', pod);
  url.searchParams.set('PRH', pod);
  return `${url.pathname}${url.search}`;
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = '',
  pod?: string,
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = '';
  let storeFrontHeader = '';
  let lastError: Error | null = null;

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set('guid', deviceId);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(deviceId);
  const authEndpoint = new URL(bag.authURL);
  authEndpoint.searchParams.set('guid', deviceId);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  // The generic store host answers a signed sign-in with a redirect to the
  // account's pod, but that response often arrives without a Location header
  // and so cannot be followed. Once the pod is known, address it directly.
  //
  // The pod host needs the Pod and PRH parameters that Apple's own redirect
  // carries; without them it answers 404. Observed Location:
  //   https://p32-buy.itunes.apple.com/...?guid=<guid>&Pod=32&PRH=32
  let podHost = '';
  if (pod) {
    podHost = storeAPIHost(pod);
    requestHost = podHost;
    requestPath = podPath(authEndpoint, pod);
  }

  log.info('authentication started', {
    host: requestHost,
    path: authEndpoint.pathname,
    guid: deviceId,
    withCode: Boolean(code),
    cookieCount: cookies.length,
    sapRequired: Boolean(bag.sap),
    pod: pod || undefined,
  });

  let currentAttempt = 0;
  let redirectAttempt = 0;

  while (currentAttempt < 2 && redirectAttempt <= 3) {
    currentAttempt++;

    try {
      const body: Record<string, string> = {
        appleId: email,
        attempt: code ? '2' : '4',
        guid: deviceId,
        password: code ? `${password}${code}` : password,
        rmp: '0',
        why: 'signIn',
      };

      const plistBody = buildPlist(body);

      const headers: Record<string, string> = {
        'Content-Type': 'application/x-apple-plist',
      };

      if (bag.sap) {
        // Sign the exact UTF-8 body sent below, including this attempt's 2FA code.
        // Signing stays inside the browser; no server ever receives these bytes.
        const signature = await signAuthBody(deviceId, bag.sap, plistBody);
        headers['X-Apple-ActionSignature'] = signature;
        // The signature itself is a credential; only its size is diagnostic.
        log.debug('request signed', {
          signatureLength: signature.length,
          bodyLength: plistBody.length,
        });
      }

      const response = await appleRequest({
        method: 'POST',
        host: requestHost,
        path: requestPath,
        headers,
        body: plistBody,
        cookies,
      });

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      // Read store front
      const storeHeader = response.headers['x-set-apple-store-front'];
      if (storeHeader) {
        storeFrontHeader = storeHeader;
        const parts = storeHeader.split('-');
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers['pod'];
      const pod = podHeader || undefined;

      // Handle redirect. The native /fast auth host can answer with 301 as
      // well as the usual 302, so follow the full set of redirect statuses.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers['location'];
        if (!location) {
          // Apple names the pod in a response header even when it omits the
          // Location it is redirecting to, so the destination is recoverable.
          const advertisedPod = response.headers['pod'] || pod;
          const target = advertisedPod ? storeAPIHost(advertisedPod) : '';
          if (advertisedPod && target && target !== requestHost) {
            log.warn('redirect without Location; retrying on the pod host', {
              from: requestHost,
              to: target,
              status: response.status,
              pod: advertisedPod,
            });
            podHost = target;
            requestHost = target;
            requestPath = podPath(authEndpoint, advertisedPod);
            currentAttempt--;
            redirectAttempt++;
            continue;
          }

          log.error('redirect without a Location header', {
            host: requestHost,
            path: requestPath,
            status: response.status,
            // Full pairs, not just names: this is the response that decides
            // whether the destination is recoverable at all.
            headers: response.headers,
            bodyPreview: response.body.slice(0, 200),
            attempt: currentAttempt,
            redirectAttempt,
            refusedByEdge: refusedByEdge(response.headers),
          });
          throw new AuthEndpointError(
            i18n.t('errors.auth.endpointRefused', { status: response.status }),
            response.status,
          );
        }
        log.info('following redirect', {
          from: requestHost,
          status: response.status,
          location,
        });
        const url = new URL(location);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        const throttled = refusedByEdge(response.headers);
        log.error('empty response body', {
          host: requestHost,
          path: requestPath,
          status: response.status,
          responseHeaders: Object.keys(response.headers),
          signed: Boolean(bag.sap),
          attempt: currentAttempt,
          throttled,
        });
        throw throttled
          ? new AuthEndpointError(
              i18n.t('errors.auth.endpointRefused', { status: response.status }),
              response.status,
            )
          : new Error(
              i18n.t('errors.auth.emptyBody', { status: response.status }),
            );
      }

      let dict: Record<string, any>;
      try {
        dict = parsePlist(response.body) as Record<string, any>;
      } catch (parseError) {
        const throttled = refusedByEdge(response.headers);
        log.error('response was not a plist', {
          host: requestHost,
          path: requestPath,
          status: response.status,
          contentType: response.headers['content-type'],
          bodyBytes: response.body.length,
          signed: Boolean(bag.sap),
          throttled,
          error: parseError,
        });
        throw throttled
          ? new AuthEndpointError(
              i18n.t('errors.auth.endpointRefused', { status: response.status }),
              response.status,
            )
          : parseError;
      }

      // Check for 2FA requirement
      if (
        dict.failureType === '' &&
        !code &&
        dict.customerMessage === 'MZFinance.BadLogin.Configurator_message'
      ) {
        log.info('two-factor verification required', { host: requestHost });
        throw new AuthenticationError(
          i18n.t('errors.auth.requiresVerification'),
          true,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        log.error('response carried no accountInfo', {
          host: requestHost,
          status: response.status,
          failureType: dict.failureType,
          customerMessage: failureMessage,
        });
        throw new Error(
          failureMessage ?? i18n.t('errors.auth.missingAccountInfo'),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        throw new Error(failureMessage ?? i18n.t('errors.auth.missingAddress'));
      }

      const account: Account = {
        email,
        password,
        appleId: (accountInfo.appleId as string) ?? '',
        store: storeFront,
        storeFront: storeFrontHeader || undefined,
        firstName: (address.firstName as string) ?? '',
        lastName: (address.lastName as string) ?? '',
        passwordToken: (dict.passwordToken as string) ?? '',
        directoryServicesIdentifier: String(dict.dsPersonId ?? ''),
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      log.info('authentication succeeded', {
        host: requestHost,
        storeFront,
        storeFrontHeader,
        pod,
        attempts: currentAttempt,
        redirects: redirectAttempt,
      });
      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      // Nothing in an edge-synthesized response changes on a retry.
      if (e instanceof AuthEndpointError) {
        log.error('authentication refused without a usable response', {
          host: requestHost,
          status: e.status,
          attempt: currentAttempt,
          podHost: podHost || undefined,
        });
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn('authentication attempt failed', {
        host: requestHost,
        attempt: currentAttempt,
        redirectAttempt,
        error: lastError,
      });
    }
  }

  log.error('authentication gave up', {
    host: requestHost,
    attempts: currentAttempt,
    redirects: redirectAttempt,
    error: lastError,
  });
  throw lastError ?? new Error(i18n.t('errors.auth.unknownReason'));
}
