// Manifestni haqiqiy ro'yxatdan qayta o'lchab yangilash.
//
// Qo'lda raqam yozish — bu xuddi shu loyihada bir necha marta sodir bo'lgan xato. Bu skript
// registrni o'zi o'lchaydi va har bir qiymatni faqat o'lchovdan keyin yozadi.
//
// Profil sonlari ham o'lchanadi. Oldin skript `full` va `smart`ni yangilab, `minimal` va
// `standard`ni qo'lda qoldirardi — ya'ni yangi kategoriya qo'shilganda manifest eski sonni
// saqlab, `verify:registry` uni "187 kutilgan, 179 yozilgan" deb qizil qilardi. O'lchanmagan
// raqam manifestda tura olmaydi.

import { readFileSync, writeFileSync } from 'node:fs';

process.env.PRO_FETCH_PROFILE = 'full';
const base = new URL('../src/', import.meta.url).href;
await import(base + 'env.js');
await import(base + 'loader.js');
const { allTools } = await import(base + 'core/tool.js');
const { PROFILE_LEVELS, SMART_TOOL_NAMES, isToolVisibleInProfile } = await import(base + 'core/profile.js');

const tools = allTools();
const manifest = JSON.parse(readFileSync('scripts/tool-counts.json', 'utf8'));
const previousCategories = Object.keys(manifest.categories ?? {});

const counts = {};
for (const tool of tools) counts[tool.category] = (counts[tool.category] ?? 0) + 1;

const profiles = {};
for (const profile of Object.keys(PROFILE_LEVELS)) {
  profiles[profile] =
    profile === 'smart' ? SMART_TOOL_NAMES.size : tools.filter((t) => isToolVisibleInProfile(t, profile)).length;
}

const before = { total: manifest.total, categoryCount: manifest.categoryCount, profiles: { ...manifest.profiles } };

manifest.total = tools.length;
manifest.full = tools.length;
manifest.categoryCount = Object.keys(counts).length;
manifest.categories = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
manifest.profiles = profiles;
manifest.smartComposites = [...SMART_TOOL_NAMES];

writeFileSync('scripts/tool-counts.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`  total: ${before.total} -> ${manifest.total}`);
console.log(`  kategoriya: ${before.categoryCount} -> ${manifest.categoryCount}`);
for (const profile of Object.keys(profiles)) {
  const was = before.profiles[profile];
  console.log(
    `  ${profile}: ${was ?? "o'lchanmagan"} -> ${profiles[profile]}${was !== undefined && was !== profiles[profile] ? "  (o'zgardi)" : ''}`,
  );
}
for (const category of Object.keys(counts).filter((c) => !previousCategories.includes(c))) {
  console.log(`    + yangi kategoriya: ${category}: ${counts[category]}`);
}
