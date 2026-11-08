/**
 * The rules this server follows when it goes looking at somebody else's site.
 *
 * ## Why these three rules live together
 *
 * The rest of the policy layer answers "may this address be reached at all" (SSRF, private ranges, output
 * sandbox). This file answers a different question, the one a site operator asks: "should you be fetching
 * this, and are you telling me who you are". Both are enforced before the request, and both say what they
 * refused in the answer rather than failing quietly.
 *
 * ## 1. Search-result pages are not documents
 *
 * A search engine's results page is not content someone published to be read: it is a rendered view of that
 * company's index, produced under its terms, and its terms say automated access is not allowed. Scraping one
 * is not "getting search results for free" — it is taking somebody's index through the front door, and it is
 * also the worst source of data in this space: the ordering is personalised, the links are redirect
 * wrappers, and the page changes when they change their UI, so a pipeline built on it breaks without
 * warning.
 *
 * So result pages are refused by name, and the refusal points at the legitimate route: `pro_fetch_web_search`
 * with an engine's own API (23 of them are registered, each labelled with how it is accessed). The *site* is
 * never blocked — `https://sqlite.org/` is a document and is fetched every day.
 *
 * ## 2. A login or paywall is an answer, and it is reported as one
 *
 * When a page redirects to a sign-in form or prints "subscribe to continue", the content was not withheld by
 * us and did not fail to load: the host asked for credentials. Returning the shell as if it were the
 * document is how a pipeline learns facts that are not there. So the shape is recognised and reported as
 * `auth_wall`, with the evidence that triggered it, and no attempt is made to get around it — no
 * credential stuffing, no paywall-bypass services, no rendering tricks.
 *
 * ## 3. The User-Agent says who we are and where to complain
 *
 * `src/core/version.ts` builds it: product, version, and a contact URL. An operator who wants to reach the
 * people behind the traffic sets `PRO_FETCH_USER_AGENT_CONTACT`; the default is this repository.
 */

import type { BlockPage } from './block-page.js';

/** A search-results endpoint: the query is in the URL, and the page is the engine's index, not a document. */
const SERP_RULES: Array<{ host: RegExp; path: RegExp; engine: string }> = [
  { host: /(^|\.)google\.[a-z.]{2,9}$/i, path: /^\/(search|images|news|maps)\b/i, engine: 'Google' },
  { host: /(^|www\.)bing\.com$/i, path: /^\/(search|images|news)\b/i, engine: 'Bing' },
  { host: /(^|www\.)duckduckgo\.com$/i, path: /^\/(html|lite)?\/?\?/i, engine: 'DuckDuckGo' },
  { host: /(^|search\.)brave\.com$/i, path: /^\/search\b/i, engine: 'Brave' },
  { host: /(^|www\.)startpage\.com$/i, path: /^\/sp\/(search|do)\b/i, engine: 'Startpage' },
  { host: /(^|www\.)ecosia\.org$/i, path: /^\/search\b/i, engine: 'Ecosia' },
  { host: /(^|www\.)mojeek\.com$/i, path: /^\/search\b/i, engine: 'Mojeek' },
  { host: /(^|www\.)qwant\.com$/i, path: /^\/\?/i, engine: 'Qwant' },
  { host: /(^|www\.)yandex\.[a-z]{2}$/i, path: /^\/(search|images)\b/i, engine: 'Yandex' },
  { host: /(^|www\.)baidu\.com$/i, path: /^\/s\?/i, engine: 'Baidu' },
  { host: /(^|www\.)seznam\.cz$/i, path: /^\/search\b/i, engine: 'Seznam' },
  { host: /(^|\.)naver\.com$/i, path: /^\/(search|search\.op)\b/i, engine: 'Naver' },
];

/**
 * Refuse a search-results URL, and name the way that is allowed.
 *
 * Returns the engine's own name so the message can say which index was being read through — a caller who
 * sees "blocked" without that has nothing to act on.
 */
export function serpRefusal(rawUrl: string | URL): { engine: string; url: string } | null {
  let url: URL;
  try {
    url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  for (const rule of SERP_RULES) {
    if (rule.host.test(url.hostname) && rule.path.test(url.pathname + url.search)) {
      return { engine: rule.engine, url: url.toString() };
    }
  }
  return null;
}

/** The message the refusal carries: what was refused, why, and the legitimate alternative. */
export function serpRefusalMessage(refusal: { engine: string; url: string }): string {
  return (
    `${refusal.engine} qidiruv natijalari sahifasi o‘qilmaydi: ${refusal.url}\n` +
    'Bu sahifa hujjat emas — u indeksning ko‘rinishi va shu kompaniyaning shartlariga ko‘ra avtomatik ' +
    'yechish taqiqlangan. Qidiruv kerak bo‘lsa: `pro_fetch_web_search` (23 engine reyestri, har birining ' +
    'qanday kirish orqali ishlashi belgilangan) yoki `pro_fetch_search_engines`.\n' +
    'Saytning o‘zi bloklanmagan: https://…/dokument-manzilini o‘qish mumkin.'
  );
}

/**
 * Signs that the host is asking for credentials rather than answering.
 *
 * Deliberately conservative: a redirect chain that lands on a sign-in path, or a short body whose only real
 * content is a login or subscribe prompt. A long article that happens to contain the word "log in" is not a
 * paywall, and calling one one would be the same kind of invention this file exists to prevent.
 */
const AUTH_WALL_PATHS =
  /\/(login|log-in|signin|sign-in|sign_in|account|authenticate|auth|sso|subscribe|paywall|checkout\/subscribe)([/?#]|$)/i;

const AUTH_WALL_MARKERS: Array<{ marker: RegExp; hint: string }> = [
  { marker: /\bsign in to continue\b/i, hint: 'Host hisobga kirishni so‘rayapti — kontent kirishdan keyin.' },
  { marker: /\blog in to view\b/i, hint: 'Host hisobga kirishni so‘rayapti — kontent kirishdan keyin.' },
  {
    marker: /\bsubscribe to (read|continue|access)\b/i,
    hint: 'To‘lov devori: maqola uchun obuna talab qilinayapti. Bu bizning xatolik emas.',
  },
  {
    marker: /\b(start a subscription|create an account to continue)\b/i,
    hint: 'Ro‘yxatdan o‘tish yoki obuna talab qilinayapti.',
  },
];

/**
 * Is this answer a wall rather than a document?
 *
 * `finalUrl` is where the redirects actually landed, `markdown` what the reader extracted, `status` the
 * HTTP code. A wall is reported as a `BlockPage` so every existing refusal path (tool message, batch
 * results, envelope `blocked_kind`) carries it without a second shape.
 */
export function authWallRefusal(input: { finalUrl: string; status: number; markdown: string }): BlockPage | null {
  const words = input.markdown.split(/\s+/).filter((word) => word.length > 1).length;
  let pathHit = false;
  try {
    pathHit = AUTH_WALL_PATHS.test(new URL(input.finalUrl).pathname + new URL(input.finalUrl).search);
  } catch {
    pathHit = false;
  }
  // A redirect into a sign-in page is the strongest signal, and it is only trusted while the body stayed
  // short: a site whose /login route also serves a long help article is not a wall for that article.
  if (pathHit && words < 300 && input.status < 400) {
    return {
      kind: 'auth_wall',
      marker: 'redirect to a sign-in or subscribe path',
      ua_sensitive: false,
      hint:
        'Host kirish (hisobga kirish) yoki obuna talab qilyapti — kontent bu holda biz uchun mavjud emas. ' +
        'Hisob maʼlumotlarini yubormang va devorni aylanib o‘tishga urilmang.',
    };
  }
  // Text markers are trusted only on a short body, for the same reason.
  if (words < 300) {
    for (const entry of AUTH_WALL_MARKERS) {
      if (entry.marker.test(input.markdown)) {
        return {
          kind: 'auth_wall',
          marker: entry.marker.source,
          ua_sensitive: false,
          hint: entry.hint,
        };
      }
    }
  }
  return null;
}
