import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { forgetDocument } from '../../core/local-index.js';

/**
 * pro_index_forget — remove one document from the index
 * Pack: index (pro-fetch)
 *
 * Being able to delete is not a courtesy feature. A local index of pages read is a store of other
 * people's content on somebody's disk; if a caller asks for it gone, "gone" has to be the answer, along
 * with the edges and the schedule entry that pointed at it.
 */
export default defineTool({
  name: 'pro_index_forget',
  description:
    "Indeksdan bitta hujjatni o'chiradi: matn, indeks qatori, unga kirish/chiqish havolalari va " +
    'qayta o‘qish jadvali yozuvi.',
  category: 'index',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "O'chiriladigan manzil (indeks kaliti)" },
    },
    required: ['url'],
  },
  async handler(input) {
    const p = view(input);
    const url = strOrEmpty(p, 'url');
    if (!url) return failJson('Indeks', { error: 'url kerak' });
    const result = await forgetDocument(url);
    return jsonBlock(result.removed ? 'O‘chirildi' : 'O‘chiriladigan narsa yo‘q', {
      ok: true,
      ...result,
      ...(result.removed
        ? {}
        : { note: `"${url}" indeksda topilmadi — ehtimol manzil boshqacha saqlangan (trailing slash, http/https).` }),
    });
  },
});
