/**
 * The in-page collector: gathers the raw signals the perception layer merges.
 *
 * It runs *inside* the page, so it is a string, not a module — and it is deliberately conservative
 * about what it claims. Two rules it exists to enforce:
 *
 * 1. **Every node carries a structural path, not just an id.** Elements are stamped with a
 *    `data-pf-id` ordinal so a later call can name the same node, but the *identity* the perception
 *    layer computes comes from the path and the accessible name. That is the difference between "the
 *    node the page points at now" and "the node the model was shown", and it is the failure the
 *    survey found in browser-use.
 * 2. **Hit-testing is done, not assumed.** `document.elementFromPoint` at the box centre is what says
 *    whether a click at those coordinates would reach this element. A visible box under a cookie
 *    banner is visible, and not clickable, and those are different answers.
 *
 * The accessible name is computed the way a screen reader approximates it (aria-label, then
 * aria-labelledby, then content, then the fallback attributes) rather than read from a spec table, and
 * the result says so — a name derived from `alt` text is labelled as such downstream by the source
 * that produced it.
 */

import type { RawNode } from './browser-use-perception.js';

/** The script evaluated in the page. It returns `RawNode[]`. */
export const COLLECTOR_SCRIPT = `(() => {
  const out = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const sx = window.scrollX, sy = window.scrollY;
  const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','DETAILS','OPTION']);
  const IMPLICIT = { A:'link', BUTTON:'button', INPUT:'textbox', SELECT:'combobox', TEXTAREA:'textbox',
                     H1:'heading', H2:'heading', H3:'heading', IMG:'img', NAV:'navigation', MAIN:'main',
                     FORM:'form', SUMMARY:'disclosure-triangle', DETAILS:'group', UL:'list', LI:'listitem' };

  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let name = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(name + '#' + node.id); break; }
      let sibling = 1, prev = node.previousElementSibling;
      while (prev) { if (prev.tagName === node.tagName) sibling++; prev = prev.previousElementSibling; }
      parts.unshift(name + (sibling > 1 ? '[' + sibling + ']' : ''));
      node = node.parentElement;
    }
    return parts.join('>');
  };

  const labelFor = (el) => {
    const direct = el.getAttribute('aria-label');
    if (direct) return { name: direct.trim(), from: 'aria-label' };
    const byId = el.getAttribute('aria-labelledby');
    if (byId) {
      const text = byId.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (text) return { name: text, from: 'aria-labelledby' };
    }
    // Native label association: el.labels covers both <label for=id> and a wrapping <label>, so a
    // correctly labelled field must not arrive nameless because the collector only knew aria attributes.
    const labels = el.labels;
    if (labels && labels.length) {
      const joined = Array.prototype.slice.call(labels).map((l) => (l.textContent || '').trim()).join(' ').replace(/\\s+/g, ' ').trim();
      if (joined) return { name: joined, from: 'label' };
    }
    const content = (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
    if (content) return { name: content, from: 'content' };
    for (const attr of ['alt', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) return { name: value.trim(), from: attr };
    }
    if (el.tagName === 'A' && el.href) return { name: el.href, from: 'href' };
    return { name: '', from: 'none' };
  };

  const roleFor = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    return IMPLICIT[el.tagName] ?? '';
  };

  const boundaries = (el) => {
    const list = [];
    let node = el;
    while (node) {
      const root = node.getRootNode && node.getRootNode();
      if (root && root !== document && root.host) { list.push('shadow:' + root.host.tagName.toLowerCase()); node = root.host; continue; }
      if (node.tagName === 'IFRAME') list.push('frame:' + (node.getAttribute('src') || 'anonymous').slice(0, 60));
      node = node.parentElement;
    }
    return list;
  };

  // A token per DOM node, kept in a WeakMap on the page. Two elements that look identical — same
  // tag, same position, same accessible name — get different tokens, which is the whole point: an
  // element replaced by a re-render is a different element, and neither a position nor a reused
  // traversal ordinal can tell them apart.
  const w = window;
  if (!w.__pfTokens) w.__pfTokens = new WeakMap();
  const tokens = w.__pfTokens;
  let seq = w.__pfSeq || 0;
  const tokenOf = (el) => {
    let value = tokens.get(el);
    if (!value) {
      value = 't' + (++seq);
      tokens.set(el, value);
      w.__pfSeq = seq;
    }
    return value;
  };

  const all = Array.from(document.querySelectorAll('*'));
  let ordinal = 0;
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (['script','style','meta','link','head','html','body','noscript','template','svg','path'].includes(tag)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    // A closed <details> hides its content through the ::details-content pseudo-element, which leaves the
    // children with a real rect and a "visible" computed style while painting nothing. Skipping them here
    // is what makes their appearance after an expansion a discovery rather than a re-read.
    const closedDetails = el.closest ? el.closest('details:not([open])') : null;
    if (closedDetails && el !== closedDetails && !(el.tagName === 'SUMMARY' && el.parentElement === closedDetails)) continue;

    const id = 'pf-' + (++ordinal);
    el.setAttribute('data-pf-id', id);
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const onScreen = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    const hit = onScreen ? document.elementFromPoint(cx, cy) : null;
    const selfOrChild = hit === el || (hit !== null && el.contains(hit));
    const { name, from } = labelFor(el);
    const interactive = INTERACTIVE.has(el.tagName) || el.getAttribute('tabindex') !== null ||
                        el.getAttribute('role') === 'button' || el.isContentEditable === true;
    const scrollable = el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4;

    out.push({
      backendId: id,
      token: tokenOf(el),
      frameId: 'main',
      path: pathOf(el),
      tag,
      role: roleFor(el),
      name: name.slice(0, 200),
      nameFrom: from,
      text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      value: typeof el.value === 'string' ? el.value.slice(0, 200) : undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      href: el.tagName === 'A' ? el.getAttribute('href') ?? undefined : undefined,
      ariaHidden: el.getAttribute('aria-hidden') === 'true',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
      selected: el.selected === true || el.getAttribute('aria-selected') === 'true',
      expanded:
        el.tagName === 'DETAILS'
          ? el.open === true
          : el.hasAttribute('aria-expanded')
            ? el.getAttribute('aria-expanded') === 'true'
            : undefined,
      rect: { x: Math.round(rect.left * 100) / 100, y: Math.round(rect.top * 100) / 100,
              width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 },
      inViewport: onScreen,
      styleVisible: true,
      hitTestSelf: selfOrChild,
      obstructed: onScreen && !selfOrChild,
      scrollable,
      depth: pathOf(el).split('>').length,
      interactive,
      boundaries: boundaries(el),
    });
    if (ordinal >= 1500) break;
  }
  return { nodes: out, viewport: { width: vw, height: vh }, scroll: { x: sx, y: sy },
           deviceScaleFactor: window.devicePixelRatio || 1, title: document.title, url: location.href };
})()`;

/** What the collector returns: the nodes plus the frame context every rect depends on. */
export interface CollectorResult {
  nodes: RawNode[];
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  deviceScaleFactor: number;
  title: string;
  url: string;
  nameFrom?: never;
}
