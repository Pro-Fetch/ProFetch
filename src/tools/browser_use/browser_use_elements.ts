import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import {
  readWords,
  refresh,
  requireSession,
  SessionError,
  type BrowserUseSession,
} from '../../core/browser-use-session.js';
import {
  elementLine,
  elementRows,
  selectNodes,
  summarizeRows,
  type ElementFilter,
  type ElementSpace,
} from '../../core/browser-use-elements.js';
import { MAX_WORDS } from '../../core/browser-use-words.js';
import { parseRect } from './_shared.js';
import { optionalStr, bool, num } from '../../core/input.js';

/** Keep the body under the block renderer's own cut, so the caller is never handed truncated JSON. */
const MAX_BODY_CHARS = 26_000;

/**
 * pro_browser_use_elements — Every element and its coordinates
 * Pack: browser_use (pro-fetch)
 *
 * The listing the outline is not: geometry for everything the read reached, interactable or not, with the
 * three identifiers the action layer needs on every row.
 */
export default defineTool({
  name: 'pro_browser_use_elements',
  description:
    'List every element in the session with its box, centre point, depth and identifiers (identity, node id, lifetime token) in a chosen coordinate space. Filters: all / visible / interactable / interactive / text, tag, role, name, region, depth, minimum area. This is the tool for "what is at these coordinates" and "give me the box of every element"; the outline stays the tool for choosing what to click.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      filter: {
        type: 'string',
        enum: ['all', 'visible', 'interactable', 'interactive', 'text'],
        description: 'Which elements to list (default visible)',
      },
      space: {
        type: 'string',
        enum: ['css-viewport', 'css-page', 'image-viewport-device', 'image-page-device'],
        description:
          'Coordinate space for the boxes. css-viewport (default) is what the collector and a click use; css-page is the document from its top; the image spaces are screenshot pixels — use the one whose capture you are holding (viewport shot vs full-page shot)',
      },
      tag: { type: 'string', description: 'Only this tag, e.g. button' },
      role: { type: 'string', description: 'Only this computed role, e.g. link' },
      name_contains: { type: 'string', description: 'Name, text or value must contain this (case-insensitive)' },
      frame_id: { type: 'string', description: 'Limit to one frame (default: every frame the read reached)' },
      region: { type: 'string', description: 'JSON {x,y,width,height}: only boxes overlapping it, in css-viewport px' },
      min_depth: { type: 'number', description: 'Skip ancestors shallower than this' },
      max_depth: { type: 'number', description: 'Skip descendants deeper than this' },
      min_area: { type: 'number', description: 'Skip boxes smaller than this many CSS px²' },
      limit: { type: 'number', description: 'Rows to return (default 300, 0 for as many as fit)' },
      offset: { type: 'number', description: 'Skip this many matched rows first' },
      budget: {
        type: 'number',
        description:
          'Re-read the page keeping up to this many nodes first (0 = use last read). This also lifts the in-page element ceiling, which is how a listing of every element on a large page becomes possible',
      },
      with_words: { type: 'boolean', description: 'Count the words measured inside each element (extra page read)' },
      lines: { type: 'boolean', description: 'Return a compact text listing instead of JSON rows' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const budget = num(input, 'budget', 0, 0);
      let snapshot = session.model.latest;
      let reread = false;
      if (budget > 0) {
        const result = await refresh(session, { budget });
        snapshot = result.snapshot;
        reread = true;
      }
      const filter = (optionalStr(input, 'filter') ?? 'visible') as ElementFilter;
      const space = (optionalStr(input, 'space') ?? 'css-viewport') as ElementSpace;
      let region: { x: number; y: number; width: number; height: number } | undefined;
      if (input.region !== undefined) {
        const parsed = parseRect(input.region, 'region');
        if (!parsed.ok) return fail(parsed.error!);
        region = parsed.value;
      }
      const matched = selectNodes(snapshot, {
        filter,
        tag: optionalStr(input, 'tag'),
        role: optionalStr(input, 'role'),
        nameIncludes: optionalStr(input, 'name_contains'),
        frameId: optionalStr(input, 'frame_id'),
        region,
        minDepth: input.min_depth === undefined ? undefined : num(input, 'min_depth', 0, 0),
        maxDepth: input.max_depth === undefined ? undefined : num(input, 'max_depth', 0, 0),
        minArea: input.min_area === undefined ? undefined : num(input, 'min_area', 0, 0),
      });
      const wanted = bool(input, 'with_words');
      // The word pass gets the same generosity as the element walk: a caller asking for 4000 nodes is asking
      // for a full listing, and counting words out of a 4000-word slice of a 12000-word page would make every
      // element below the cut report zero words as if that were a fact about the page.
      const words = wanted
        ? await countWords(session, Math.max(MAX_WORDS, Math.floor(budget)))
        : { counts: new Map<string, number>(), failure: '', capped: false };
      const all = elementRows(matched, snapshot, { space }).map((row) =>
        wanted ? { ...row, words: words.counts.get(row.backend_id) ?? 0 } : row,
      );
      const offset = num(input, 'offset', 0, 0);
      const limit = num(input, 'limit', 300, 0);
      const windowed = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset);
      const stats = summarizeRows(all, filter);
      if (bool(input, 'lines')) {
        const text = windowed.map(elementLine).join('\n');
        return jsonBlock(`${all.length} element(s) matched`, {
          ok: true,
          listing: text.slice(0, MAX_BODY_CHARS),
          stats,
          word_pass: wanted ? { counted: words.counts.size, failure: words.failure || 'none' } : { ran: false },
          returned: windowed.length,
          offset,
          truncated: text.length > MAX_BODY_CHARS || offset + windowed.length < all.length,
          note: reread
            ? `boxes are ${space} pixels from a fresh read (budget ${budget}); #n matches the number an annotation draws only when the same filter is used there`
            : `boxes are ${space} pixels from the last read${snapshot.truncated ? `; that read dropped ${snapshot.truncated} node(s) to its ${snapshot.budget} node budget — pass budget to see more` : ''}`,
        });
      }
      // Add rows until the serialized body would hit the renderer's own cut. Doing this per row, not by
      // truncating a finished string, is what keeps the JSON parseable: cutting at 30k characters leaves a
      // half-written array, and a caller cannot tell a long answer from a broken one.
      const rows: unknown[] = [];
      let used = 0;
      for (const row of windowed) {
        const size = JSON.stringify(row).length + 2;
        if (used + size > MAX_BODY_CHARS) break;
        used += size;
        rows.push(row);
      }
      return jsonBlock(`${all.length} element(s) matched`, {
        ok: true,
        session_id: session.id,
        model_version: session.model.version,
        document: session.model.documentSignature,
        snapshot_id: snapshot.id,
        read: {
          url: snapshot.url,
          title: snapshot.title,
          viewport: snapshot.viewport,
          scroll: snapshot.scroll,
          reread,
        },
        // The walk's own ceiling, kept separate from `truncated`: a read whose in-page walk stopped early
        // can still report no budget loss at all, which is true of the budget and false of the page.
        walk: snapshot.walk ?? { scanned: snapshot.nodes.length, reported: snapshot.nodes.length, capped: false },
        ...(wanted ? { words_capped: words.capped } : {}),
        space,
        filter,
        stats,
        returned: rows.length,
        offset,
        omitted_before: offset,
        omitted_by_size: Math.max(0, windowed.length - rows.length),
        snapshot_nodes: snapshot.nodes.length,
        snapshot_truncated: snapshot.truncated,
        rows,
        note: [
          rows.length < all.length
            ? `${all.length - offset - rows.length} matched row(s) are not in this response. Raise offset by ${rows.length} to continue, or narrow with tag/role/region.`
            : 'owns_centre=false means a click at the box centre lands on something else, even when the element is visible.',
          snapshot.walk?.capped
            ? `WARNING: the in-page walk stopped at its element ceiling (${snapshot.walk.reported} reported of ${snapshot.walk.scanned} in the document), so this is not every element. Re-read with a larger budget to lift the ceiling, or narrow with region.`
            : '',
          wanted && words.capped
            ? 'The word pass also stopped at its ceiling, so a `words` count on a late element is a floor, not a fact.'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});

/**
 * Words per element, from the same page the nodes came from.
 *
 * A failed word read is returned as a `failure` string, not as empty counts: "this element holds no text"
 * and "the word pass could not run" are different answers, and a caller choosing between a paragraph and an
 * empty container should not be handed the first for the second reason.
 */
async function countWords(
  session: BrowserUseSession,
  cap = 0,
): Promise<{ counts: Map<string, number>; failure: string; capped: boolean }> {
  const counts = new Map<string, number>();
  let report;
  try {
    report = await readWords(session, { cap });
  } catch (error) {
    return { counts, failure: `the word pass did not run: ${(error as Error).message.slice(0, 160)}`, capped: false };
  }
  for (const word of report.words) {
    if (!word.ownerBackendId) continue;
    counts.set(word.ownerBackendId, (counts.get(word.ownerBackendId) ?? 0) + 1);
  }
  return {
    counts,
    capped: report.truncated > 0,
    failure: report.truncated ? `${report.truncated} word(s) past the cap were not counted` : '',
  };
}
