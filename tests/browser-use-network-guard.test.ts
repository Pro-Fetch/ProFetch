/**
 * The sub-resource guard for managed browser-use sessions.
 *
 * The interesting case is not the happy path, it is the one the tool used to allow: a page whose script
 * asks for a link-local address, which is how a cloud credential walks out of a session that was only ever
 * told to open a public URL. These cases run offline against a fake route — no browser, no network — so the
 * decision is what is tested, not the machine's ability to reach a host.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  attachNetworkGuard,
  shouldInterceptRequest,
  withNavigationBypass,
} from '../src/core/browser-use-network-guard.js';
import type { ProxyRoute } from '../src/core/pinned-proxy.js';

interface RouteCall {
  route: ProxyRoute;
  calls: string[];
}

function fakeRoute(input: { url: string; isNavigation: boolean; resourceType?: string }): RouteCall {
  const calls: string[] = [];
  const route = {
    request: () => ({
      url: () => input.url,
      method: () => 'GET',
      headers: () => ({}),
      postData: () => null,
      resourceType: () => input.resourceType ?? 'script',
      isNavigationRequest: () => input.isNavigation,
      frame: () => ({}),
    }),
    continue: async () => {
      calls.push('continue');
    },
    abort: async () => {
      calls.push('abort');
    },
    fulfill: async () => {
      calls.push('fulfill');
    },
  } as unknown as ProxyRoute;
  return { route, calls };
}

/** A context that records the handler Playwright was given, so the decision can be replayed. */
function fakeContext() {
  const registered: Array<{ pattern: string; handler: (route: ProxyRoute) => Promise<void> }> = [];
  const context = {
    route: async (pattern: string, handler: (route: ProxyRoute) => Promise<void>) => {
      registered.push({ pattern, handler });
    },
    addCookies: async () => {},
    mainFrame: () => ({}),
  };
  return { context, registered };
}

afterEach(() => {
  delete process.env.PRO_FETCH_BROWSER_USE_NETWORK_GUARD;
});

describe('the interception rule', () => {
  it('leaves navigations to Chromium and takes everything else', () => {
    expect(shouldInterceptRequest(true)).toBe(false);
    expect(shouldInterceptRequest(false)).toBe(true);
  });

  it('hands a navigation straight through without consulting the policy', async () => {
    const inner: string[] = [];
    const guard = withNavigationBypass(async () => {
      inner.push('ran');
    });
    const navigation = fakeRoute({ url: 'https://example.org/page', isNavigation: true, resourceType: 'document' });
    await guard(navigation.route);
    expect(navigation.calls).toEqual(['continue']);
    expect(inner).toEqual([]);
  });

  it('passes a sub-resource to the pinned handler', async () => {
    const inner: string[] = [];
    const guard = withNavigationBypass(async () => {
      inner.push('ran');
    });
    const sub = fakeRoute({ url: 'https://example.org/app.js', isNavigation: false });
    await guard(sub.route);
    expect(inner).toEqual(['ran']);
    expect(sub.calls).toEqual([]);
  });
});

describe('attaching the guard to a session', () => {
  it('registers one route for every address and reports that it attached', async () => {
    const { context, registered } = fakeContext();
    const attached = await attachNetworkGuard(context as never);
    expect(attached.ok).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0].pattern).toBe('**/*');
  });

  it('says so when the operator switched it off, instead of pretending the session is guarded', async () => {
    process.env.PRO_FETCH_BROWSER_USE_NETWORK_GUARD = '0';
    const { context, registered } = fakeContext();
    const attached = await attachNetworkGuard(context as never);
    expect(attached.ok).toBe(false);
    expect(attached.reason).toContain('PRO_FETCH_BROWSER_USE_NETWORK_GUARD=0');
    expect(registered).toHaveLength(0);
  });

  it('refuses to report success when the context will not take a route', async () => {
    const broken = {
      route: async () => {
        throw new Error('routing is not supported by this engine');
      },
      addCookies: async () => {},
      mainFrame: () => ({}),
    };
    const attached = await attachNetworkGuard(broken as never);
    expect(attached.ok).toBe(false);
    expect(attached.reason).toContain('could not be attached');
  });
});

describe('what the attached guard actually decides', () => {
  it('does not let a page script reach the cloud metadata address', async () => {
    const { context, registered } = fakeContext();
    await attachNetworkGuard(context as never);
    const handler = registered[0].handler;
    const attempt = fakeRoute({ url: 'http://169.254.169.254/latest/meta-data/iam', isNavigation: false });
    await handler(attempt.route);
    // The point of the whole file: nothing is handed to Chromium, and nothing is fetched.
    expect(attempt.calls).toEqual(['abort']);
  });

  it('does not let a sub-resource point at a loopback port either', async () => {
    const { context, registered } = fakeContext();
    await attachNetworkGuard(context as never);
    const handler = registered[0].handler;
    const attempt = fakeRoute({ url: 'http://127.0.0.1:6379/', isNavigation: false, resourceType: 'xhr' });
    await handler(attempt.route);
    expect(attempt.calls).toEqual(['abort']);
  });

  it('lets a data: request through, because there is no host to reach', async () => {
    const { context, registered } = fakeContext();
    await attachNetworkGuard(context as never);
    const handler = registered[0].handler;
    const inline = fakeRoute({ url: 'data:image/png;base64,AAAA', isNavigation: false, resourceType: 'image' });
    await handler(inline.route);
    expect(inline.calls).toEqual(['continue']);
  });
});
