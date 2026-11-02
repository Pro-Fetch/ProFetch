/**
 * Object intelligence: grouping related elements into the things a person would name.
 *
 * A page is not a flat list of buttons. It is a product card with an image, a title, a price and a
 * buy button; a search panel; a login form; a navigation group. A model that is handed 400 unrelated
 * elements spends its context rediscovering structure, and a model that is handed "card 3 of 12,
 * price 24.99, in stock" spends it deciding.
 *
 * Two constraints shape the implementation. The brief forbids hardcoding shopping sites, so nothing
 * here knows what Amazon looks like: grouping is structural — repeated siblings, a container that owns
 * both text and controls, an ARIA role that already declares intent. And the brief forbids confident
 * nonsense, so a group with no evidence is `unknown` with a zero confidence rather than being labelled
 * to fill a slot. A wrong label is worse than no label, because a model trusts a label.
 */

import type { PerceivedNode, Snapshot } from './browser-use-perception.js';

export type ObjectKind = 'list' | 'card' | 'form' | 'navigation' | 'table' | 'dialog' | 'media' | 'toolbar' | 'unknown';

export interface ObjectMember {
  identity: string;
  role: string;
  name: string;
  /** What made this element belong to the group, in one clause. */
  why: string;
}

export interface PageObject {
  /** Structural id of the container element. */
  container: string;
  kind: ObjectKind;
  confidence: number;
  members: ObjectMember[];
  /** Repeated children of the container, when the group is a list of like items. */
  repeated: number;
  /** Each signal that fired, so a reader can disagree with the conclusion. */
  evidence: string[];
  /** Text extracted from the container, capped: this is a summary, not a dump. */
  label: string;
}

const CONTAINER_ROLES: Record<string, ObjectKind> = {
  navigation: 'navigation',
  menubar: 'navigation',
  tablist: 'navigation',
  dialog: 'dialog',
  alertdialog: 'dialog',
  form: 'form',
  searchbox: 'form',
  table: 'table',
  grid: 'table',
  toolbar: 'toolbar',
  list: 'list',
  listbox: 'list',
  article: 'card',
  region: 'card',
  figure: 'media',
  img: 'media',
};

const CONTROL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);

/** A cheap structural signature: what a child *is*, ignoring which one it is. */
function signature(node: PerceivedNode, byIdentity: Map<string, PerceivedNode>): string {
  const kids = [...byIdentity.values()].filter((n) => n.path.startsWith(node.path + '>') && n.depth === node.depth + 1);
  const shape = kids
    .slice(0, 8)
    .map((k) => k.tag)
    .join('+');
  return `${node.tag}[${shape}]`;
}

function directChildren(node: PerceivedNode, nodes: PerceivedNode[]): PerceivedNode[] {
  return nodes.filter((n) => n.depth === node.depth + 1 && n.path.startsWith(node.path + '>'));
}

function hasPriceLikeText(text: string): boolean {
  return /(?:^|[\s(])[$€£¥₠]\s?\d|(?:^|[\s(])\d+(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|JPY|so'm|sum)\b/i.test(text);
}

/**
 * Classify one container. Returns `null` when there is genuinely nothing to say, which the caller
 * turns into "not a group" rather than into a low-confidence guess.
 */
function classify(
  container: PerceivedNode,
  nodes: PerceivedNode[],
  byIdentity: Map<string, PerceivedNode>,
): PageObject | null {
  const evidence: string[] = [];
  const kids = directChildren(container, nodes);
  const descendants = nodes.filter((n) => n.path.startsWith(container.path + '>') && n !== container);
  if (descendants.length < 2 && !CONTAINER_ROLES[container.role]) return null;

  const roleKind = CONTAINER_ROLES[container.role];
  let kind: ObjectKind = roleKind ?? 'unknown';
  if (roleKind) evidence.push(`ARIA role "${container.role}" declares ${roleKind}`);

  // Repeated siblings are the strongest structural signal available without knowing the site.
  const signatures = new Map<string, number>();
  for (const child of kids) {
    const key = signature(child, byIdentity);
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  const repeated = Math.max(0, ...[...signatures.values(), 0]);
  if (repeated >= 3) {
    evidence.push(`${repeated} structurally identical children`);
    if (kind === 'unknown') kind = 'list';
  }

  const controls = descendants.filter((n) => CONTROL_TAGS.has(n.tag) || n.interactive);
  const texts = descendants.filter((n) => n.text.length > 0);
  const allText = texts.map((n) => n.text).join(' ');

  if (container.tag === 'form' || descendants.some((n) => n.tag === 'form')) {
    kind = 'form';
    evidence.push('a form element is present');
  } else if (
    controls.some((n) => n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') &&
    controls.length >= 2
  ) {
    evidence.push(`${controls.length} field-like controls`);
    if (kind === 'unknown') kind = 'form';
  }

  if (container.tag === 'nav' || (kind === 'navigation' && controls.length >= 2)) {
    kind = 'navigation';
    evidence.push('links grouped under a navigation container');
  }

  if (container.tag === 'table' || descendants.some((n) => n.tag === 'tr')) {
    kind = 'table';
    evidence.push('table rows present');
  }

  if (kind === 'unknown' && repeated >= 3 && hasPriceLikeText(allText) && controls.length >= repeated) {
    // A repeated structure that carries prices and its own control is a card list. This is the only
    // place a content signal is used, it is deliberately narrow, and it is recorded as evidence so a
    // reader can see why the label was chosen.
    kind = 'list';
    evidence.push('repeated items carrying price-like text and their own control');
  }

  if (kind === 'unknown' && descendants.some((n) => n.tag === 'img') && texts.length >= 1 && controls.length >= 1) {
    kind = 'card';
    evidence.push('image, text and a control under one container');
  }

  if (kind === 'unknown') return null;

  const confidence = Math.min(
    0.95,
    0.3 +
      (roleKind ? 0.3 : 0) +
      (repeated >= 3 ? 0.2 : 0) +
      (controls.length ? 0.1 : 0) +
      (evidence.length > 2 ? 0.1 : 0),
  );

  return {
    container: container.identity,
    kind,
    confidence,
    members: descendants
      .filter((n) => n !== container)
      .slice(0, 40)
      .map((n) => ({
        identity: n.identity,
        role: n.role || n.tag,
        name: (n.name || n.text).slice(0, 80),
        why: n.interactable ? 'interactable member' : n.tag === 'img' ? 'image member' : 'text member',
      })),
    repeated,
    evidence,
    label: (container.name || texts[0]?.text || container.tag).slice(0, 100),
  };
}

/**
 * Find the objects on a page.
 *
 * Containers are considered outermost-first and a subtree claimed by a group is not re-scanned, so a
 * card inside a list is reported once, under the list, rather than as two competing answers.
 */
export function groupObjects(snapshot: Snapshot): PageObject[] {
  const byIdentity = new Map(snapshot.nodes.map((n) => [n.identity, n]));
  const candidates = snapshot.nodes
    .filter((n) => n.depth > 0)
    .sort((a, b) => a.depth - b.depth || b.path.length - a.path.length);

  const claimed = new Set<string>();
  const objects: PageObject[] = [];
  for (const container of candidates) {
    if (claimed.has(container.identity)) continue;
    const found = classify(container, snapshot.nodes, byIdentity);
    if (!found) continue;
    objects.push(found);
    claimed.add(container.identity);
    for (const member of found.members) claimed.add(member.identity);
  }
  return objects.sort((a, b) => b.confidence - a.confidence || b.members.length - a.members.length);
}

/** Objects that contain a given element, outermost last: what a control belongs to. */
export function objectsContaining(objects: PageObject[], identity: string): PageObject[] {
  return objects.filter((o) => o.members.some((m) => m.identity === identity) || o.container === identity);
}
