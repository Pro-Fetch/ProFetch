import { describe, it, expect } from 'vitest';
import '../src/loader.js'; // barcha toolni ro'yxatga qo'shadi
import { allTools, dispatch } from '../src/core/tool.js';
import { listTools } from '../src/router.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Read from the manifest rather than written here: a literal drifted in four places and the drift
// was only caught because the suite ran, not because anything checked it. The category map used to
// be copied out by hand (24 of 42 categories); pointing at the manifest checks all of them and
// removes the second place a number had to be maintained.
const MANIFEST = JSON.parse(readFileSync('scripts/tool-counts.json', 'utf8')) as {
  total: number;
  categories: Record<string, number>;
  profiles: { smart: number; minimal: number; standard: number; full: number };
};
const TOTAL = MANIFEST.total;

const EXPECTED_COUNTS: Record<string, number> = MANIFEST.categories;
const SCHEMA_CATEGORIES = new Set([
  'apitest',
  'archive',
  'auth',
  'browser',
  'convert',
  'crawl',
  'extract',
  'i18n',
  'media',
  'monitoring',
  'research',
  'search',
  'git',
  'codehost',
  'devops',
  'database',
  'security',
  'knowledge',
  'collaboration',
  'storage',
  'productivity',
]);

describe(`pro-fetch MAX - barcha ${TOTAL} tool`, () => {
  it(`jami aynan ${TOTAL} tool ro'yxatga olinadi`, () => {
    expect(allTools().length).toBe(TOTAL);
  });

  it('har kategoriya kutilgan sonda', () => {
    const counts: Record<string, number> = {};
    for (const t of allTools()) counts[t.category] = (counts[t.category] ?? 0) + 1;
    for (const [cat, n] of Object.entries(EXPECTED_COUNTS)) {
      expect(counts[cat] ?? 0, 'kategoriya: ' + cat).toBe(n);
    }
  });

  it('nomlar unikal va MCP formatiga mos', () => {
    const names = allTools().map((t) => t.name);
    expect(new Set(names).size).toBe(TOTAL);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("har toolda to'liq metadata bor", () => {
    for (const t of allTools()) {
      expect(t.description.length).toBeGreaterThanOrEqual(10);
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.handler).toBe('function');
    }
  });

  it('scoped tool categories publish closed input schemas', () => {
    const schemaTools = allTools().filter((tool) => SCHEMA_CATEGORIES.has(tool.category));
    // Counted from the registry: every tool in a category whose schema `applyCategorySchema` closes.
    // 441 = 440 plus pro_fetch_query_understand. Each of these two rows has to be moved by whoever adds
    // the tool, which is the point: the number is a measurement the test re-states, not a guess it inherits.
    expect(schemaTools).toHaveLength(441);
    for (const tool of schemaTools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
    }
    for (const tool of schemaTools.filter((item) => item.category === 'convert')) {
      // Convert tools split across two source readers, so the alternatives differ per tool:
      // `readTextSource` takes text/content/data/url and `readBinarySource` takes base64/url.
      // This asserted a flat five-way set for all of them, which advertised `base64` to tools that
      // cannot read it and `text` to tools that cannot either.
      const alternatives = (tool.inputSchema.anyOf ?? []).map((entry) => (entry as { required: string[] }).required[0]);
      const isBinary = alternatives.includes('base64');
      // Binary tools read `str(input, 'base64', 'data_base64')` - both spellings are one input.
      expect(alternatives.length, tool.name).toBe(isBinary ? 3 : 4);
      expect(alternatives, tool.name).toContain('url');
      // Each alternative must name a property the tool actually declares, or the call is rejected.
      for (const key of alternatives) {
        expect(tool.inputSchema.properties, `${tool.name}:${key}`).toHaveProperty(key);
      }
    }
  });

  it('research tool schemas match each operation’s required input', () => {
    const schema = (name: string) => allTools().find((tool) => tool.name === name)?.inputSchema;
    expect(schema('pro_research_verify_claim')?.required).toEqual(['claim']);
    expect(schema('pro_research_gap_analysis')?.required).toEqual(['sources']);
    expect(schema('pro_research_gather_sources')?.required).toEqual(['query']);
    expect(schema('pro_research_extract_facts')?.required).toBeUndefined();
    expect(schema('pro_research_extract_facts')?.anyOf).toEqual(
      ['text', 'content', 'document', 'sources'].map((key) => ({ required: [key] })),
    );
    expect(schema('pro_research_verify_claim')?.properties).not.toHaveProperty('selector');
  });

  it('auth schemas expose only the fields their operations consume', () => {
    const schema = (name: string) => allTools().find((tool) => tool.name === name)?.inputSchema;
    expect(schema('pro_fetch_scopes_audit')?.required).toEqual(['required_scopes']);
    expect(schema('pro_fetch_scopes_audit')?.properties).toHaveProperty('granted_scopes');
    expect(schema('pro_fetch_credential_test')?.required).toEqual(['url']);
    expect(schema('pro_fetch_credential_test')?.properties).toHaveProperty('key_name');
    expect(schema('pro_fetch_cookie_jar_manage')?.properties).toHaveProperty('cookie_name');
    expect(schema('pro_fetch_scopes_audit')?.properties).not.toHaveProperty('selector');
  });

  it('search tool schemas distinguish text queries from image URLs', () => {
    const tools = allTools().filter((tool) => tool.category === 'search');
    expect(tools).toHaveLength(22);
    // Two tools are exempt, for two different reasons: `reverse_image_search` sends an image rather than a
    // query, and `search_engines` reports on this server's own registry, so requiring a query from it
    // would mean the tool that lists the engines could only be reached by inventing a search term.
    const noQuery = ['pro_fetch_reverse_image_search', 'pro_fetch_search_engines'];
    for (const tool of tools.filter((item) => !noQuery.includes(item.name))) {
      expect(tool.inputSchema.required, tool.name).toContain('query');
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty('password');
    }
    expect(
      tools
        .find((tool) => tool.name === 'pro_fetch_search_engines')
        ?.inputSchema.required?.filter((key) => key !== 'query'),
      'the engine listing must not demand a query',
    ).toEqual([]);
    const reverse = tools.find((tool) => tool.name === 'pro_fetch_reverse_image_search');
    expect(reverse?.inputSchema.required).toEqual(['image_url']);
    expect(reverse?.inputSchema.properties).toHaveProperty('image_url');
    expect(reverse?.inputSchema.properties).not.toHaveProperty('query');
  });

  it('archive schemas distinguish cache keys from URL-based providers', () => {
    const schema = (name: string) => allTools().find((tool) => tool.name === name)?.inputSchema;
    expect(schema('pro_fetch_cache_get')?.required).toEqual(['key']);
    expect(schema('pro_fetch_cache_get')?.properties).not.toHaveProperty('url');
    expect(schema('pro_fetch_offline_browse')?.required).toBeUndefined();
    expect(schema('pro_fetch_offline_browse')?.properties).toHaveProperty('query');
    expect(schema('pro_fetch_archive_org_fetch')?.required).toEqual(['url']);
  });

  it('namuna tool dispatch / handler tekshiruvi', async () => {
    // Tarmoq chaqirmaydigan packlar dispatch qilinadi;
    // tarmoq packlarida faqat handler mavjudligi tekshiriladi
    const NET = new Set([
      'http',
      'github',
      'docs',
      'extract',
      'archive',
      'monitoring',
      'convert',
      'browser',
      'media',
      'apitest',
      'crawl',
      'research',
      'search',
      'git',
      'codehost',
      'devops',
      'database',
      'collaboration',
      'storage',
      'productivity',
      'security',
      'knowledge',
    ]);

    // Composite tools legitimately require an input, so they are checked for a handler rather
    // than dispatched with no arguments the way the parameterless packs are.
    const COMPOSITES = new Set([
      'pro_data_pipeline',
      'pro_capability_call',
      'pro_capability_map',
      'pro_research_deep',
      'pro_fetch_ingest',
      'pro_audit_page',
      'pro_repo_audit',
      'pro_pr_review',
      'pro_page_diff',
      'pro_site_scan',
    ]);
    const seen = new Set<string>();
    const samples = allTools().filter((t) => {
      if (seen.has(t.category)) return false;
      seen.add(t.category);
      return true;
    });
    // Derived, like the tool total: a literal here needed editing on every category added, and was
    // the fourth time this session that a number had to be maintained in two places.
    expect(samples.length).toBe(Object.keys(MANIFEST.categories).length);
    for (const t of samples) {
      if (NET.has(t.category) || COMPOSITES.has(t.name)) {
        expect(typeof t.handler).toBe('function');
        continue;
      }
      const res = await dispatch(t.name, {});
      expect(res.content.length).toBeGreaterThan(0);

      // A tool that declares required arguments must reject an empty call, and say which ones.
      // This assertion used to be "never errors", which only held because nothing enforced
      // `required` - it now encodes the contract the schema already published.
      //
      // `anyOf` counts as declaring a requirement. `pro_image_resize` takes a source as either `url`
      // or `base64`, so `required` is empty while an empty call is still meaningless - and treating
      // that as "accepts anything" would have failed a tool for being honest.
      const required = t.inputSchema.required ?? [];
      const anyOf = t.inputSchema.anyOf ?? [];
      if (required.length === 0 && anyOf.length === 0) {
        expect(res.isError, t.name).toBeFalsy();
      } else if (required.length > 0) {
        expect(res.isError, `${t.name} should reject {}`).toBe(true);
        const body = res.content.map((entry) => entry.text).join(' ');
        expect(body, t.name).toContain('majburiy argumentlar');
      } else {
        // `anyOf` states the choice in prose, so the wording is the handler's rather than the
        // central one. What matters is that the call is refused, not how it is phrased.
        expect(res.isError, `${t.name} should reject {}`).toBe(true);
      }
    }
  });

  it('nomalum tool xato qaytaradi', async () => {
    const res = await dispatch('bunday_tool_yoq', {});
    expect(res.isError).toBe(true);
  });

  it('profillar: minimal, standard, full', () => {
    expect(listTools('minimal').length).toBe(MANIFEST.profiles.minimal);
    expect(listTools('standard').length).toBe(MANIFEST.profiles.standard);
    expect(listTools('full').length).toBe(TOTAL);
    expect(listTools('smart').map((tool) => tool.name)).toContain('pro_fetch_tool_execute');
    expect(listTools('smart').length).toBe(MANIFEST.profiles.smart);
  });
});

describe('MAX platform handlers', () => {
  it('publishes all nine new categories with real handler functions and closed schemas', () => {
    const categories = new Set([
      'git',
      'codehost',
      'devops',
      'database',
      'security',
      'knowledge',
      'collaboration',
      'storage',
      'productivity',
    ]);
    const tools = allTools().filter((tool) => categories.has(tool.category));
    expect(tools).toHaveLength(200);
    for (const tool of tools) {
      expect(typeof tool.handler).toBe('function');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
  it('publishes truthful MCP safety annotations for the new packs', () => {
    const byName = (name: string) => allTools().find((tool) => tool.name === name);
    expect(byName('pro_fetch_knowledge_search')?.annotations?.readOnlyHint).toBe(true);
    expect(byName('pro_fetch_knowledge_ingest')?.annotations?.destructiveHint).toBe(true);
    expect(byName('pro_fetch_productivity_gmail_send')?.annotations?.destructiveHint).toBe(true);
    expect(byName('pro_fetch_database_sqlite_query')?.annotations?.readOnlyHint).toBe(true);
  });
  it('runs local extractive chunk and summary tools without external services', async () => {
    const chunk = await dispatch('pro_fetch_knowledge_chunk', { text: 'One sentence. '.repeat(80), amount: 300 });
    expect(chunk.isError).not.toBe(true);
    expect(chunk.content[0]?.text).toContain('chunks');
    const summary = await dispatch('pro_fetch_knowledge_summarize', {
      text: 'Alpha improves safety. Beta improves speed. Alpha improves reliability.',
      amount: 2,
    });
    expect(summary.isError).not.toBe(true);
    expect(summary.content[0]?.text).toContain('extractive');
  });
  it('scans hidden .env credential files but does not return secret values', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pro-fetch-secret-test-'));
    const secret = 'github_pat_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const previous = process.env.PRO_FETCH_WORKSPACE;
    try {
      await writeFile(path.join(root, '.env.production'), `GITHUB_TOKEN=${secret}\n`, 'utf8');
      process.env.PRO_FETCH_WORKSPACE = root;
      const scan = await dispatch('pro_fetch_security_secret_scan_files', { path: '.', recursive: true });
      const text = scan.content.map((item) => item.text).join('\n');
      expect(text).toContain('.env.production');
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.PRO_FETCH_WORKSPACE;
      else process.env.PRO_FETCH_WORKSPACE = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  it('scans likely secrets but never emits secret values', async () => {
    const sample = 'github_pat_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const r = await dispatch('pro_fetch_security_secret_scan_text', { text: sample });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]?.text).toContain('[REDACTED]');
    expect(r.content[0]?.text).not.toContain(sample);
  });
  it('restricts SQL tools to read-only statements', async () => {
    const tool = allTools().find((x) => x.name === 'pro_fetch_database_sqlite_query');
    expect(tool).toBeDefined();
    const r = await dispatch('pro_fetch_database_sqlite_query', { sql: 'DROP TABLE users' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('READ_ONLY_SQL_ONLY');
  });
});
