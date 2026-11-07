# Changelog

Barcha muhim o'zgarishlar shu faylda. Format: [Keep a Changelog](https://keepachangelog.com/),
versiya semver bo'yicha.

## [Unreleased]

_Hozircha bo'sh._

## [1.1.0] - 2026-11-06

### Added

- **Brend: chayon.** `docs/assets/` ichida tanlangan belgi — toza siluet
  (`pro-fetch-scorpion-white.png` va `pro-fetch-scorpion-black.png`, shaffof fonli) va README sarlavhasi
  uchun tayyorlangan chip (`pro-fetch-chip.png`: qora yumaloq plastinka + oq chayon). Chip qasddan
  PNG: yalang'och qora belgi GitHub va npm'ning qorong'i rejimida ko'rinmay qoladi, plastinka esa
  ikkala rejimda ham o'qiladi. Hozir README `cover-light.png` / `cover-dark.png` ishlatadi.
- **23 ta qidiruv engine.** `src/core/search-engines.ts` — bitta reyestr, har qatorda o'z dalili bilan.
  14 tasi kalitsiz va tirik tekshirilgan (Hacker News, Wikipedia, npm, iTunes, OpenAlex, Crossref,
  arXiv, PubMed, Europe PMC, DOAJ, Google News, DuckDuckGo; Marginalia brauzer UA talab qiladi,
  SearXNG operator URL'i talab qiladi), 9 tasi kalit bilan (Serper, Brave, Tavily, Exa, SerpAPI,
  Linkup, DataForSEO, Google CSE, Perplexity) — ularning holati `endpoint`: provider o'z rad javobini
  bergan (URL, metod va kalit sarlavhasi tasdiqlangan), natijali yo'l esa kalitsiz kuzatilmagan.
  Qo'llab-quvvatlanmaydiganlar yozilmagan: SearchAPI.io va Kagi 404 berdi, Yandex ulanishni rad etdi,
  dev.to qidiruv yo'li o'chirilgan.
- **`pro_fetch_search_engines`** (757-tool) — qaysi engine hozir ishlatishga tayyor, qaysi biri qaysi
  kalitni kutayotgani va har biri haqidagi dalil. Kalit qiymatlari chiqarilmaydi.
- **`pro_fetch_web_search` uchta rejim:** `engine` (bitta indeksni majburiy), `kind` (indeks turi
  bo'yicha cheklash), `combine` (barcha ishlaydigan indekslarni so'rab, URL bo'yicha birlashtirish).
  Javobda `failedProviders` (sabab bilan), `enginesConfigured` va `enginesSkipped` (kerakli o'zgaruvchi
  nomlari bilan). O'lchangan: 12 engine'dan 6 tasi javob berdi, 27 ta dublikat olib tashlandi.
- **ProHuman: `dispatch_latency_ms`.** `drift()` endi `pointerMove` davomiyligini ham o'lchaydi
  (max/sum/samples). Sabab: macOS CI runner'da `worstMs 804.1` / `ceilingMs 320` / scheduler lag `3 ms`
  o'lchandi — driver harakatni deyarli o'z vaqtida boshlagan, qolgan vaqt brauzer uni tashishiga
  ketgan. `status` va `verify` endi ikkala sonni beradi va breach atributsiyasi `lag + carry`.
  Bu mashinada 3 s ichida: 15 drift, lag max 13 ms, carry max 6 ms, eng yomon gap 261.7 ms.
- **Brauzer ochilishini qayta urinish.** `launchManaged` endi transient ochilish muvaffaqatsizligida
  3 martagacha uradi, har biri alohida profil papkasida (`launch-retry-2`, `launch-retry-3`). Belgini
  `isTransientLaunchFailure` ajratadi — Windows runner'dagi matn (`Target page, context or browser has
been closed` + pid'ini topolmagan `taskkill`) testda so'zma-so'z qaydlangan. Rad etish (browser
  o'rnatilmagan, adapter yo'q, argument rad etilgan) qayta urilmaydi.

### Changed

- **Ochiq ma'lumot rad javoblari endi nomlanadi.** `pro_opendata_*` tool'lari portal rad etganini
  `failJson` bilan qaytaradi (`dispatch` shundan `structuredContent.ok` hisoblaydi), 429 esa
  `rate_limited: true` va portalning o'z `Retry-After` soni bilan chiqadi. Guruhlash bo'sh qaytса,
  javob `empty: true` bilan birga **shu filtrlarda** portalning o'z qator sonini so'raydi va
  `dataset_rows` ni yozadi — `0` (filtrga mos qator yo'q), aniq son (portal agregatsiyani bajarmagan)
  yoki `null` (son ham kelmagan).
- **`pro_fetch_json_path` o'z tavsifidagi grammatikani ishlatadi.** Boshidagi `$` root marker qabul
  qilinadi, `[n]` va `.n` indeks, `[*]` massiv ustidan xarita (maydoni bo'lmagan element `null`
  bo'ladi), to'xtagan bo'lim nomlanadi, `{a,b}` esa "qo'llab-quvvatlanmaydi" deb grammatika ko'rsatib
  rad etiladi. Eski xatti-harakat git'dan olib qayta ishga tushirilib tekshirildi:
  `$.repository.owner.login` → "Path topilmadi", `repository.owner.login` → ishlaydi edi.
- **HTTP gateway repodan olindi.** `src/http/`, `src/core/dispatch-guard.ts`, gateway testlari,
  `deploy/`, `Dockerfile`, `fly.toml`, `site/`, gateway dokumentatsiyasi va usage-eksport skripti
  chiqarib tashlandi; paket endi bitta stdio MCP serverini chiqaradi. Kod tarixda ham qoldirmasligi
  uchun commit'lar qayta yozildi (`git filter-repo`), ishchi nusxa fayllari o'zgarmadi — daraxt
  hashi `de579307662d6b2ed2528178cb0cf45927f52d0d` qayta yozishdan oldin va keyin bir xil.

### Fixed

- Nomi bilan talab qilingan engine'ning kaliti bo'lmasa, endi o'sha kalitni aytadi. Oldin
  `engine: 'google-cse'` kalitsiz `"Hech bir qidiruv engine javob bermadi (0 urinish): ."` deb
  javob berardi — urilmagan zanjir uchun "0 urinish" va bo'sh ro'yxat. Endi: `"Google Custom Search"
sozlanmagan — kerak: GOOGLE_API_KEY + GOOGLE_CSE_ID (hech narsa urinishi qilinmadi)`.
- RSS/Atom feedlari HTML rejimida o'qilganda `<link>` void element hisoblanadi — Google News'dagi 50
  ta itemning URL'i bo'sh deb tashlab yuborilayotgan edi; endi XML rejimida.
- Qidiruv so'rovlari sahifa-fetch 15 s limitini meros olmasligi: 25 s alohida byudjet (Europe PMC
  yuklangan mashinada 15 s dan oshib, engine buzuq deb hisoblangan edi).
- ProHuman hisobi: lateness namunasi brauzer round trip'dan **oldin**, drift esa keyin yozilardi —
  bitta `status` o'qishida 3 namuna / 2 drift (macOS) va 7 / 6 (Windows). Ikkalasi endi harakat
  yetib kelgach, bitta sinkron blokda. `lastPointerAtMs` ham yetkazib berish vaqti bilan belgilanadi,
  `status`ga `tick_running_ms` qo'shildi.

## [1.0.0] - 2026-10-31

Birinchi barqaror release: nom, kontrakt va tekshirilganlik darajasi o'zgarmas deb e'lon qilinadi.

### Added

- **Bigfoot — majburiy ish oqimi.** `pro_fetch_workflow` bitta holatli lifecycle: plan → blind audit →
  risk dispositions → writes uchun tasdiq → execute → verify → final audit → finish. Rejalashtirilgan
  talabdan tashqaridagi vazifa, ro'yxatga olingan-lekin yo'nalishsiz qolgan xavf, da'voga nisbatan
  kuchsiz tekshiruv va dalilsiz "bajarildi" endi rad etiladi; har rad etish sanaladi va hisobda chiqadi.
  Xavf darajasi registry'dan hisoblanadi — qo'ng'iroqchi o'zi e'lon qilgan `writes`dan emas.
- **Host adapterlari.** `adapters/` ichida Claude Code, Codex, Gemini CLI, Copilot CLI va umumiy MCP
  uchun yo'riqnoma bloki — `introduce` action'i beradigan matndan generatsiya qilinadi va diskdagi
  fayl bilan shu matn farq qilsa test yiqiladi. `introduce` endi `host_instruction`, `enforced` va
  `not_guaranteed`ni alohida beradi: server hostning fikrini boshqara olmaydi (§15.4), shuning uchun
  chegara yashirilmay, yozib qo'yiladi.
- **Belgilangan korpus va o'lchanadigan sifat.** `tests/fixtures/bigfootCorpus.ts` — 11 nuqsonli reja,
  4 toza reja, 5 "bajarildi" da'vosi. Natija: recall 1.00, precision 1.00, fake_completion_rate 0.00.
  Korpus yozilganida birinchi haqiqiy bo'shliq topildi: `covers` bo'sh vazifa darvozadan o'tib
  ketayotgan edi — endi `task_out_of_scope` bilan rad etiladi.
- **Jonli tarmoq uchun nomli skip.** `tests/helpers/liveGate.ts` Node `fetch failed` cause zanjirini
  o'qiydi: tarmoq yo'q bo'lsa test nom bilan `skip` bo'ladi, 403/500/HTML/noto'g'ri kalit bo'lsa
  baribir FAIL bo'ladi. Tarmoq holati mahsulot xatosi sifatida yozilmaydi, aksincha ham.
- **README category guard.** `verify:static` endi 42 kategoriyaning har birini manifestdagi soni bilan
  README'da topishini talab qiladi. Eski jadval ikki tomonga chetlashgan edi: sarlavha "42 kategoriya"
  deb, jadval 25 tasini sanar, `admin`ni esa 24 deb yozgandi.
- **`smart` profili uchun to'liq ro'yxat guardi.** `pro_fetch_workflow` va `pro_synthesize` majburiy
  12 tasiga qo'shildi — avval 10 tasi tekshirilardi, ya'ni profil ikkitasini tashlab yuborsa guard
  jim qolardi.

### Fixed

- **Jonli test uchinchi toanning sozlamasini bizning xulq deb o'qiyotgandi.**
  `tests/opendata-socrata.test.ts` Fort Worth portalining `portal_without_data_api: true` qaytarishini
  talab qilardi; portal ArcGIS'ga ko'chgan (`/resource/…json` endi `hub.arcgis.com/legacy`ga 302
  beradi) va CI bir kuni MAHSULOT to'g'ri turganda qizil bo'ldi. HTML qarori `htmlInsteadOfJson()` deb
  alohida funksiya qilib, uchta tarmoqsiz test bilan bog'landi; jonli test endi istalgan javobda
  o'rinli bo'lgan kafolatni tekshiradi: qatori bor dataset "0 ta topilmadi" deb yozilmasligi kerak.
  Mutation bilan tasdiqlangan — funksiyani `false` qilsangiz ikki test darhol yiqiladi.

### Changed

- **Repozitoriý `Pro-Fetch` organizatsiyasiga ko'chirildi**, butun tarix (177 commit) `pro-fetch`
  muallifi bilan qayta yozildi. `package.json` `repository`/`homepage`/`bugs` yangi manzilda.
- **README 0-dan yozildi.** Markazlashgan hero, emoji sarlavhalar va "nega zo'r" bo'limlari o'rniga:
  ish → javob beradigan tool jadvali, profil/ruhsat/javob boshqaruvining o'zi va o'lchangan raqamlar.
- **Paket nomi: `pro-fetch-mcp` → `pro-fetch`.** Repozitoriý `Pro-Fetch` organizatsiyasiga o'tkazildi
  va npm sahifasi shu nomni oladi (`pro-fetch` registry'da bo'sh; `pro-fetch-mcp` band). `package.json`
  `name` va `bin`, `mcp.example.json`, besh ta host adapteri va `docs/RELEASE.md` shu nomda.
- **Nom va User-Agent endi bitta manbadan.** `src/core/version.ts` oldin `pro-fetch-mcp`ni ikki
  joyda qattiq yozgan edi: versiya qo'rqinchli `unknown`ga tushmasligi uchun nom tekshiruvida va
  User-Agent satrida. Endi `PACKAGE_NAME`, `VERSION` va `USER_AGENT` uchala `package.json`dan
  o'qiladi — nomni o'zgartirish bir qatorlik ish, tuzoq emas.
- **Overpass User-Agenti to'g'irlandi.** `_osm.ts` eski defaultda **begona** loyiha manzilini
  (`github.com/mtth/avsc`) va qo'lda yozilgan `0.3` versiyasini yuborardi; Overpass o'zini taniyi
  deb so'raydigan sarlavha yolg'on edi. Endi nom+versiya manifestdan, aloqa havolasi esa npm
  sahifasidan olinadi. Shuningdek `PGAPPNAME` va opendata User-Agenti yangi nomga o'tdi.

### Security

Ushbu audit qator xavf/nuqsonni o'lchab, sinov bilan tasdiqlab yopdi (suite: 52 fayl / 999 test):

- **ReDoS:** foydalanuvchi/remote regex'lari katastruk backtracking jihatdan tekshiriladi (`safe-regex2`)
  va xavfli pattern rad etiladi — `pro_fetch_regex_extract`, `crawl_filter` include/exclude, robots.txt
  wildcard va `pro_schema_validate` string `pattern`. Single-threaded stdio event loop'da bir muzlagan
  so'rov hamma parallel so'rovni qotirardi.
- **isError:** `units`/`phonetics` haqiqiy operator xatolari (`jsonBlock({error})` orqali emas) endi
  `failJson` bilan `isError:true` qaytaradi — avval MCP klientlari muvaffaqiyatsiz konversiyani
  "muvaffaqiyat" deb o'qiyardi. "Resurs topilmadi" natijalari ataylab non-error holicha qoldirildi.
- **Tool annotatsiyalari:** diskka yozadigan yoki ixtiyoriy tool bajaradigan `tool_execute`,
  `download_file`, `media_download`, screenshot tool'lari endi `readOnlyHint:true` deb aldov
  bermaydi — ular `PRO_FETCH_READ_ONLY` darvozasi bilan bir manbadan sinflansadi.
- **num() tuzoqlari:** `min=1` va floor qilish `perft_depth:0`, sub-pixel `blur` va
  `pr_number:0`ni jimgina buzardi — uchala holat ham to'g'irlandi.
- **JWT verify:** har algoritm uchun to'g'ri hash (ES384/HS384/HS512 → SHA-384/512), Ed25519 hash'siz,
  ECDSA `namedCurve` import bilan — avval valid ES/EdDSA/HS384 tokenlari "noto'g'ri" deyilardi.
- **Fuel:** `mpg ↔ L/100km` resiprok ekanini hisobga oladi (avval chiziqli ko'paytirib 30 mpg → 33.7
  deb noto'g'ri va teskari yo'nalishda qaytarardi).
- **DoS/memory:** SQL lexer `sql.slice(index)` O(n²) naqshi sticky regex bilan O(n) ga tushirildi va
  kirish uzunligi cheklandi; `ratelimit.buckets` va `network-gate.hostGates` xaritalari endi
  chegaralanadi (yuqori kartinaklik hostlarda cheksiz o'smaslik uchun).
- **dev/prod paritet:** schema-narrowing `src/` manbasini CWD o'rniga modul joylashuvidan topadi —
  `dist/` bilan ishga tushganda (paketda `src/` yo'q) endi ham xuddi dev'dagideq tor sxema ochadi,
  avval esa jimgina no-op bo'lib, prod kengroq sxema ko'rsatardi.

### Changed

- **Kompozitlar ichki parallel.** Bog'liq bo'lmagan qadamlar `runParallel()` bilan bir vaqtda
  bajariladi (fan-out 8). Konkurrentlik chegaralari o'zgarmagan — ular execution engine'da qoladi;
  composite faqat o'z navbatida nechta promise ushlashini cheklaydi. Asosiy foyda tarmoq
  bosqichlarida: `research_deep` uchta qidiruvni va N ta sahifa o'qishni parallel qiladi.
- **`detail` byudjeti.** Har bir kompozit `detail: "summary" | "full"` oladi. Summary rejimi bo'sh
  natija bergan qadamlarni yashiradi va matnlarni qisqartiradi — 17-qadamli auditda 43 KB → 3.8 KB
  (**91% kamayish**). To'liq rejim ham 120,000 belgi chegarasini hurmat qiladi: avvalgi halqa
  har bir katta matnni faqat bir marta qisqartirib, 750 KB natija qoldirardi (o'lchilgan muammo).
- **Semantik qidiruv** (`src/core/intent-search.ts`): BM25 + morfologik kengaytirish + 55 so'zli
  sinon jadvali. Kalit so'z mosligi "papers about retrieval augmented generation" so'rovida arxiv
  tool'ini **topa olmasdi**; endi u birinchi o'rinda. Nonsense so'z endi bo'sh natija beradi
  (`MIN_RELEVANCE` chegarasi). Kompozitlar kengaytirilgan so'zlarda maxsus tool'larni bosib
  ketmasligi uchun jazolangan.

### Added

- `src/core/composite-budget.ts` — `detailMode`, `renderBudgeted`, `isInformative`.
- `tests/smart-system-quality.test.ts` — 25 ta test: semantik qidiruv, byudjet, parallel izolyatsiya.

- **Smart System** — MCP klientlar modelga ~10 tagacha tool yubora olishi muammosini hal qiladi.
  569 tool'ni 10 ta kuchli tool'ga yig'adi, shunda imkoniyat saqlanadi:
  - `pro_capability_call` — `{ tool, arguments }` ro'yxatini **bir chaqiruvda** bajaradi (batch).
    Birinchi xato qolganlarini to'xtatmaydi; har bir natija alohida `ok`/`error` bilan qaytadi.
    50 tagacha cheklangan.
  - `pro_capability_map` — tabiiy tilidagi vazifani aniq tool nomlari va input schema'lariga
    bog'laydi.
  - `pro_research_deep` — qidiruv → sahifalarni o'qish → faktalar → cross-check → evidence baholash →
    taqdimot, to'liq tadqiqot bitta chaqiruvda.
  - `pro_fetch_ingest` — formatni avtomatik aniqlab har qanday URLni toza ma'lumotga aylantiradi.
  - `pro_audit_page` — bitta sahifani 15+ ekstraksiya bilan bir vaqtda tahlil qiladi.
  - `pro_repo_audit` — repository uchun 15+ GitHub tool'ini bitta chaqiruvda ishga tushiradi.
  - `pro_pr_review` — PR uchun diff, checks, review va inline izohlarni yig'adi.
  - `pro_site_scan` — robots + sitemap + crawl + metadata + link grafigi.
  - `pro_data_pipeline` — datasetni yuklash, profillash va qayta ishlash.
  - `src/core/composite.ts` — pipeline yordamchilari (`runStep`, `renderPipeline`, `urlsFrom`).
  - `tests/smart-system.test.ts` — 17 ta test, jumladan allowlist va xato izolyatsiyasi.

  **O'lchangan foyda:** eski `smart` profilida uch bosqichli tadqiqot uchun 9 round trip kerak edi,
  har biri oldingisining to'g'ri tool nomini taxmin qilishiga bog'liq edi. Endi bir chaqiruv yetadi.

  **Xavfsizlik o'zgarmadi:** har bir ichki chaqiruv `dispatch()` orqali o'tadi, shuning uchun
  `PRO_FETCH_ALLOWED_TOOLS`, `PRO_FETCH_READ_ONLY`, SSRF, output sandbox va timeout qo'llaniladi.

- `PRO_FETCH_ENFORCE_PROFILE` — profilni qat'iy allowlistga aylantiradi. `smart` profil bilan
  birga ishlatilganda aniq konfiguratsiya xatosi beriladi, chunki `smart` meta-executor orqali
  o'z ko'rinmaydigan tool'larni chaqirishga bog'liq.
- `src/core/input.ts` — typed input accessors (`str`, `num`, `bool`, `arr`, `obj`, `pathStr`,
  `pathNum`, `asRecordArray`). `const p = input as any` o'rniga ishlatiladi.
- `src/core/tool-classification.ts` — mutation tasnifining yagona manbai.
- `src/core/profile.ts` — profil qoidalari, import siklisiz modulga ko'chirildi.
- `src/core/version.ts` — versiya `package.json` dan o'qiladi; User-Agent va `serverInfo` endi
  bir manbadan keladi.
- `npm run verify:package` — tarball uchun shebang, `files` allowlist va credential tekshiruvi.
- `npm run format` / `npm run format:check` — Prettier (`.prettierrc.json`).
- `vitest.config.ts` — v8 coverage va minimal chegaralar.
- `.github/workflows/ci.yml` — Node 22.13/24, Ubuntu/Windows matritasi **va Alpine (musl) job'i**:
  native binary'lar olib tashlanganda server boot qilishi, testlar va registry tekshiruvi o'tishi
  majburiy shart.
- `mcp.example.json` — mashinasiz, nisbiy konfiguratsiya namunasi.
- `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.

### Changed

- `any` ishlatilishi 254 → 54 (79% kamaydi). GitHub va extract handler'lari `JsonRow` va
  cheerio `AnyNode` bilan typed bo'ldi; migratsiya paytida 10 ta haqiqiy tip xatosi topildi va
  tuzatildi (`max_pages` raqam emas, `soapaction` string emas, chuqur API field'lari).
- `src/core/max-platform-tools.ts` formatlandi: eng uzun qator 4916 → 310 belgi, 320 → 3294 qator.
- `src/core/research-tools.ts`, `tool.ts`, `config_get.ts`, `health_check.ts`, `repo_info.ts`
  formatlandi.
- `package.json` ga `files` allowlist qo'shildi: tarball 1.9 MB → 868 KB, `.d.ts` 413 → 0.
- `.env.example` ga `PRO_FETCH_BROWSER_CHANNEL`, `PRO_FETCH_BROWSER_TZ` va `<NAME>_FILE` hujjati
  qo'shildi.
- `verify:registry` endi barcha 4 profil o'lchamini ham tekshiradi.
- `.gitignore` kengaytirildi: `.secrets/`, `*.pem`, `*.key`, `mcp.json` va boshqalar.

### Fixed

- **Boshqa OS da server ishga tushmasdi.** `sharp`, `@napi-rs/canvas` va `tesseract.js` statik
  import qilingan edi, ya'ni ular butun registry'ning modul grafigiga kirgan edi. Platformaga
  bog'liq binary qurilmaganda (Alpine/musl, qo'llab-quvvatlanmaydigan glibc, container) `dist/server.js`
  `ERR_MODULE_NOT_FOUND` bilan **butunlay** ishga tushmasdi — 559 tool'idan biri ham ishlamasdi.
  Endi uchala modul ham `await import()` bilan lazy yuklanadi va muvaffaqiyatsiz bo'lsa faqat
  tegishli tool xato beradi. `pro_fetch_diagnostics` endi platforma va binary mavjudligini
  ko'rsatadi. Regressiya testlari: statik import'ni qayta qo'yish `npm test` ni va
  `npm run verify:static` ni fail qiladi.
- **Paket POSIX'da ishga tushmasdi.** `dist/server.js` da shebang yo'q edi; `npx pro-fetch-mcp`
  Linux/macOS'da crash bo'lardi. Endi `#!/usr/bin/env node` qo'shildi va `verify:package` buni
  tekshiradi.
- **User-Agent versiyasi eskirgan edi** (`pro-fetch-mcp/0.2` paket 0.3.0 bo'lganda).
- **Annotatsiya va read-only siyosati mos kelmasdi.** 44 tool yozuvchi deb belgilangan, lekin
  `PRO_FETCH_READ_ONLY` uni bloklamagan; aksincha `cache_tune` va `knowledge_rebuild` read-only
  deb ko'rsatilgan, garchi ular holatni o'zgartiradi — `readOnlyHint` ga ishonadigan klient
  ularni avtomatik tasdiqlagan bo'lardi. Ikkala yo'nalish ham 0 ga tushirildi.
- **Import sikli.** `security-policy` → `loader` → tool index → `core/tool` → `execution-engine` →
  `security-policy`. ESM siklning bir qismini `undefined` ga baholaydi; `boundedEnv is not a
function` va `defineTool is not a function` xatolari shundan edi. `boundedEnv` va profil qoidalari
  alohida leaf modullarga ko'chirildi.
- **`<NAME>_FILE` nisbiy yo'llari ishlamasdi** — server har qanday papkadan ishga tushishi
  mumkin. Endi `package.json` ga nisbatan resolve qilinadi.
- **`.env.example` chetlashuvi** — 3 ta ishlaydigan kalit hujjatlantirilmagan edi.
- **CLI konfiguratsiyasi sizib chiqayotdi** — `mcp.json` da mashina-specifik yo'l va to'liq
  Windows PATH (shaxsiy kataloqlar) bor edi.

### Security

- `.env` dagi inline secretlar endi `verify:static` da tekshirilmaydi (u ataylab API kalitlari
  bilan ishlaydi), lekin `.gitignore`, `files` allowlist va `verify:package` uch qatlamali
  himoya qo'llandi.
- `verify:static` secret patternlari kengaytirildi: Atlassian (`ATATT3`), GitLab (`glpat-`),
  Serper/SerpAPI shakllari qo'shildi.
- Qo'shimcha: qo'lda kiritilgan `mcp.json` endi absolute yo'l yoki host PATH saqlamasligi
  tekshiriladi.

### Known limitations

- `any` ning qolgan 54 ta ishlatilishi tool ichki mantigida (JSON boshqaruvi, cheerio
  selektorlari, `docs` parser'lari) — ular `unknown` ga o'tkazilishi mumkin, lekin alohida
  ishlov talab qiladi.
- `npm audit` da dev-dependency zaxiralari (`vitest<=4.1.10`, `esbuild<=0.24.2`, `tinypool`)
  moderate darajada; faqat test muhitiga taalluqli, `vitest@5` ga o'tish breaking change.
- MAX packlarning live provider integratsiyalari credential va o'rnatilgan CLI talab qiladi.
