import { jsonBlock, fail } from '../../core/format.js';
import { defineTool } from '../../core/tool.js';
import { view } from '../../core/input.js';
import { sourceFrom } from '../../core/source-from.js';

/**
 * pro_fetch_json_path — read one path out of a JSON document.
 * Pack: extract (REAL ✅) (pro-fetch)
 *
 * ## The grammar, stated because the old answer hid it
 *
 * Dotted keys, `[n]` indexes and one `[*]` wildcard: `$.jobs[*].conclusion`. A leading `$` is the JSONPath
 * root marker and is optional. That is the whole language, and it is the language the tool's own name
 * promises — which is why the two failures below were worth fixing rather than working around.
 *
 * 1. **`$.` never resolved.** Every path was split on `.` and walked from the document, so the first
 *    segment was the literal `$`, which no JSON document has. The published example shape — `$.foo.bar` —
 *    therefore answered "Path topilmadi" for a document that contained `foo.bar`. Anyone following the
 *    description's own syntax concluded the data was missing.
 * 2. **A path that stops halfway said the same thing as a key that does not exist.** "Path topilmadi: X"
 *    named the whole path, not the segment that failed, so a caller could not tell "no such field" from
 *    "no such field *inside jobs[3]*" without fetching the document and walking it themselves.
 *
 * A projection (`$.jobs[*].{id,name}`) is deliberately not supported: it is a different tool — one that
 * returns several fields at once. Asking for it now says so and names what is accepted, instead of
 * reporting it as a missing path.
 */

/** One resolved step of a path, or the segment where the walk stopped. */
type Walk = { ok: true; value: unknown } | { ok: false; stopped_at: string };

const UNSUPPORTED = /[{}]/;

function walk(root: unknown, parts: string[]): Walk {
  let current: unknown = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '*') {
      if (!Array.isArray(current)) return { ok: false, stopped_at: `[*] (${typeof current} emas massiv)` };
      const rest = parts.slice(index + 1);
      // A wildcard maps the rest of the path over every element. An element that lacks the field yields
      // null rather than aborting the whole read: the missing entries are the answer's business, and a
      // caller who needs them can count the nulls.
      const mapped = current.map((item) => {
        const step = walk(item, rest);
        return step.ok ? step.value : null;
      });
      return { ok: true, value: mapped };
    }
    if (current === null || typeof current !== 'object') {
      return { ok: false, stopped_at: `${part} (${typeof current} ichida)` };
    }
    const holder = current as Record<string, unknown>;
    if (!(part in holder)) return { ok: false, stopped_at: part };
    current = holder[part];
  }
  return { ok: true, value: current };
}

/** `$.a[0].b[*].c` and `a.0.b.*.c` are the same path. This is the only parser, so there is one grammar. */
function parseSelector(raw: string): string[] {
  return raw
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[\*\]/g, '.*')
    .split('.')
    .filter(Boolean);
}

export default defineTool({
  name: 'pro_fetch_json_path',
  description:
    'Read one path from a JSON document: $.a.b[0].c, with [*] to map over an array. Dotted keys, indexes ' +
    'and the wildcard are the whole grammar; a path that stops halfway names the segment that stopped it.',
  category: 'extract',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Oldindan yuklangan HTML/matn. Berilsa, tarmoq so‘rovi qilinmaydi' },
      url: { type: 'string', description: 'Manzil (URL)' },
      selector: {
        type: 'string',
        description:
          'JSONPath yo‘li: $.ichidagi.nomi[0].boshqa yoki $.massiv[*].ustun. Boshidagi $ ixtiyoriy. ' +
          'Fafaq nuqta, indeks va [*] — {a,b} ko‘rinishidagi subselektsiya qo‘llab-quvvatlanmaydi.',
      },
    },
    required: [],
  },
  async handler(input) {
    const p = view(input);
    const selector = String(p.selector ?? '').trim();
    if (!selector) {
      return fail('selector kerak — masalan "$.jobs[*].conclusion" yoki "result.items[0].id".');
    }
    if (UNSUPPORTED.test(selector)) {
      return fail(
        `selector qo‘llab-quvvatlanmaydi: "${selector}". Bu yerda butun JSONPath emas, faqat nuqtali yo‘l,` +
          ` indekslar va bitta [*] wildcard ishlayi (masalan $.jobs[*].conclusion). Bir nechta maydonni` +
          ` birga so‘rash ({a,b}) bu tool’ning grammatikasi emas — bitta yo‘lni so‘rang.`,
      );
    }
    const parts = parseSelector(selector);
    if (parts.length === 0) return fail(`selector bo‘sh: "${selector}" hech qanday maydonni anglatmaydi.`);

    const fr = await sourceFrom(p);
    let document: unknown;
    try {
      document = JSON.parse(fr.text);
    } catch {
      return fail('Javob JSON emas');
    }

    const step = walk(document, parts);
    if (!step.ok) {
      return fail(`Path topilmadi: "${selector}" — "${step.stopped_at}" bo‘limida to‘xtadi.`);
    }
    return jsonBlock('# ' + selector, step.value);
  },
});
