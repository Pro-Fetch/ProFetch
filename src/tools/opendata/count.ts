import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { parseReference, resolveDataset, sodaTotalRows, soqlIdentifier, sodaRows } from './_opendata.js';

/**
 * Which kind of "nothing" an empty aggregate is, in the caller's language.
 *
 * Kept apart from the handler for one reason: the `datasetRows === null` branch cannot be provoked against a
 * live portal — it needs the portal to disagree with itself between two near-identical queries, which is what
 * a loaded runner did once and what a test must never depend on. A label nobody has been able to read is a
 * claim, so the mapping from measurement to sentence is checked here instead.
 */
export function emptyAggregateNote(measured: {
  datasetRows: number | null;
  where: string;
  groupBy: string;
  domain: string;
  id: string;
}): string {
  const { datasetRows, where, groupBy, domain, id } = measured;
  if (datasetRows === null) {
    return (
      `Portal "${groupBy || 'count(*)'}" so‘rovi uchun hech narsa qaytarmadi va qatorlar sonini ham` +
      ` ayta olmadi (${domain}). Bu "mos qiymat yo‘q" emas — portal javobi to‘liq emas.`
    );
  }
  if (datasetRows === 0) {
    return where
      ? `Shart (“${where}”) hech bir qatorga mos kelmadi: guruhlash bo‘yicha qiymat yo‘q, chunki` +
          ` mos qator yo‘q. Bu portal xatosi emas.`
      : `Datasetda guruhlanadigan qator yo‘q (${domain} o‘zi ham 0 deyapti).`;
  }
  return (
    `${id} da ${datasetRows} qator bor, lekin guruhlash bo‘yicha birorta qiymat` +
    ` qaytmadi. Agregatsiya portal tomonida bajarilmagan — so‘rovni o‘zgartirish kerak emas,` +
    ` keyinroq qayta urilishi mumkin.`
  );
}

export default defineTool({
  name: 'pro_opendata_count',
  description:
    'Datasetda qancha qator bor va ular qanday taqsimlangan: count(*), bir ustun bo‘yicha ' +
    'guruhlash, minimal/maksimal/o‘rtacha. Metama’lumot qatorlar sonini bermaydi - faqat shu yo‘l.',
  category: 'opendata',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: { type: 'string', description: 'Dataset id, permalink yoki SODA manzili' },
      group_by: { type: 'string', description: 'Guruhlash ustuni - har bir qiymat nechta qator' },
      min: { type: 'string', description: 'MIN() bilan hisoblanadigan ustun' },
      max: { type: 'string', description: 'MAX() bilan hisoblanadigan ustun' },
      avg: { type: 'string', description: 'AVG() bilan hisoblanadigan ustun' },
      sum: { type: 'string', description: 'SUM() bilan hisoblanadigan ustun' },
      limit: { type: 'number', description: 'Guruhlash natijalarining chegarasi (standart 20)' },
      where: { type: 'string', description: 'SoQL shart (masalan "active=\'YES\'")' },
    },
    required: ['dataset'],
  },
  async handler(input) {
    const p = view(input);
    const reference = parseReference(strOrEmpty(p, 'dataset'));
    if ('error' in reference) return failJson('Hisob', { error: reference.error });

    const resolved = await resolveDataset(reference.id, reference.domain);
    if (!resolved.ok) {
      return failJson('Hisob', {
        id: reference.id,
        error: resolved.message,
        rate_limited: resolved.rate_limited,
      });
    }

    const groupBy = strOrEmpty(p, 'group_by');
    const min = strOrEmpty(p, 'min');
    const max = strOrEmpty(p, 'max');
    const avg = strOrEmpty(p, 'avg');
    const sum = strOrEmpty(p, 'sum');
    const where = strOrEmpty(p, 'where');
    const limit = Math.max(1, Math.min(num(p, 'limit', 20) || 20, 500));

    // Built from the named fields rather than passed straight through, so `count(*)` cannot be
    // smuggled in as an arbitrary SoQL fragment and so the projections are always well formed.
    const projections: string[] = [];
    if (groupBy) projections.push(soqlIdentifier(groupBy));
    projections.push('count(*)');
    if (min) projections.push(`min(${soqlIdentifier(min)})`);
    if (max) projections.push(`max(${soqlIdentifier(max)})`);
    if (avg) projections.push(`avg(${soqlIdentifier(avg)})`);
    if (sum) projections.push(`sum(${soqlIdentifier(sum)})`);

    const params: Record<string, string> = { $select: projections.join(','), $limit: String(limit) };
    if (groupBy) params.$group = soqlIdentifier(groupBy);
    if (where) params.$where = where;

    const result = await sodaRows(resolved.domain, reference.id, params);
    if (!result.ok) {
      return failJson('Hisob', {
        id: reference.id,
        domain: resolved.domain,
        error: result.message,
        portal_without_data_api: result.html,
        rate_limited: result.rate_limited,
      });
    }

    // Socrata returns every aggregate as a string, including `count`. Parsing here means the caller
    // gets a number; `Number('104900')` is exact for anything under 2^53, which no row count is.
    const rows = result.rows.map((row) => {
      const parsed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const numeric = Number(value);
        parsed[key] = typeof value === 'string' && value.trim() !== '' && Number.isFinite(numeric) ? numeric : value;
      }
      return parsed;
    });

    // An aggregate that answered nothing is not the same statement as a dataset that holds nothing, and
    // the two were measured indistinguishable: the same group-by query returned `[]` on one runner and
    // 105,003 rows on another, seconds apart, with no code between them. So the portal is asked for the
    // row total it reports for itself, and the answer says which case this is. `dataset_rows: null` is
    // kept as unknown rather than folded into zero, because zero here would be the same lie in a new box.
    if (rows.length === 0) {
      const datasetRows = await sodaTotalRows(resolved.domain, reference.id, where || undefined);
      const note = emptyAggregateNote({ datasetRows, where, groupBy, domain: resolved.domain, id: reference.id });
      return jsonBlock("Hisob: ma'lumot yo'q", {
        id: reference.id,
        domain: resolved.domain,
        grouped_by: groupBy || undefined,
        empty: true,
        rows: [],
        dataset_rows: datasetRows,
        note,
      });
    }

    return jsonBlock(`Hisob: ${reference.id}`, {
      id: reference.id,
      domain: resolved.domain,
      grouped_by: groupBy || undefined,
      computed: {
        count: true,
        min: min || undefined,
        max: max || undefined,
        avg: avg || undefined,
        sum: sum || undefined,
      },
      total: rows.length === 1 ? (rows[0].count as number | undefined) : undefined,
      rows,
      // Measured, not guessed: SoQL flattens `min(vehicle_license_number)` into the column
      // `min_vehicle_license_number`. A caller who expects the expression back as written looks at the
      // output for a key that is not there and concludes the aggregate did not run.
      column_naming: 'Funksiyalar maydon nomiga yopishtiriladi: min(ustun) -> min_ustun, count(*) -> count.',
    });
  },
});
