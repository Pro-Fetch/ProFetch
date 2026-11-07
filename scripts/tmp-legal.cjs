const fs = require('fs');
const file = 'src/core/search-engines.ts';
let src = fs.readFileSync(file, 'utf8');

const RESALE =
  "Google natijalarini skrabing qilib qayta sotadi. Google o'z shartlarida ham skrabingni, ham olingan " +
  'natijani qayta tarqatishni taqiqlaydi — chaqirish mumkin, lekin biznes poydevori qilish mumkin emas.';

const MAP = {
  serper: ['serp_scraping_reseller', RESALE],
  brave: ['official_api', "Brave o'z indeksini rasman sotadi; qayta sotish uning litsenziyasi bilan belgilanadi."],
  tavily: ['official_api', "O'z indeksining API'sini sotadi; AI ilovalari uchun alohida litsenziya beradi."],
  exa: ['official_api', "Neural indeks — o'zi to'plagan matn ustida ishlaydi; tijorat foydalanishi litsenziyaga bog'liq."],
  serpapi: ['serp_scraping_reseller', RESALE],
  linkup: ['official_api', "O'z indeks/asoslangan javob xizmati; API shartnomasi provaydernikidir."],
  dataforseo: ['serp_scraping_reseller', RESALE],
  googleCse: [
    'official_api',
    "Google'ning o'z rasmiy dasturi (Programmable Search Engine). Google natijasini olishning halol yo'li " +
      'shu: toʻlangan limit, rasmiy javob.',
  ],
  perplexity: ['official_api', "Sonar API — javoblar model tomonidan yigʻiladi; manbalar havola sifatida beriladi."],
  duckduckgo: [
    'undocumented_endpoint',
    "HTML versiyasi bot foydalanishiga mo'ljallanmagan; challenge/200-bo'sh javob beradi. Shu sababli u " +
      "reyestrda yolg'iz qolmaydi: pro_fetch_search_engines uni 'live', lekin 'undocumented' deb ko'rsatadi.",
  ],
  marginalia: [
    'undocumented_endpoint',
    "Ommaga xizmat qiluvchi HTML interfeys; API'si cheklangan. Bizning UA bilan 2 tashqi havola, brauzer " +
      "UA bilan 69 ta qaytadi — ya'ni sayt botlarni cheklamoqda.",
  ],
  searxng: ['self_hosted', "Operator instansiyasi. Orqadagi manbalar kimnikiligi va qanday kelishilganligi sizning tanlovingiz."],
  hackerNews: ['official_api', "HN'ning hujjatlashtirilgan ommaviy API'si (Algolia)."],
  wikipedia: ['official_api', 'MediaWiki API hujjatlashtirilgan va dasturlar uchun mo\'ljallangan.'],
  npm: ['official_api', "npm registry API — paket ma'lumotlari uchun rasman ochiq."],
  itunes: ['official_api', "Apple Search API hujjatlashtirilgan va kalitsiz ruxsat etilgan."],
  openalex: ['official_api', "Ochiq katalog; API hujjatlashtirilgan, kalitsiz limitlar e'lon qilingan."],
  crossref: ['official_api', "Crossref DOI metama'lumoti uchun rasmiy API."],
  arxiv: ['official_api', "Atom API rasmiy; provayder tez so'rovlar uchun kechish so'raydi."],
  pubmed: ['official_api', "NLM E-utilities rasmiy; kalitsiz limit soniyada 3 so'rov atrofida."],
  europePmc: ['official_api', "Europe PMC REST API hujjatlashtirilgan ochiq manba."],
  doaj: ['official_api', "DOAJ API ochiq ma'lumot litsenziyasi ostida."],
  googleNews: [
    'public_feed',
    "RSS — obunachilar uchun nashr qilingan oqim. O'qish kutilgan harakat; moddani katta hajmda qayta " +
      'nashr qilish esa alohida savol, javobini noshir beradi — biz emas.',
  ],
};

let added = 0;
const missing = [];
for (const [key, [legal, terms]] of Object.entries(MAP)) {
  const anchor = new RegExp(`const ${key}: SearchEngine = \\{`);
  const at = src.search(anchor);
  if (at < 0) {
    missing.push(key);
    continue;
  }
  const kindAt = src.indexOf('\n  kind: ', at);
  if (kindAt < 0) {
    missing.push(key + ' (kind)');
    continue;
  }
  const lineEnd = src.indexOf('\n', kindAt + 1);
  const insert = `\n  legal: '${legal}',\n  terms: ${JSON.stringify(terms)},`;
  src = src.slice(0, lineEnd) + insert + src.slice(lineEnd);
  added += 1;
}

fs.writeFileSync(file, src);
console.log('legal qo\'shildi: ' + added + ' ta engine');
if (missing.length) console.log("topilmadi: " + missing.join(', '));
