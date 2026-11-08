/**
 * The network guard for a managed browser-use session.
 *
 * ## The gap this closes
 *
 * `browser-use-session` checks the address it is *asked* to open — `assertSafeUrl` before `goto` — and then
 * Chromium goes and fetches whatever the page asks for: scripts, XHR, websockets, redirects. Those
 * sub-resource addresses were never checked by anything. A page that loads
 * `http://169.254.169.254/latest/meta-data/` from a script tag was, until here, a working way to make this
 * server read a cloud credential from inside the user's browser session.
 *
 * The guarded reader path (`browser-tools.ts`) has had that coverage for a long time, because every request
 * there passes through `createProxyRouteHandler`, which validates the URL and serves the dangerous kinds
 * from this process over a connection pinned to the address that was just validated. The browser-use path
 * launched a persistent context and registered no route at all. Same product, two doors, one of them open.
 *
 * ## What is intercepted and what is not
 *
 * **Navigations are left to Chromium.** They are already validated before `goto`, and proxying them through
 * this process would break the things an interactive session exists to do — downloads, cookie flows, HTTP
 * auth, streaming responses. A guard that quietly disables the tool is not a guard, it is a regression with
 * a security label.
 *
 * **Everything else goes through the pinned handler**, which itself lets `image`, `media` and `font` continue
 * after validating their URL (a cross-origin response body of those kinds cannot be read back by page
 * script), and proxies the readable kinds — script, xhr, fetch, websocket handshakes — from this process.
 *
 * ## Switch
 *
 * `PRO_FETCH_BROWSER_USE_NETWORK_GUARD=0` turns it off. That is an operator decision, not a code path an
 * agent can take: the reason a caller cannot ask for the guard per call is the same reason a browser's
 * network policy cannot be asked for per tab.
 */

import type { ProxyRoute } from './pinned-proxy.js';
import { createProxyRouteHandler, type ProxyTarget } from './pinned-proxy.js';
import { assertSafeUrl, assertStableSafeUrl } from './ssrf-guard.js';

/**
 * Is this request one the guard should take over?
 *
 * Exported as a decision rather than inlined, because the interesting claim is testable: a navigation must
 * not be intercepted, anything else must be.
 */
export function shouldInterceptRequest(isNavigation: boolean): boolean {
  return !isNavigation;
}

/**
 * Wrap the pinned handler so navigations fall through to Chromium.
 *
 * The wrapper swallows nothing: a refusal raised by the policy inside the handler reaches Playwright's
 * route as an abort, which is what the reader path already does.
 */
export function withNavigationBypass(
  inner: (route: ProxyRoute) => Promise<void>,
): (route: ProxyRoute) => Promise<void> {
  return async (route: ProxyRoute): Promise<void> => {
    const request = route.request();
    if (shouldInterceptRequest(request.isNavigationRequest())) {
      await inner(route);
      return;
    }
    await route.continue();
  };
}

/**
 * Attach the guard to a persistent context.
 *
 * Returns whether it attached. A context that refuses the registration (an engine without routing, or a
 * browser that died mid-launch) is reported rather than assumed, because a session that believes it is
 * guarded and is not is worse than one that says it is not.
 */
export async function attachNetworkGuard(context: {
  route: (pattern: string, handler: (route: ProxyRoute) => Promise<void>) => Promise<void>;
}): Promise<{ ok: boolean; reason: string }> {
  if ((process.env.PRO_FETCH_BROWSER_USE_NETWORK_GUARD ?? '').trim().toLowerCase() === '0') {
    return { ok: false, reason: 'PRO_FETCH_BROWSER_USE_NETWORK_GUARD=0 — operator turned the guard off' };
  }
  try {
    const target = context as unknown as ProxyTarget;
    const handler = withNavigationBypass(
      createProxyRouteHandler(target, {
        validate: async (url: string) => {
          await assertSafeUrl(url);
        },
        validateNavigation: async (url: string) => {
          await assertStableSafeUrl(url);
        },
      }),
    );
    await context.route('**/*', handler as never);
    return { ok: true, reason: 'sub-resource requests are validated and pinned; navigations are left to Chromium' };
  } catch (error) {
    return {
      ok: false,
      reason: 'network guard could not be attached: ' + (error instanceof Error ? error.message : String(error)),
    };
  }
}
