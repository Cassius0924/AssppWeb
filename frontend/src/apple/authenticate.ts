import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { fetchBag, defaultAuthURL } from './bag';
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

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = '',
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = '';
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

  log.info('authentication started', {
    host: requestHost,
    path: authEndpoint.pathname,
    guid: deviceId,
    withCode: Boolean(code),
    reusingCookies: cookies.length,
    sapRequired: Boolean(bag.sap),
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
          log.error('redirect without a Location header', {
            host: requestHost,
            path: requestPath,
            status: response.status,
            responseHeaders: Object.keys(response.headers),
            attempt: currentAttempt,
            redirectAttempt,
          });
          throw new Error(i18n.t('errors.auth.redirectLocation'));
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
        log.error('empty response body', {
          host: requestHost,
          path: requestPath,
          status: response.status,
          responseHeaders: Object.keys(response.headers),
          signed: Boolean(bag.sap),
          attempt: currentAttempt,
        });
        throw new Error(
          i18n.t('errors.auth.emptyBody', { status: response.status }),
        );
      }

      let dict: Record<string, any>;
      try {
        dict = parsePlist(response.body) as Record<string, any>;
      } catch (parseError) {
        log.error('response was not a plist', {
          host: requestHost,
          path: requestPath,
          status: response.status,
          contentType: response.headers['content-type'],
          bodyBytes: response.body.length,
          signed: Boolean(bag.sap),
          error: parseError,
        });
        throw parseError;
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
        pod,
        attempts: currentAttempt,
        redirects: redirectAttempt,
      });
      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
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
