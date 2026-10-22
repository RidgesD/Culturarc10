"use strict";

/* ============================================================
   PS Store — калькулятор цен
   Источник цен: официальный поисковый API PlayStation Store
   (store.playstation.com/store/api/chihiro/…), CORS открыт.
   Курсы валют: open.er-api.com (бесплатно, CORS открыт).
   ============================================================ */

/* ---------------- Конфигурация ---------------- */

const COUNTRIES = [
  { code: "UA", name: "Украина", in: "Украине", flag: "🇺🇦", lang: "uk", store: "uk-ua", currency: "UAH", divisor: 100 },
  { code: "TR", name: "Турция",  in: "Турции",  flag: "🇹🇷", lang: "tr", store: "tr-tr", currency: "TRY", divisor: 100 },
  { code: "PL", name: "Польша",  in: "Польше",  flag: "🇵🇱", lang: "pl", store: "pl-pl", currency: "PLN", divisor: 100 },
  { code: "US", name: "США",     in: "США",     flag: "🇺🇸", lang: "en", store: "en-us", currency: "USD", divisor: 100 },
  { code: "IN", name: "Индия",   in: "Индии",   flag: "🇮🇳", lang: "en", store: "en-in", currency: "INR", divisor: 1 },
];

const CURRENCY_OPTIONS = ["USD", "EUR", "UAH", "PLN", "TRY", "INR", "RUB"];

/* Служебные слова: поиск в PS Store работает как «ИЛИ» по словам,
   поэтому лишние слова вроде «the» засоряют выдачу. */
const LEADING_ARTICLES = new Set(["the", "a", "an"]);
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "edition", "game",
]);

const RATE_API = "https://open.er-api.com/v6/latest/USD";
const RATE_CACHE_KEY = "pscalc_rates_v1";
const TARGET_CACHE_KEY = "pscalc_target_v1";
const PRICE_HISTORY_KEY = "pscalc_price_history_v1";

/* Запасные CORS-прокси: используются только если прямой запрос не проходит. */
const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://www.whateverorigin.org/get?url=${encodeURIComponent(u)}`,
];

/* ---------------- Состояние ---------------- */

const state = {
  country: COUNTRIES[0],
  results: [],
  selected: null,
  query: "",
  rates: null,
  ratesAt: null,
  ratesStale: false,
  targetCurrency: "USD",
  searchToken: 0,
  compareToken: 0,
  compareFound: {},       // code -> item | null (undefined = ещё грузится)
  compareCache: new Map(),
  pageCache: new Map(),
  productCache: new Map(),   // id -> { ts, data } — точные цены со страницы товара
  priceCheckedAt: null,      // когда последний раз проверили цену выбранной игры
};

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);

const dom = {
  form: $("search-form"),
  input: $("game-input"),
  searchBtn: $("search-btn"),
  countryGrid: $("country-grid"),
  status: $("status"),
  results: $("results"),
  resultsGrid: $("results-grid"),
  resultsCount: $("results-count"),
  detail: $("detail"),
};

/* ---------------- Утилиты ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/* Латинские буквы с диакритикой приводим к простым: «Ragnarök» -> «Ragnarok». */
const DIACRITICS = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ā: "a", ă: "a", ą: "a",
  ç: "c", ć: "c", č: "c", ĉ: "c",
  ď: "d", đ: "d",
  è: "e", é: "e", ê: "e", ë: "e", ē: "e", ĕ: "e", ė: "e", ę: "e",
  ĝ: "g", ğ: "g", ġ: "g",
  ĥ: "h",
  ì: "i", í: "i", î: "i", ï: "i", ī: "i", į: "i", ı: "i",
  ĵ: "j",
  ķ: "k",
  ĺ: "l", ļ: "l", ľ: "l", ł: "l",
  ñ: "n", ń: "n", ņ: "n", ň: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ō: "o", ő: "o", œ: "oe",
  ŕ: "r", ŗ: "r", ř: "r",
  ś: "s", ŝ: "s", ş: "s", š: "s", ș: "s",
  ţ: "t", ť: "t", ŧ: "t", ț: "t",
  ù: "u", ú: "u", û: "u", ü: "u", ū: "u", ů: "u", ű: "u", ų: "u",
  ŵ: "w",
  ý: "y", ÿ: "y", ŷ: "y",
  ź: "z", ż: "z", ž: "z",
  ß: "ss", æ: "ae", ð: "d", þ: "th",
};

function foldDiacritics(str) {
  return String(str || "").replace(/[^\u0000-\u007f]/g, (ch) => DIACRITICS[ch] || ch);
}

function normalize(str) {
  // Сначала в нижний регистр, потом убираем диакритику: «YÖNETMENİN» -> «yonetmenin».
  return foldDiacritics(String(str || "").toLowerCase())
    .replace(/™|®|©/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* Запрос без служебных и «шумных» слов: поиск в PS Store работает как «ИЛИ»
   по словам, поэтому «the», «3», «v» засоряют выдачу. */
function meaningfulTokens(term) {
  const tokens = normalize(term).split(" ").filter(Boolean);
  const filtered = tokens.filter(
    (w) => !STOPWORDS.has(w) && w.length >= 3 && !/^\d+$/.test(w)
  );
  if (filtered.length) return filtered;
  const noStop = tokens.filter((w) => !STOPWORDS.has(w));
  return noStop.length ? noStop : tokens;
}

/* Запрос без ведущих артиклей: «The Witcher 3» -> «Witcher 3» */
function apiQuery(term) {
  const words = String(term || "").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEADING_ARTICLES.has(words[0].toLowerCase())) words.shift();
  return words.join(" ");
}

/* Варианты запроса: сначала исходный без артиклей, затем «очищенный». */
function queryCandidates(term) {
  const original = String(term || "").trim();
  const noArticle = apiQuery(original);
  const clean = meaningfulTokens(term).join(" ");
  const list = [];
  for (const q of [noArticle, clean, original]) {
    if (q && !list.includes(q)) list.push(q);
  }
  // Переименования тайтлов: «fifa 24» -> «fc 24».
  for (const v of aliasVariants(term)) {
    if (v && !list.includes(v)) list.push(v);
  }
  return list;
}

/* Какие значимые слова запроса нашлись в названии игры. */
function tokenMatch(item, term) {
  const key = meaningfulTokens(term);
  const tokens = normalize(item.name)
    .split(" ")
    .concat(normalize(item.title_name).split(" "));
  const set = new Set(tokens);
  const matchWord = (w) =>
    set.has(w) || (w.length >= 4 && tokens.some((t) => t.startsWith(w)));

  const matched = key.filter(matchWord);
  // Переименования: «FIFA 24» в части магазинов называется «EA SPORTS FC 24».
  const aliasMatched = key.filter(
    (w) => !matchWord(w) && (TOKEN_ALIASES[w] || []).some((a) => matchWord(a))
  );

  const nums = numberTokens(term);
  const numberOk =
    !nums.length || nums.some((n) => set.has(n));

  return { key, matched, aliasMatched, nums, numberOk };
}

/* Совпадение по значимым словам: отсекаем мусор, найденный только по цифрам. */
function isRelevant(item, term) {
  const { key, matched, aliasMatched, numberOk } = tokenMatch(item, term);
  if (!key.length) return true;
  if (!numberOk) return false;

  const total = matched.length + aliasMatched.length;
  if (!total) return false;

  // В запросе есть длинные «опознавательные» слова — нужно совпадение хотя бы одного.
  const distinctive = key.filter((w) => w.length >= 5);
  if (
    distinctive.length &&
    !distinctive.some((w) => matched.includes(w) || aliasMatched.includes(w))
  ) {
    return false;
  }

  // Запрос из нескольких слов — нужно совпадение минимум двух.
  return total >= (key.length >= 2 ? 2 : 1);
}

/* Мягкий вариант: подходит игра, если совпало хотя бы одно опознавательное слово. */
function isRelevantLoose(item, term) {
  const { key, matched, aliasMatched } = tokenMatch(item, term);
  if (!key.length) return true;
  const total = matched.length + aliasMatched.length;
  if (!total) return false;
  const distinctive = key.filter((w) => w.length >= 5);
  if (distinctive.length) {
    return distinctive.some((w) => matched.includes(w) || aliasMatched.includes(w));
  }
  return true;
}

/* Ключевые слова запроса без служебных: «The Witcher 3» -> [witcher, 3] */
function coreTokens(term) {
  const tokens = normalize(term).split(" ").filter(Boolean);
  const core = tokens.filter((w) => !STOPWORDS.has(w));
  return core.length ? core : tokens;
}

/* Номера частей из запроса: «fifa 24» -> [24] */
function numberTokens(term) {
  return normalize(term).split(" ").filter((w) => /^\d+$/.test(w));
}

/* Переименования тайтлов между регионами магазина. */
const TOKEN_ALIASES = {
  fifa: ["fc"],
  fc: ["fifa"],
};

/* Варианты запроса с учётом переименований: «fifa 24» -> «fc 24». */
function aliasVariants(term) {
  const words = coreTokens(term);
  const out = new Set([words.join(" ")]);
  for (const w of words) {
    for (const alt of TOKEN_ALIASES[w] || []) {
      out.add(words.map((x) => (x === w ? alt : x)).join(" "));
    }
  }
  return [...out];
}

/* ---------------- Сетевые запросы ---------------- */

/* Один запрос с таймаутом. */
async function fetchJsonOnce(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("неожиданный формат ответа");
    }
    // whateverorigin оборачивает ответ в { contents: "..." }
    if (data && typeof data === "object" && typeof data.contents === "string") {
      try {
        data = JSON.parse(data.contents);
      } catch { /* оставляем как есть */ }
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* Прямой запрос с повторами; если совсем не выходит — пробуем прокси. */
async function fetchWithFallback(url, validate, { attempts = 2, timeout = 9000, proxies = true } = {}) {
  let lastError = null;
  let lastData = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const data = await fetchJsonOnce(url, timeout);
      lastData = data;
      if (!validate || validate(data)) return data;
      lastError = new Error("пустой ответ");
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await sleep(600 * (i + 1));
  }

  if (proxies) {
    for (const wrap of PROXIES) {
      try {
        const data = await fetchJsonOnce(wrap(url), 6000);
        lastData = data;
        if (!validate || validate(data)) return data;
      } catch (err) {
        lastError = err;
      }
    }
  }

  // Ответ был, но не прошёл проверку — отдаём его как есть (например, пустая выдача).
  if (lastData) return lastData;
  throw lastError || new Error("сетевой сбой");
}

function searchUrl(country, term, start) {
  return (
    "https://store.playstation.com/store/api/chihiro/00_09_000/search/" +
    `${country.code}/${country.lang}/999/${encodeURIComponent(term)}` +
    `?suggestedSize=20&mode=game&start=${start}`
  );
}

async function searchPage(country, term, start) {
  const key = `${country.code}|${term.toLowerCase()}|${start}`;
  const hit = state.pageCache.get(key);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.data;

  const url = searchUrl(country, term, start);
  // Пустая выдача у PS Store бывает и из-за временной блокировки — делаем повторы.
  const data = await fetchWithFallback(url, (d) => typeof d.total_results === "number", {
    attempts: 2,
    timeout: 9000,
  });

  state.pageCache.set(key, { ts: Date.now(), data });
  return data;
}

/* Поиск игры: перебираем варианты запроса, пока не найдём уверенное совпадение. */
async function searchBest(country, term) {
  const candidates = queryCandidates(term);
  let games = [];

  for (const query of candidates) {
    let data;
    try {
      data = await searchPage(country, query, 0);
    } catch {
      continue;
    }

    let page = dedupe(pickGames(data));
    const strong = () => rankGames(page, term).filter((r) => r.score >= 2000).length;

    if (strong() === 0 && data.total_results > 20) {
      try {
        const p2 = await searchPage(country, query, 20);
        page = dedupe(page.concat(pickGames(p2)));
      } catch { /* страницу можно пропустить */ }
    }
    if (strong() === 0 && page.length < 3 && data.total_results > 40) {
      try {
        const p3 = await searchPage(country, query, 40);
        page = dedupe(page.concat(pickGames(p3)));
      } catch { /* страницу можно пропустить */ }
    }

    games = dedupe(games.concat(page));
    if (rankGames(games, term).some((r) => r.score >= 2000)) break;
  }

  return games;
}

/* ---------------- Курсы валют ---------------- */

function readRatesCache() {
  try {
    const raw = localStorage.getItem(RATE_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached && cached.data ? cached : null;
  } catch {
    return null;
  }
}

async function loadRates({ force = false } = {}) {
  const cached = readRatesCache();
  const fresh = cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000;

  if (fresh && !force) {
    state.rates = cached.data.rates;
    state.ratesAt = cached.data.time_last_update_utc || new Date(cached.ts).toISOString();
    state.ratesStale = false;
    return true;
  }

  try {
    const data = await fetchWithFallback(
      RATE_API,
      (d) => d && d.result === "success" && d.rates && d.rates.UAH && d.rates.INR,
      { attempts: 2, timeout: 10000 }
    );
    state.rates = data.rates;
    state.ratesAt = data.time_last_update_utc || new Date().toISOString();
    state.ratesStale = false;
    try {
      localStorage.setItem(RATE_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* приватный режим — просто не кэшируем */ }
    return true;
  } catch (err) {
    // Последний шанс — устаревший кэш (до 7 дней)
    if (cached && Date.now() - cached.ts < 7 * 24 * 60 * 60 * 1000) {
      state.rates = cached.data.rates;
      state.ratesAt = cached.data.time_last_update_utc || new Date(cached.ts).toISOString();
      state.ratesStale = true;
      return true;
    }
    state.rates = null;
    state.ratesAt = null;
    return false;
  }
}

function convert(units, from, to) {
  if (!state.rates) return null;
  if (units === null || units === undefined || Number.isNaN(units)) return null;
  if (from === to) return units;
  const rf = state.rates[from];
  const rt = state.rates[to];
  if (!rf || !rt) return null;
  return (units / rf) * rt;
}

function fmtMoney(value, currency) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency", currency, maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function ratesDate() {
  if (!state.ratesAt) return "";
  const d = new Date(state.ratesAt);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ru-RU");
}

/* ---------------- Работа с товарами PlayStation ---------------- */

function pickGames(data) {
  return (data.links || []).filter((it) => it.top_category === "downloadable_game");
}

/* ---------------- Точная цена со страницы товара ---------------- */

/* В поисковой выдаче у части товаров цены нет (или она устарела), поэтому
   цену дополнительно берём со страницы самого товара. */
function apiProductUrl(country, item) {
  return (
    "https://store.playstation.com/store/api/chihiro/00_09_000/container/" +
    `${country.code}/${country.lang}/999/${encodeURIComponent(item.id)}`
  );
}

async function fetchProduct(country, item, { fresh = false } = {}) {
  if (!item || !item.id) return null;

  const key = `${country.code}|${item.id}`;
  const hit = state.productCache.get(key);
  if (!fresh && hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;

  let data = null;
  try {
    data = await fetchWithFallback(
      apiProductUrl(country, item),
      (d) => d && (d.id || d.default_sku),
      { attempts: 2, timeout: 9000 }
    );
  } catch {
    data = null;
  }

  state.productCache.set(key, { ts: Date.now(), data });
  return data;
}

/* Достаём цену из ответа карточки: сначала основной SKU, затем любой с ценой. */
function skuOf(product) {
  if (!product) return null;
  if (product.default_sku && typeof product.default_sku.price === "number") {
    return product.default_sku;
  }
  const list = product.skus || [];
  const found = list.find((s) => s && typeof s.price === "number");
  return found || null;
}

/* Обновляем цену товара из карточки (значения в minor-единицах). */
function applyProductPrice(item, product) {
  const sku = skuOf(product);
  if (!sku) return false;
  const prev = item.default_sku;
  if (prev && prev.price === sku.price) return false;
  item.default_sku = {
    ...sku,
    display_price: sku.display_price || (prev ? prev.display_price : undefined),
  };
  return true;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

/* Оценка релевантности: чем больше совпадений с ключевыми словами — тем выше. */
function rankGames(games, term) {
  const q = normalize(term);
  const words = coreTokens(term);
  const coreJoined = words.join(" ");
  const variants = aliasVariants(term).filter((v) => v && v !== q);

  return games
    .map((item, idx) => {
      const name = normalize(item.name);
      const title = normalize(item.title_name);
      let s = 0;

      if (name === q || title === q) s += 10000;
      else if (name.startsWith(q) || title.startsWith(q)) s += 5000;
      if (name.includes(q) || title.includes(q)) s += 3000;
      if (coreJoined && (name.includes(coreJoined) || title.includes(coreJoined))) s += 2500;

      // Переименованные версии запроса: «fifa 24» -> «fc 24».
      for (const v of variants) {
        if (name.includes(v) || title.includes(v)) s += 2800;
      }

      for (const w of words) {
        if (name.split(" ").includes(w)) s += 300;
        else if (name.includes(w)) s += 150;
        if (title.includes(w)) s += 120;
      }

      const types = item.gameContentTypesList || [];
      if (types.some((t) => t.key === "FULL_GAME")) s += 90;
      if (item.game_contentType === "Bundle") s += 45;
      if (item.default_sku && typeof item.default_sku.price === "number") s += 60; // товар реально продаётся
      s += Math.max(0, 30 - idx); // сохраняем порядок выдачи при равных оценках

      return { item, score: s };
    })
    .sort((a, b) => b.score - a.score);
}

/* Насколько похожи два товара одного тайтла: общий префикс id + совпадение названия. */
function siblingScore(item, cand) {
  const a = String(item.id || "");
  const b = String(cand.id || "");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let score = i;
  const ta = normalize(item.title_name || item.name);
  const tb = normalize(cand.title_name || cand.name);
  if (ta && ta === tb) score += 20;
  return score;
}

/* Выбираем среди одноимённых товаров тот, у которого есть цена и который
   больше всего похож на исходный (обычно та же редакция в другом регионе). */
function pickSibling(candidates, item, { paidOnly = false } = {}) {
  if (!candidates || !item) return null;
  const prefix = idPrefix(item.id);
  const title = normalize(item.title_name || item.name);

  let best = null;
  let bestScore = -1;

  for (const cand of candidates) {
    if (cand === item) continue;
    if (!cand.default_sku || typeof cand.default_sku.price !== "number") continue;
    if (paidOnly && cand.default_sku.price === 0) continue;
    const samePrefix = !!(prefix && idPrefix(cand.id) === prefix);
    const sameTitle = !!title && normalize(cand.title_name || cand.name) === title;
    if (!samePrefix && !sameTitle) continue;
    const s = siblingScore(item, cand);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}

/* Если сама игра в этой стране не продаётся — ищем одноимённую редакцию
   с ценой (одна и та же игра часто продаётся несколькими товарами). */
function siblingWithPrice(item, country, paidOnly = false) {
  if (country.code !== state.country.code) return null;
  const pool = state.results || [];
  if (!pool.length) return null;

  const alt = pickSibling(pool, item, { paidOnly });
  return alt ? alt.default_sku : null;
}

/* Товар с нулевой ценой и требованием подписки (PS Plus): по сути бесплатная
   версия игры, а обычное издание продаётся отдельно. */
function isSubscriptionFree(item) {
  const sku = item && item.default_sku;
  if (!sku || sku.price !== 0) return false;
  return Array.isArray(sku.eligibilities) && sku.eligibilities.length > 0;
}

function priceOf(item, country) {
  const sku = item.default_sku;
  if (!sku || typeof sku.price !== "number") {
    // Товар есть в каталоге, но в этой стране он не продаётся.
    const sibling = siblingWithPrice(item, country);
    if (sibling) {
      const units = sibling.price / country.divisor;
      return {
        raw: sibling.price,
        units,
        free: sibling.price === 0,
        unknown: false,
        sibling: true,
        sub: false,
        display: sibling.display_price || fmtMoney(units, country.currency),
      };
    }
    return { raw: null, units: null, free: false, unknown: true, sibling: false, sub: false, display: "Нет в продаже" };
  }

  const raw = sku.price;
  const units = raw / country.divisor;
  const free = raw === 0;

  if (free) {
    // Версия «бесплатно» по подписке — показываем цену обычного издания.
    if (isSubscriptionFree(item)) {
      const paid = siblingWithPrice(item, country, true);
      if (paid) {
        const paidUnits = paid.price / country.divisor;
        return {
          raw: paid.price,
          units: paidUnits,
          free: false,
          unknown: false,
          sibling: true,
          sub: true,
          display: paid.display_price || fmtMoney(paidUnits, country.currency),
        };
      }
    }
    return { raw, units, free: true, unknown: false, sibling: false, sub: false, display: "Бесплатно" };
  }

  const display = sku.display_price || fmtMoney(units, country.currency);
  return { raw, units, free: false, unknown: false, sibling: false, sub: false, display };
}

function pickImage(item) {
  const imgs = item.images || [];
  const byType = (t) => imgs.find((im) => Number(im.type) === t);
  const found = byType(10) || byType(9) || byType(1) || byType(12) || byType(2) || imgs[0];
  return found ? found.url : "";
}

function productUrl(item, country) {
  return `https://store.playstation.com/${country.store}/product/${encodeURIComponent(item.id)}`;
}

function chipsFor(item) {
  const out = [];
  for (const p of item.playable_platform || []) out.push(p);
  if (item.release_date) out.push(item.release_date.slice(0, 4));
  if (item.game_contentType) out.push(item.game_contentType);
  return out;
}

/* ---------------- История цен ---------------- */

/* Локальная история: для каждого товара помним последние значения цены,
   чтобы видеть, когда и на сколько цена изменилась. */
let priceHistoryCache = null;

function readPriceHistory() {
  if (priceHistoryCache) return priceHistoryCache;
  try {
    const raw = localStorage.getItem(PRICE_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    priceHistoryCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    priceHistoryCache = {};
  }
  return priceHistoryCache;
}

function writePriceHistory(history) {
  priceHistoryCache = history;
  try {
    localStorage.setItem(PRICE_HISTORY_KEY, JSON.stringify(history));
  } catch { /* приватный режим */ }
}

function recordPrice(country, item, price) {
  const history = readPriceHistory();
  const key = `${country.code}|${item.id}`;
  const now = Date.now();
  const prev = history[key];

  if (!prev) {
    history[key] = { price, at: now, name: item.name, changes: [] };
  } else if (prev.price !== price) {
    history[key] = {
      price,
      at: now,
      name: item.name,
      changes: [...(prev.changes || []), { from: prev.price, to: price, at: now }].slice(-20),
    };
  } else {
    history[key] = { ...prev, price, seen: now, name: item.name };
  }

  writePriceHistory(history);
  return history[key];
}

function priceHistoryFor(country, item) {
  return readPriceHistory()[`${country.code}|${item.id}`] || null;
}

function fmtDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/* ---------------- Статусы ---------------- */

function showStatus(kind, html, withRetry = false) {
  dom.status.className = "status " + (kind === "error" ? "error" : "");
  dom.status.classList.remove("hidden");
  dom.status.innerHTML = html;
  if (withRetry) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Повторить";
    btn.addEventListener("click", () => doSearch());
    dom.status.appendChild(document.createElement("br"));
    dom.status.appendChild(btn);
  }
}

function hideStatus() {
  dom.status.classList.add("hidden");
  dom.status.innerHTML = "";
}

function setLoading(loading) {
  dom.searchBtn.disabled = loading;
  dom.input.disabled = loading;
}

/* Подпись под ценой в карточке: когда проверено, какая редакция, менялась ли цена. */
function cardTimeText(item, p) {
  const parts = [];
  const cache = state.productCache.get(`${state.country.code}|${item.id}`);
  if (cache) parts.push(`проверено ${fmtDateTime(cache.ts)}`);
  if (p && p.sub) parts.push("бесплатно по подписке");
  else if (p && p.sibling) parts.push("другая редакция");
  if (item.priceChanged) parts.push("цена изменилась");
  else {
    // Показываем и недавнее изменение цены, зафиксированное при прошлых проверках.
    const hist = priceHistoryFor(state.country, item);
    const changes = hist && hist.changes ? hist.changes : [];
    const last = changes[changes.length - 1];
    if (last && Date.now() - last.at < 14 * 24 * 60 * 60 * 1000) {
      parts.push(
        `было ${fmtMoney(last.from / state.country.divisor, state.country.currency)}`
      );
    }
  }
  return parts.join(" · ");
}

/* ---------------- Рендер результатов ---------------- */

function renderResults(items) {
  dom.resultsCount.textContent = `${items.length} ${plural(items.length, "игра", "игры", "игр")}`;
  dom.resultsGrid.innerHTML = items
    .map((item, idx) => {
      const p = priceOf(item, state.country);
      const img = pickImage(item);
      const chips = chipsFor(item)
        .slice(0, 4)
        .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
        .join("");
      const cover = img
        ? `<img class="card-img" src="${escapeHtml(img)}" alt="" loading="lazy">`
        : `<div class="card-img" style="display:grid;place-items:center;font-size:52px">🎮</div>`;
      return `
        <article class="card" data-idx="${idx}" tabindex="0" role="button"
                 aria-label="${escapeHtml(item.name)} — ${escapeHtml(p.display)}">
          ${cover}
          <div class="card-body">
            <h3 class="card-title">${escapeHtml(item.name)}</h3>
            <div class="card-meta">${chips}</div>
            <div class="card-price${p.free ? " free" : ""}${p.unknown ? " unknown" : ""}">${escapeHtml(p.display)}</div>
            <div class="card-time${p.sibling ? " changed" : ""}" data-time-idx="${idx}">${escapeHtml(cardTimeText(item, p))}</div>
          </div>
        </article>`;
    })
    .join("");
  dom.results.classList.remove("hidden");
}

/* Обновляем цену и отметку времени прямо в карточке, без перерисовки списка. */
function updateCard(item) {
  const idx = state.results.indexOf(item);
  if (idx < 0) return;
  const card = dom.resultsGrid.querySelector(`.card[data-idx="${idx}"]`);
  if (!card) return;

  const p = priceOf(item, state.country);
  const priceEl = card.querySelector(".card-price");
  if (priceEl) {
    priceEl.textContent = p.display;
    priceEl.className =
      "card-price" + (p.free ? " free" : "") + (p.unknown ? " unknown" : "");
  }

  const timeEl = card.querySelector(".card-time");
  if (timeEl) {
    const text = cardTimeText(item, p);
    timeEl.textContent = text;
    timeEl.classList.toggle("changed", !!item.priceChanged || !!p.sibling);
  }
}

/* Подтягиваем точные цены со страниц товаров (в выдаче цена есть не всегда). */
async function hydratePrices(items, country, token) {
  const queue = items.slice(0, 20);

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (token !== state.searchToken) return;

      const product = await fetchProduct(country, item);
      if (token !== state.searchToken) return;

      const sku = skuOf(product);
      if (sku) {
        const before =
          item.default_sku && typeof item.default_sku.price === "number"
            ? item.default_sku.price
            : null;
        applyProductPrice(item, product);
        recordPrice(country, item, sku.price);
        if (before !== null && before !== sku.price) item.priceChanged = true;
      }

      updateCard(item);

      if (state.selected && state.selected.id === item.id) {
        state.priceCheckedAt = Date.now();
        renderDetailKeepCompare(state.selected);
      }
    }
  };

  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ---------------- Карточка выбранной игры ---------------- */

function renderDetail(item) {
  state.selected = item;
  const c = state.country;
  const p = priceOf(item, c);
  const img = pickImage(item);
  const link = productUrl(item, c);
  const chips = chipsFor(item)
    .map((ch) => `<span class="chip">${escapeHtml(ch)}</span>`)
    .join("");
  const publisher = item.provider_name
    ? `<div class="price-note">Издатель: ${escapeHtml(item.provider_name)}</div>` : "";

  const cover = img
    ? `<img class="detail-cover" src="${escapeHtml(img)}" alt="${escapeHtml(item.name)}">`
    : `<div class="detail-cover" style="display:grid;place-items:center;font-size:64px">🎮</div>`;

  dom.detail.innerHTML = `
    <div class="detail-grid">
      ${cover}
      <div class="detail-info">
        <h2 class="detail-title">${escapeHtml(item.name)}</h2>
        <div class="detail-meta">${chips}</div>
        ${publisher}

        <div class="price-block">
          <div class="price-label">Цена в ${c.flag} ${escapeHtml(c.in)} · ${c.currency}</div>
          <div class="price-main${p.free ? " free" : ""}${p.unknown ? " unknown" : ""}">${escapeHtml(p.display)}</div>
          <div class="price-sub" id="price-sub"></div>
          <div class="price-note" id="rate-note"></div>
          <div class="price-fresh">
            <span class="price-note" id="price-check">Цена проверяется…</span>
            <button class="btn btn-ghost btn-sm" type="button" id="refresh-price">Обновить цену</button>
          </div>
          <div class="price-history" id="price-history" hidden></div>
          <div class="convert-row">
            <label for="target-currency" class="price-label" style="margin:0">Показать цену в:</label>
            <select id="target-currency" aria-label="Валюта пересчёта">
              ${CURRENCY_OPTIONS.map((cur) =>
                `<option value="${cur}"${cur === state.targetCurrency ? " selected" : ""}>${cur}</option>`
              ).join("")}
            </select>
          </div>
        </div>

        <div class="detail-actions">
          <a class="btn" href="${escapeHtml(link)}" target="_blank" rel="noopener">Открыть в PlayStation Store ↗</a>
          <button class="btn btn-ghost" type="button" id="compare-btn">Сравнить цены во всех странах</button>
        </div>

        <div class="compare" id="compare" hidden>
          <div class="compare-head">
            <h3>Цены по странам</h3>
            <span class="price-note" id="compare-note"></span>
          </div>
          <table class="compare-table">
            <thead>
              <tr>
                <th>Страна</th>
                <th>Местная цена</th>
                <th id="compare-currency-label"></th>
                <th>Разница</th>
              </tr>
            </thead>
            <tbody id="compare-body"></tbody>
          </table>
        </div>
      </div>
    </div>`;

  dom.detail.classList.remove("hidden");

  $("target-currency").addEventListener("change", (e) => {
    state.targetCurrency = e.target.value;
    try { localStorage.setItem(TARGET_CACHE_KEY, state.targetCurrency); } catch { /* ignore */ }
    updateConverted();
    if (Object.keys(state.compareFound).length) renderCompareRows(state.compareFound);
  });

  $("compare-btn").addEventListener("click", runCompare);

  const refreshBtn = $("refresh-price");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshDetailPrice);

  renderPriceMeta();
  updateConverted();
}

/* Перерисовываем карточку игры, не теряя открытую таблицу сравнения. */
function renderDetailKeepCompare(item) {
  const hadCompare = Object.keys(state.compareFound || {}).length > 0;
  renderDetail(item);
  if (!hadCompare) return;

  const wrap = $("compare");
  if (wrap) wrap.hidden = false;
  renderCompareRows(state.compareFound);
  const note = $("compare-note");
  if (note) note.textContent = "Цены перепроверены на страницах товаров";
}

/* Отметка времени проверки цены и история изменений. */
function renderPriceMeta() {
  const checkEl = $("price-check");
  const histEl = $("price-history");
  const item = state.selected;
  if (!checkEl || !item) return;

  const c = state.country;
  const cache = state.productCache.get(`${c.code}|${item.id}`);
  const checkedAt = cache ? cache.ts : state.priceCheckedAt;
  const p = priceOf(item, c);
  const tail = p.sub ? " · бесплатно по подписке" : (p.sibling ? " · другая редакция" : "");

  checkEl.textContent = checkedAt
    ? `Цена проверена на сайте: ${fmtDateTime(checkedAt)}${tail}`
    : `Цена ещё не проверена на странице товара${tail}`;

  if (!histEl) return;
  const hist = priceHistoryFor(c, item);
  const changes = hist && hist.changes ? hist.changes : [];

  if (!changes.length) {
    histEl.hidden = true;
    histEl.innerHTML = "";
    return;
  }

  const rows = changes
    .slice(-5)
    .reverse()
    .map((ch, i) => `
      <li class="${i === 0 ? "latest" : ""}">
        <span class="hist-values">${escapeHtml(fmtMoney(ch.from / c.divisor, c.currency))} → ${escapeHtml(fmtMoney(ch.to / c.divisor, c.currency))}</span>
        <span class="hist-when">${escapeHtml(fmtDateTime(ch.at))}</span>
      </li>`)
    .join("");

  histEl.hidden = false;
  histEl.innerHTML = `
    <div class="price-note">История изменений цены (${changes.length})</div>
    <ul class="hist-list">${rows}</ul>`;
}

/* Принудительно перепроверяем цену выбранной игры на странице товара. */
async function refreshDetailPrice() {
  const item = state.selected;
  if (!item) return;

  const c = state.country;
  const btn = $("refresh-price");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Проверяем…";
  }

  try {
    const product = await fetchProduct(c, item, { fresh: true });
    const sku = skuOf(product);
    if (sku) {
      applyProductPrice(item, product);
      recordPrice(c, item, sku.price);
    }
    state.priceCheckedAt = Date.now();
    renderDetailKeepCompare(item);
  } catch {
    /* цена не изменилась — покажем прежнее значение */
  } finally {
    const b = $("refresh-price");
    if (b) {
      b.disabled = false;
      b.textContent = "Обновить цену";
    }
  }
}

function updateConverted() {
  const sub = $("price-sub");
  const note = $("rate-note");
  if (!sub || !state.selected) return;

  const c = state.country;
  const p = priceOf(state.selected, c);

  if (p.unknown) {
    sub.textContent = "В этом регионе игра не продаётся.";
  } else if (p.free) {
    sub.textContent = "Игра бесплатна — покупать нечего 🙂";
  } else {
    const v = state.rates ? convert(p.units, c.currency, state.targetCurrency) : null;
    const tail = v === null
      ? `пересчёт в ${state.targetCurrency} недоступен`
      : `≈ ${fmtMoney(v, state.targetCurrency)}`;
    if (p.sub) {
      sub.textContent = `Эта версия бесплатна по подписке, обычное издание: ${tail}`;
    } else if (p.sibling) {
      sub.textContent = `Цена другой редакции игры в ${c.in}. ${tail}`;
    } else {
      sub.textContent = tail;
    }
  }

  let text = "";
  if (state.rates) {
    const usd = state.rates.USD;
    const per = state.rates[c.currency];
    if (usd && per) {
      text = `1 ${c.currency} = ${(1 / per).toFixed(4)} USD · курсы на ${ratesDate()}`;
    } else {
      text = `Курсы валют на ${ratesDate()}`;
    }
    if (state.ratesStale) text += " (последнее сохранённое значение)";
  } else {
    text = "Курсы валют временно недоступны — показана только местная цена.";
  }
  note.textContent = text;
}

/* ---------------- Сравнение стран ---------------- */

/* Префикс идентификатора продукта (например EP4497) — одинаков для одного
   тайтла в разных странах, даже если название переведено. */
function idPrefix(id) {
  const m = String(id || "").match(/^[A-Z]{2}(\d{3,6})-/);
  return m ? m[1] : "";
}

/* Доля совпадающих слов двух названий. */
function tokenOverlap(a, b) {
  const ta = normalize(a).split(" ").filter(Boolean);
  const tb = new Set(normalize(b).split(" ").filter(Boolean));
  if (!ta.length) return 0;
  return ta.filter((w) => tb.has(w)).length / ta.length;
}

/* Ищем ту же игру среди результатов поиска в другой стране. */
function findMatch(games, selected) {
  if (!games.length || !selected) return null;

  const source = selected.title_name || selected.name;
  const targetName = normalize(selected.name);
  const targetTitle = normalize(selected.title_name);
  const prefix = idPrefix(selected.id);

  const exact = games.find(
    (it) => normalize(it.name) === targetName || normalize(it.title_name) === targetTitle
  );
  if (exact) return exact;

  let best = null;
  let bestScore = -1;
  let bestOverlap = 0;
  let bestPrefix = false;

  for (const it of games) {
    const titleOverlap = tokenOverlap(source, it.title_name);
    const nameOverlap = tokenOverlap(source, it.name);
    const samePrefix = !!(prefix && idPrefix(it.id) === prefix);

    let s = titleOverlap * 2000 + nameOverlap * 900;
    if (samePrefix) s += 1400;
    if (it.default_sku && typeof it.default_sku.price === "number") s += 60;

    if (s > bestScore) {
      bestScore = s;
      best = it;
      bestOverlap = Math.max(titleOverlap, nameOverlap);
      bestPrefix = samePrefix;
    }
  }

  if (!best) return null;
  if (bestOverlap >= 0.75) return best;
  if (bestPrefix && bestOverlap >= 0.45) return best;
  return null;
}

/* Одноимённая редакция с ценой — среди результатов поиска этой же страны. */
function findPricedSibling(games, item) {
  return pickSibling(games, item, { paidOnly: true });
}

async function matchInCountry(country, selected) {
  const cacheKey = `${country.code}|${selected.id}`;
  if (state.compareCache.has(cacheKey)) return state.compareCache.get(cacheKey);

  const queries = [];
  for (const src of [selected.title_name, selected.name]) {
    for (const q of queryCandidates(src)) {
      if (q && !queries.includes(q)) queries.push(q);
    }
  }

  let result = null;
  for (const query of queries.slice(0, 4)) {
    try {
      const data = await searchPage(country, query, 0);
      let games = pickGames(data);
      result = findMatch(games, selected);
      if (!result && data.total_results > 20) {
        const page2 = await searchPage(country, query, 20);
        games = games.concat(pickGames(page2));
        result = findMatch(games, selected);
      }
      // У найденного товара может не быть цены (или она нулевая — версия по
      // подписке): берём цену обычного издания среди одноимённых товаров.
      const noPrice = !result.default_sku || typeof result.default_sku.price !== "number";
      if (result && (noPrice || isSubscriptionFree(result))) {
        const alt = findPricedSibling(games, result);
        if (alt && (noPrice || alt.default_sku.price > 0)) {
          alt.siblingPrice = true;
          result = alt;
        }
      }
    } catch {
      result = null;
    }
    if (result) break;
  }

  state.compareCache.set(cacheKey, result);
  return result;
}

function renderCompareRows(found) {
  const tbody = $("compare-body");
  if (!tbody) return;
  const label = $("compare-currency-label");
  if (label) label.textContent = `В ${state.targetCurrency}`;

  const rows = COUNTRIES.map((c) => ({ c, item: found[c.code] }));

  const values = rows.map((r) => {
    if (r.item === null || r.item === undefined) return null;
    const p = priceOf(r.item, r.c);
    return convert(p.units, r.c.currency, state.targetCurrency);
  });
  const numbers = values.filter((v) => typeof v === "number");
  const min = numbers.length ? Math.min(...numbers) : null;

  tbody.innerHTML = rows
    .map((r, i) => {
      const cls = ["c-country"];
      let rowCls = "";
      if (r.c.code === state.country.code) rowCls = "current";

      let priceCell, convCell, diffCell = "";

      if (r.item === undefined) {
        priceCell = `<span class="cell-loading"><span class="spinner" style="width:13px;height:13px;border-width:2px;margin:0"></span>ищем…</span>`;
        convCell = "—";
      } else if (r.item === null) {
        priceCell = `<span class="cell-loading">не найдено</span>`;
        convCell = "—";
        rowCls = "notfound";
      } else {
        const p = priceOf(r.item, r.c);
        priceCell = p.unknown
          ? `<span class="cell-loading">${escapeHtml(p.display)}</span>`
          : `<span class="${p.free ? "" : "c-price"}">${escapeHtml(p.display)}</span>`;
        const cache = state.productCache.get(`${r.c.code}|${r.item.id}`);
        if (cache) {
          priceCell += `<div class="cell-time">проверено ${escapeHtml(fmtDateTime(cache.ts))}</div>`;
        }
        if (r.item.siblingPrice) {
          priceCell += `<div class="cell-time">другая редакция</div>`;
        }
        const v = values[i];
        convCell = v === null ? "—" : fmtMoney(v, state.targetCurrency);
        if (v !== null && min !== null && v === min) {
          rowCls += " cheapest";
          diffCell = `<span class="badge-best">выгодно</span>`;
        } else if (v !== null && min !== null && min > 0) {
          const pct = Math.round(((v - min) / min) * 100);
          diffCell = `+${pct}%`;
        } else {
          diffCell = "—";
        }
      }

      return `
        <tr class="${rowCls.trim()}">
          <td class="${cls.join(" ")}"><span class="flag">${r.c.flag}</span>${escapeHtml(r.c.name)}</td>
          <td>${priceCell}</td>
          <td class="c-conv">${convCell}</td>
          <td class="c-diff">${diffCell}</td>
        </tr>`;
    })
    .join("");
}

async function hydrateComparePrices(token) {
  const pairs = COUNTRIES
    .map((c) => ({ c, item: state.compareFound[c.code] }))
    .filter((p) => p.item);

  await Promise.all(
    pairs.map(async ({ c, item }) => {
      const product = await fetchProduct(c, item);
      const sku = skuOf(product);
      if (sku) {
        applyProductPrice(item, product);
        recordPrice(c, item, sku.price);
      }
      if (token === state.compareToken) renderCompareRows(state.compareFound);
    })
  );
}

async function runCompare() {
  const sel = state.selected;
  if (!sel) return;

  const wrap = $("compare");
  const btn = $("compare-btn");
  const note = $("compare-note");
  if (!wrap || !btn) return;

  wrap.hidden = false;
  const token = ++state.compareToken;
  state.compareFound = {};

  const initial = {};
  for (const c of COUNTRIES) initial[c.code] = c.code === state.country.code ? sel : undefined;
  state.compareFound = initial;
  renderCompareRows(initial);

  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = "Сравниваю…";

  try {
    await loadRates();
    let done = 0;

    for (const c of COUNTRIES) {
      if (token !== state.compareToken) return;
      if (c.code !== state.country.code) {
        const match = await matchInCountry(c, sel);
        state.compareFound[c.code] = match;
        done++;
        renderCompareRows(state.compareFound);
        note.textContent = `Обработано ${done} из ${COUNTRIES.length - 1} стран…`;
        await sleep(250);
      }
    }

    if (token !== state.compareToken) return;
    renderCompareRows(state.compareFound);
    const foundCount = COUNTRIES.filter((c) => state.compareFound[c.code]).length;
    note.textContent = state.rates
      ? `Найдено в ${foundCount} из ${COUNTRIES.length} стран · курсы на ${ratesDate()}`
      : "Курсы валют недоступны — пересчёт не показан";

    // Точные цены со страниц товаров для всех найденных стран.
    await hydrateComparePrices(token);
  } finally {
    if (token === state.compareToken) {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }
}

/* ---------------- Поиск ---------------- */

async function doSearch(termOverride) {
  const term = String(termOverride ?? dom.input.value).trim();
  if (!term) {
    showStatus("error", "Введите название игры.");
    dom.input.focus();
    return;
  }

  dom.input.value = term;
  state.query = term;
  const token = ++state.searchToken;

  setLoading(true);
  dom.results.classList.add("hidden");
  dom.detail.classList.add("hidden");
  state.selected = null;
  state.compareFound = {};
  showStatus("", `<span class="spinner"></span>Ищем «${escapeHtml(term)}» в ${state.country.flag} ${escapeHtml(state.country.in)}…`);

  try {
    const c = state.country;
    const games = await searchBest(c, term);

    if (token !== state.searchToken) return;

    const ranked = rankGames(games, term);
    const strict = ranked.filter((r) => isRelevant(r.item, term));
    const loose = ranked.filter((r) => isRelevantLoose(r.item, term));
    // Сначала — точные совпадения, затем — более мягкие. Мусор вроде «Wild Arms 3»
    // на запрос «The Witcher 3» отсекается полностью.
    const pool = (strict.length ? strict : loose).map((r) => r.item).slice(0, 40);
    state.results = pool;

    if (!pool.length) {
      state.results = [];
      showStatus(
        "empty",
        `По запросу «${escapeHtml(term)}» в ${escapeHtml(c.in)} ничего не найдено.<br>
         Проверьте название или попробуйте другую страну — в некоторых регионах игры не продаются.`
      );
      return;
    }

    hideStatus();
    renderResults(pool);
    // Подтягиваем точные цены со страниц товаров — в выдаче цена есть не всегда.
    void hydratePrices(pool, c, token);
  } catch (err) {
    if (token !== state.searchToken) return;
    showStatus(
      "error",
      `Не удалось загрузить данные PlayStation Store (${escapeHtml(err.message)}).<br>
       Подождите пару секунд и попробуйте ещё раз.`,
      true
    );
  } finally {
    if (token === state.searchToken) setLoading(false);
  }
}

/* ---------------- Выбор игры ---------------- */

function selectResult(idx) {
  const item = state.results[idx];
  if (!item) return;

  for (const card of dom.resultsGrid.querySelectorAll(".card")) {
    card.classList.toggle("selected", Number(card.dataset.idx) === idx);
  }

  renderDetail(item);
  dom.detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- Инициализация ---------------- */

function buildCountryButtons() {
  dom.countryGrid.innerHTML = COUNTRIES.map(
    (c) => `
      <button type="button" class="country-btn" role="radio" data-code="${c.code}"
              aria-checked="${c.code === state.country.code}">
        <span class="flag">${c.flag}</span>
        <span>${escapeHtml(c.name)}</span>
        <span class="cur">${c.currency}</span>
      </button>`
  ).join("");
}

function init() {
  // Валюта пересчёта из localStorage
  try {
    const saved = localStorage.getItem(TARGET_CACHE_KEY);
    if (saved && CURRENCY_OPTIONS.includes(saved)) state.targetCurrency = saved;
  } catch { /* ignore */ }

  buildCountryButtons();

  dom.countryGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".country-btn");
    if (!btn) return;
    const country = COUNTRIES.find((c) => c.code === btn.dataset.code);
    if (!country || country.code === state.country.code) return;

    state.country = country;
    for (const b of dom.countryGrid.querySelectorAll(".country-btn")) {
      b.setAttribute("aria-checked", String(b.dataset.code === country.code));
    }

    // Пересобрать результаты и карточку под новую страну
    if (state.query) doSearch(state.query);
    else {
      dom.detail.classList.add("hidden");
      state.selected = null;
    }
  });

  dom.form.addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch();
  });

  $("hints").addEventListener("click", (e) => {
    const hint = e.target.closest(".hint");
    if (hint) doSearch(hint.dataset.q);
  });

  dom.resultsGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) selectResult(Number(card.dataset.idx));
  });

  dom.resultsGrid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".card");
    if (card) {
      e.preventDefault();
      selectResult(Number(card.dataset.idx));
    }
  });

  // Курсы валют подгружаем заранее, чтобы пересчёт был мгновенным
  loadRates();
  dom.input.focus();
}

document.addEventListener("DOMContentLoaded", init);
