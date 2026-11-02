import { describe, it, expect } from 'vitest';
import { groupObjects, objectsContaining } from '../src/core/browser-use-objects.js';
import { buildSnapshot, type RawNode } from '../src/core/browser-use-perception.js';

/**
 * Grouping is inference, and inference is where a system starts agreeing with itself. These fixtures
 * are synthetic DOMs, so the tests ask the narrow question: does the label follow from structure that
 * is actually there, and does the module stay silent when it is not?
 */

const base = {
  snapshotId: 's',
  url: 'https://fixture.test/',
  title: 'fixture',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  scroll: { x: 0, y: 0 },
  capturedAt: 1,
};

let seq = 0;
function node(path: string, tag: string, over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: 'b' + ++seq,
    token: 't' + seq,
    frameId: 'main',
    path,
    tag,
    // Mirrors the implicit-role map the collector applies in the page. A fixture that skips it is
    // testing a page no browser would ever report.
    role:
      over.role ??
      {
        a: 'link',
        button: 'button',
        input: 'textbox',
        img: 'img',
        h3: 'heading',
        ul: 'list',
        li: 'listitem',
        nav: 'navigation',
      }[tag] ??
      '',
    name: over.name ?? '',
    text: over.text ?? '',
    rect: { x: 0, y: 0, width: 100, height: 20 },
    inViewport: true,
    styleVisible: true,
    hitTestSelf: true,
    obstructed: false,
    depth: path.split('>').length - 1,
    interactive: ['a', 'button', 'input', 'select', 'textarea'].includes(tag),
    boundaries: [],
    ...over,
  };
}

function tree(prefix: string, items: Array<{ title: string; price: string }>): RawNode[] {
  const out: RawNode[] = [node('html>body>ul', 'ul', { role: 'list' })];
  items.forEach((item, i) => {
    const li = `${prefix}>li[${i + 1}]`;
    out.push(node(li, 'li'));
    out.push(node(li + '>img', 'img', { text: item.title }));
    out.push(node(li + '>h3', 'h3', { text: item.title }));
    out.push(node(li + '>span', 'span', { text: item.price }));
    out.push(node(li + '>button', 'button', { name: 'Add ' + item.title }));
  });
  return out;
}

describe('grouping', () => {
  it('finds a repeated list without knowing what the site is', () => {
    const snapshot = buildSnapshot(
      tree('html>body>ul', [
        { title: 'A', price: '$10.00' },
        { title: 'B', price: '$20.00' },
        { title: 'C', price: '$30.00' },
      ]),
      base,
    );
    const objects = groupObjects(snapshot);
    const list = objects.find((o) => o.kind === 'list');
    expect(list, JSON.stringify(objects)).toBeDefined();
    expect(list!.repeated).toBeGreaterThanOrEqual(3);
    expect(list!.evidence.join(' ')).toMatch(/identical children|ARIA role/);
  });

  it('trusts an ARIA role when one is declared', () => {
    const snapshot = buildSnapshot(
      [
        node('html>body>div', 'div', { role: 'navigation' }),
        node('html>body>div>a[1]', 'a', { name: 'Home' }),
        node('html>body>div>a[2]', 'a', { name: 'Pricing' }),
      ],
      base,
    );
    const nav = groupObjects(snapshot).find((o) => o.kind === 'navigation');
    expect(nav).toBeDefined();
    expect(nav!.evidence.join(' ')).toMatch(/navigation/);
  });

  it('reports a form from its fields, not from a class name', () => {
    const snapshot = buildSnapshot(
      [
        node('html>body>div', 'div'),
        node('html>body>div>input[1]', 'input', { name: 'Email' }),
        node('html>body>div>input[2]', 'input', { name: 'Password' }),
        node('html>body>div>button', 'button', { name: 'Sign in' }),
      ],
      base,
    );
    const form = groupObjects(snapshot).find((o) => o.kind === 'form');
    expect(form).toBeDefined();
    expect(form!.members.length).toBeGreaterThanOrEqual(2);
  });

  it('stays silent when there is nothing to group', () => {
    const snapshot = buildSnapshot([node('html>body>p', 'p', { text: 'A sentence with no structure at all.' })], base);
    expect(groupObjects(snapshot)).toEqual([]);
  });

  it('does not call a repeated pair a list on structure alone', () => {
    // A `ul` is a list because it says so — that case is covered above. Here the container becomes a
    // bare `div`, so the only evidence left is two similar children. That is a pair, not a list, and
    // the threshold is the difference between a label a model can act on and a guess it will trust.
    const pair = tree('html>body>ul', [
      { title: 'A', price: '$1' },
      { title: 'B', price: '$2' },
    ]).map((n) => (n.tag === 'ul' ? { ...n, tag: 'div', role: '' } : n));
    const snapshot = buildSnapshot(pair, base);
    const list = groupObjects(snapshot).find((o) => o.kind === 'list');
    expect(list).toBeUndefined();
  });

  it('claims a subtree once, so a card is not also reported as its own list', () => {
    const snapshot = buildSnapshot(
      tree('html>body>ul', [
        { title: 'A', price: '$10.00' },
        { title: 'B', price: '$20.00' },
        { title: 'C', price: '$30.00' },
      ]),
      base,
    );
    const objects = groupObjects(snapshot);
    const containers = objects.map((o) => o.container);
    expect(new Set(containers).size).toBe(containers.length);
  });

  it('answers which objects an element belongs to', () => {
    const snapshot = buildSnapshot(
      tree('html>body>ul', [
        { title: 'A', price: '$10.00' },
        { title: 'B', price: '$20.00' },
        { title: 'C', price: '$30.00' },
      ]),
      base,
    );
    const objects = groupObjects(snapshot);
    const button = snapshot.nodes.find((n) => n.role === 'button');
    expect(button).toBeDefined();
    const owners = objectsContaining(objects, button!.identity);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners[0].members.some((m) => m.identity === button!.identity)).toBe(true);
  });

  it('never reports a confidence it cannot support', () => {
    const snapshot = buildSnapshot(
      tree('html>body>ul', [
        { title: 'A', price: '$10.00' },
        { title: 'B', price: '$20.00' },
        { title: 'C', price: '$30.00' },
      ]),
      base,
    );
    for (const o of groupObjects(snapshot)) {
      expect(o.confidence).toBeGreaterThan(0);
      expect(o.confidence).toBeLessThanOrEqual(0.95);
      expect(o.evidence.length, o.kind).toBeGreaterThan(0);
    }
  });
});
