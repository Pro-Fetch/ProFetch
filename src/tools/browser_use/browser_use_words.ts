import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { readWords, requireSession, SessionError } from '../../core/browser-use-session.js';
import {
  buildWordRows,
  findPhrase,
  summarizeWords,
  textOfWords,
  wordsInRect,
  MAX_WORDS,
} from '../../core/browser-use-words.js';
import { placeRect } from '../../core/browser-use-elements.js';
import type { ElementSpace } from '../../core/browser-use-elements.js';
import type { Rect } from '../../core/browser-use-perception.js';
import { parseRect } from './_shared.js';
import { optionalStr, bool, num } from '../../core/input.js';

/** Serialized-row ceiling, kept under the block renderer's own cut so the JSON stays parseable. */
const MAX_BODY_CHARS = 26_000;

/**
 * pro_browser_use_words — The coordinates of every word, and the box around a phrase
 * Pack: browser_use (pro-fetch)
 *
 * Element boxes answer "where is the button". They cannot answer "where is the sentence", because a
 * paragraph is one box around many sentences. This measures the text itself.
 */
export default defineTool({
  name: 'pro_browser_use_words',
  description:
    'Measure every visible word on the page the session has open and return its box, centre and owning element, in a chosen coordinate space. With `phrase` it finds that exact sequence of words and returns the rectangle around it (how many times it occurs, and whether it wraps a line); with `region` it returns the words inside a box and their transcript. This is what makes a screenshot addressable by text.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      phrase: { type: 'string', description: 'Find this exact sequence of words and return its box' },
      region: { type: 'string', description: 'JSON {x,y,width,height}: only words overlapping it (css-viewport px)' },
      space: {
        type: 'string',
        enum: ['css-viewport', 'css-page', 'image-viewport-device', 'image-page-device'],
        description: 'Coordinate space for the boxes (default css-viewport)',
      },
      only_viewport: { type: 'boolean', description: 'Skip words outside the viewport that was read' },
      owner: { type: 'string', description: 'Only words whose owning element has this node id, e.g. pf-42' },
      limit: { type: 'number', description: 'Rows to return (default 200, 0 for as many as fit)' },
      offset: { type: 'number', description: 'Skip this many matched words first' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const snapshot = session.model.latest;
      const report = await readWords(session);
      const space = (optionalStr(input, 'space') ?? 'css-viewport') as ElementSpace;
      // Measured and filtered in the collector's own space, then converted once at the end. Region
      // arguments are documented as css-viewport pixels, and a filter that ran after a space change would
      // compare a css box against device pixels and silently match the wrong words.
      const rows = buildWordRows(report, snapshot.nodes);
      const place = (rect: Rect): Rect => placeRect(rect, space, snapshot);
      const phrase = optionalStr(input, 'phrase');
      if (phrase) {
        const hit = findPhrase(rows, phrase);
        if (!hit) {
          return jsonBlock('phrase not found', {
            ok: false,
            phrase,
            measured: rows.length,
            note: `the exact sequence is not among the ${rows.length} measured word(s). Words are matched as the document holds them: punctuation stays attached, and a hyphenated line break is two words.`,
            truncated: report.truncated,
          });
        }
        const rect = place(hit.rect);
        return jsonBlock(`"${hit.phrase}" occupies one box`, {
          ok: true,
          phrase: hit.phrase,
          space,
          rect,
          centre: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          fragments: hit.fragments.map(place),
          wrapped: hit.wrapped,
          words: `#${hit.from}…#${hit.to}`,
          occurrences: hit.occurrences,
          model_version: session.model.version,
          note:
            hit.occurrences > 1
              ? `${hit.occurrences} occurrence(s) on the page — this is the first in document order.`
              : '',
        });
      }
      let region: Rect | undefined;
      if (input.region !== undefined) {
        const parsed = parseRect(input.region, 'region');
        if (!parsed.ok) return fail(parsed.error!);
        region = parsed.value;
      }
      const ownerId = optionalStr(input, 'owner');
      let pool = rows;
      if (region) pool = wordsInRect(pool, region);
      if (bool(input, 'only_viewport')) pool = pool.filter((row) => row.in_viewport);
      if (ownerId) pool = pool.filter((row) => row.owner_backend_id === ownerId);
      const summary = summarizeWords(pool);
      const offset = num(input, 'offset', 0, 0);
      const limit = num(input, 'limit', 200, 0);
      const windowed = limit > 0 ? pool.slice(offset, offset + limit) : pool.slice(offset);
      const out: unknown[] = [];
      let used = 0;
      for (const row of windowed) {
        const rect = place(row.rect);
        const entry = {
          ...row,
          rect,
          centre: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          space,
          line_boxes: row.parts > 1 ? row.fragments.map(place) : undefined,
          fragments: undefined,
        };
        const size = JSON.stringify(entry).length + 2;
        if (used + size > MAX_BODY_CHARS) break;
        used += size;
        out.push(entry);
      }
      return jsonBlock(`${pool.length} word(s) measured`, {
        ok: true,
        session_id: session.id,
        model_version: session.model.version,
        space,
        summary,
        transcript: textOfWords(pool.slice(offset, offset + out.length)),
        returned: out.length,
        offset,
        omitted: Math.max(0, pool.length - offset - out.length),
        read: {
          truncated_words: report.truncated,
          unmeasured: report.unmeasured,
          errored: report.errored,
          cap: MAX_WORDS,
        },
        frames_skipped: report.frames_skipped,
        note:
          out.length < pool.length - offset
            ? `${pool.length - offset - out.length} word(s) did not fit this response — raise offset by ${out.length} to continue, or narrow with region/owner.`
            : region
              ? 'wordsInRect keeps any word whose box overlaps the region, so a word clipped by the border is still listed.'
              : 'A word that wraps across lines has `parts` > 1: its rect is the union and the true boxes are the fragments.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
