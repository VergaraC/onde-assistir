/**
 * Onde Assistir — offer classifier.
 *
 * Turns JustWatch's raw offer list for one title into the answer Victor asked for:
 * what's included in a subscription, what needs an extra plan or channel (and what
 * that costs), what's free, what's for rent or sale, and whether it's in Brazil at all.
 *
 * Pure functions, no DOM, no network — runs in the browser and in `node test.mjs`.
 */

// Packages that look like add-ons but are really cheaper tiers of the same service.
// "Prime Video with Ads" is the default Prime plan in Brazil, not an extra purchase.
export const TIER_OF = {
  2100: 119,   // Amazon Prime Video with Ads -> Amazon Prime Video
  1796: 8,     // Netflix Standard with Ads   -> Netflix
  2303: 531,   // Paramount Plus Premium      -> Paramount Plus
};

// JustWatch's addonParent field misses ~36% of Brazilian channels (MGM+ Apple TV Channel,
// every 2025-2026 Globo channel on Prime…). The name is the reliable second signal.
const CHANNEL_SUFFIX = /\s*(amazon\s+channels?|apple\s+tv\s+channel|roku\s+(premium\s+)?channel)\s*$/i;

const CHANNEL_HOST = [
  [/amazon\s+channels?\s*$/i,          { id: 119, name: 'Prime Video' }],
  [/apple\s+tv\s+channel\s*$/i,        { id: 350, name: 'Apple TV' }],
  [/roku\s+(premium\s+)?channel\s*$/i, { id: 207, name: 'Roku' }],
];

// Brazilian names people actually say.
const NICE_NAME = {
  'amazon prime video': 'Prime Video',
  'amazon video': 'Prime Video',
  'disney plus': 'Disney+',
  'paramount plus': 'Paramount+',
  'paramount plus premium': 'Paramount+',
  'netflix standard with ads': 'Netflix',
  'apple tv store': 'Apple TV',
  'mgm plus': 'MGM+',
  'hbo max': 'HBO Max',
};

// Collapses spelling variants so "Paramount+ Amazon Channel" and "Paramount Plus"
// are recognised as the same service.
const KEY_ALIAS = {
  amazonprimevideo: 'primevideo',
  amazonprimevideowithads: 'primevideo',
  netflixstandardwithads: 'netflix',
  paramountpluspremium: 'paramountplus',
  max: 'hbomax',
};

// Globoplay's own API names the plans that unlock a title. The ad-supported plan is the cheapest
// one sold today; "Padrão" (no ads) and "Globoplay" are legacy plans existing subscribers keep.
// Match on shape, not on an exact label: Globoplay renamed "Padrão com Anúncios" to "com anúncios"
// in October 2026, and an exact-string check silently reported included titles as Premium-only.
const GLOBO_PKG = 307;
const isAdsPlan = n => /anuncio/.test(fold(n));
const isPremiumPlan = n => /premium/.test(fold(n));
const isTelecinePlan = n => /telecine/.test(fold(n));
// Legacy labels on their own never mean "a new subscriber can watch this".
const isLegacyPlan = n => ['padrao', 'globoplay'].includes(fold(n));

// Globoplay's prices are not in any API we can read — JustWatch still served the pre-October
// numbers weeks after they changed — so they are maintained here. `asOf` drives the staleness
// warning in checkup.mjs; update both together.
export const GLOBO_PRICES = {
  asOf: '2026-10-30',
  source: 'https://tecnoblog.net/noticias/globoplay-reformula-planos-confira-os-novos-recursos-e-precos/',
  base: { monthly: 29.90, yearly: 19.90 },
  premium: { monthly: 39.90, yearly: 24.90 },
  telecineCombo: { monthly: null, yearly: 34.90 },
};

const QUALITY_RANK = { _4K: 4, HD: 3, SD: 2 };

/** Monthly cost of a subscription row, falling back to the annual instalment when a plan
 *  is only sold yearly (Globoplay + Telecine). Used for sorting and for "a partir de". */
export const perMonth = r => r.monthly ?? r.yearly ?? null;

/** Lowercase, strip accents and punctuation — so "com Anúncios" and "com anuncios" match. */
function fold(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '');
}

export function serviceKey(name) {
  const s = fold(String(name || '').replace(CHANNEL_SUFFIX, ''));
  return KEY_ALIAS[s] || s;
}

export function niceName(name) {
  const base = String(name || '').replace(CHANNEL_SUFFIX, '').trim();
  return NICE_NAME[base.toLowerCase()] || base;
}

function channelHost(pkg) {
  if (pkg.addonParent) return { id: pkg.addonParent.packageId, name: niceName(pkg.addonParent.clearName) };
  for (const [re, host] of CHANNEL_HOST) if (re.test(pkg.clearName || '')) return host;
  return null;
}

function isChannel(pkg) {
  if (TIER_OF[pkg.packageId]) return false;
  return Boolean(pkg.addonParent) || CHANNEL_SUFFIX.test(pkg.clearName || '');
}

export function iconUrl(icon, size = 's100') {
  return icon ? `https://images.justwatch.com${icon.replace('{profile}', size).replace('{format}', 'webp')}` : null;
}

export function posterUrl(poster, size = 's332') {
  return poster ? `https://images.justwatch.com${poster.replace('{profile}', size).replace('{format}', 'webp')}` : null;
}

/** Brazilian productions keep their Portuguese original title; JustWatch's pt-BR
 *  localisation often falls back to English for them ("I'm Still Here"). */
export function displayTitle(content) {
  if (!content) return '';
  const countries = content.productionCountries || [];
  if (content.originalTitle && (countries[0] === 'BR' || countries[0] === 'PT')) return content.originalTitle;
  return content.title || content.originalTitle || '';
}

/**
 * Reduce raw planOffers to one monthly price per package, and fold tier prices into
 * their parent so Netflix reads "a partir de R$ 20,90" (the ad tier).
 * JustWatch ships some nonsense plans (Globoplay "R$ 20.280,00 / 363 dias"), hence the filters.
 */
export function indexPackages(packages) {
  const map = new Map();
  for (const p of packages || []) {
    let trialDays = null;
    const monthlies = [];
    for (const o of p.planOffers || []) {
      const v = o.retailPriceValue, d = o.durationDays;
      if (o.isTrial) { if (d && d <= 31) trialDays = Math.max(trialDays || 0, d); continue; }
      // ~15% of BR plan offers are quoted in USD. Showing "R$ 3,49" for a US$ 3,49 plan
      // understates it by about four times, so anything not in reais is ignored.
      if (o.currency && o.currency !== 'BRL') continue;
      if (v == null || d == null || d < 28 || d > 31 || v < 3 || v > 250) continue;
      monthlies.push(v);
    }
    // A service whose plans disagree wildly is a service whose price we do not know.
    // In October 2026 Disney+ listed R$ 9,90 next to R$ 46,90 — a two-month promotion that
    // would have been shown as "a partir de" three days before it expired. Belas Artes
    // listed R$ 12,90 next to R$ 141, where the expensive one is the mislabelled one.
    // With two numbers there is no telling which is the odd one, so rather than pick wrong
    // we show no price. The answer the app exists to give does not depend on it.
    monthlies.sort((a, b) => a - b);
    const trustworthy = monthlies.length < 2 || monthlies[0] >= monthlies[1] * 0.5;
    const monthly = trustworthy && monthlies.length ? monthlies[0] : null;
    map.set(p.packageId, {
      id: p.packageId,
      name: p.clearName,
      icon: p.icon,
      monthly,
      trialDays,
      plans: (p.planOffers || [])
        .filter(o => !o.currency || o.currency === 'BRL')
        .map(o => ({ title: (o.title || '').trim().toLowerCase(), value: o.retailPriceValue, days: o.durationDays })),
    });
  }
  for (const [tier, parent] of Object.entries(TIER_OF)) {
    const t = map.get(Number(tier)), p = map.get(parent);
    if (t && p && t.monthly != null && (p.monthly == null || t.monthly < p.monthly)) p.monthly = t.monthly;
  }
  return map;
}

/** Our own table wins: JustWatch's Globoplay plan prices went stale for weeks after the
 *  October 2026 repricing, so it is only consulted when we have no figure of our own. */
function globoPrice(pkgIndex, titleWord, own) {
  if (own && own.monthly != null) return { monthly: own.monthly, yearly: own.yearly ?? null };
  const g = pkgIndex && pkgIndex.get(GLOBO_PKG);
  const hit = g && g.plans.find(pl => pl.title.includes(titleWord) && pl.days >= 28 && pl.days <= 31 && pl.value > 3 && pl.value < 250);
  if (hit) return { monthly: hit.value, yearly: null };
  return { monthly: null, yearly: (own && own.yearly) ?? null };
}

/**
 * @param offers   JustWatch offers for one title (country BR)
 * @param ctx.packages  Map from indexPackages()
 * @param ctx.globoplay null = not asked / no Globoplay offer
 *                      { services: string[] } = Globoplay's own answer
 *                      { error: true } = Globoplay couldn't be reached
 * @param ctx.owned     Set of serviceKey()s the user subscribes to
 */
export function classify(offers, ctx = {}) {
  const pkgs = ctx.packages || new Map();
  const owned = new Set(ctx.owned || []);
  if (owned.has('globoplaypremium')) owned.add('globoplay');   // Premium includes the basic catalogue
  const best = new Map();

  const put = (row, q) => {
    const k = `${row.bucket}:${row.key}:${row.host ? row.host.id : ''}`;
    const prev = best.get(k);
    if (!prev) { best.set(k, { ...row, _q: q }); return; }
    if (row.bucket === 'rent' || row.bucket === 'buy') {
      // Keep the cheapest price; remember the best quality seen.
      const cheaper = (row.priceValue ?? 1e9) < (prev.priceValue ?? 1e9);
      const quality = q > prev._q ? row.quality : prev.quality;
      best.set(k, cheaper ? { ...row, quality, _q: Math.max(q, prev._q) } : { ...prev, quality, _q: Math.max(q, prev._q) });
    } else if (q > prev._q) {
      best.set(k, { ...row, leavingOn: row.leavingOn || prev.leavingOn, _q: q });
    }
  };

  for (const o of offers || []) {
    const pkg = o.package || {};
    const pkgId = TIER_OF[pkg.packageId] || pkg.packageId;
    const info = pkgs.get(pkgId) || {};
    const mt = o.monetizationType;
    const q = QUALITY_RANK[o.presentationType] || 1;
    const base = {
      pkgId,
      name: niceName(pkgId !== pkg.packageId ? (info.name || pkg.clearName) : pkg.clearName),
      key: serviceKey(pkgId !== pkg.packageId ? (info.name || pkg.clearName) : pkg.clearName),
      icon: iconUrl(info.icon || pkg.icon),
      url: o.standardWebURL || null,
      quality: (o.presentationType || '').replace('_', '') || null,
      leavingOn: o.availableTo || null,
      host: null,
    };

    if (mt === 'CINEMA') { put({ ...base, bucket: 'cinema' }, q); continue; }
    if (mt === 'RENT' || mt === 'BUY') {
      put({ ...base, bucket: mt === 'RENT' ? 'rent' : 'buy', price: o.retailPrice || null, priceValue: o.retailPriceValue ?? null }, q);
      continue;
    }
    if (mt === 'FREE' || mt === 'ADS') { put({ ...base, bucket: 'free' }, q); continue; }
    if (mt !== 'FLATRATE' && mt !== 'FLATRATE_AND_BUY') continue;

    if (isChannel(pkg)) {
      put({
        ...base,
        bucket: 'extra',
        kind: 'channel',
        host: channelHost(pkg),
        monthly: (pkgs.get(pkg.packageId) || {}).monthly ?? null,
        trialDays: (pkgs.get(pkg.packageId) || {}).trialDays ?? null,
      }, q);
      continue;
    }

    if (pkgId === GLOBO_PKG && ctx.globoplay !== undefined && ctx.globoplay !== null) {
      for (const row of globoRows(base, ctx.globoplay, pkgs)) put(row, q);
      continue;
    }

    put({ ...base, bucket: 'included', monthly: info.monthly ?? null }, q);
  }

  const rows = [...best.values()].map(({ _q, ...r }) => ({ ...r, owned: owned.has(r.key) }));
  const b = { included: [], extra: [], free: [], rent: [], buy: [], cinema: [] };
  for (const r of rows) b[r.bucket].push(r);

  // Victor's rule: a service you can subscribe to directly shows once, as itself.
  // HBO Max on its own beats "HBO Max as a channel inside Prime".
  const direct = new Set(b.included.map(r => r.key));
  b.extra = b.extra.filter(r => r.kind !== 'channel' || !direct.has(r.key));

  const byMonthly = (x, y) => (y.owned - x.owned) || ((perMonth(x) ?? 1e9) - (perMonth(y) ?? 1e9)) || x.name.localeCompare(y.name, 'pt-BR');
  const byPrice = (x, y) => (x.priceValue ?? 1e9) - (y.priceValue ?? 1e9) || x.name.localeCompare(y.name, 'pt-BR');
  b.included.sort(byMonthly);
  b.extra.sort(byMonthly);
  b.free.sort((x, y) => x.name.localeCompare(y.name, 'pt-BR'));
  b.rent.sort(byPrice);
  b.buy.sort(byPrice);
  b.cinema.sort((x, y) => x.name.localeCompare(y.name, 'pt-BR'));

  b.summary = summarize(b);
  return b;
}

function globoRows(base, answer, pkgs) {
  const icon = base.icon;
  const basic = globoPrice(pkgs, 'anuncio', GLOBO_PRICES.base);
  const unsure = msg => [{ ...base, bucket: 'included', ...basic, uncertain: msg }];

  if (answer.error) return unsure('Não consegui confirmar o plano no Globoplay agora.');
  const names = answer.services || [];
  if (!names.length) return unsure('O Globoplay não confirma que o título está disponível agora.');

  if (names.some(isAdsPlan)) {
    return [{ ...base, bucket: 'included', ...basic, note: 'No plano com anúncios' }];
  }

  const rows = [];
  if (names.some(isPremiumPlan)) {
    rows.push({
      ...base, bucket: 'extra', kind: 'plan', name: 'Globoplay Premium', key: 'globoplaypremium',
      icon, ...globoPrice(pkgs, 'premium', GLOBO_PRICES.premium), note: 'Não está no plano com anúncios',
    });
  }
  if (names.some(isTelecinePlan)) {
    rows.push({
      ...base, bucket: 'extra', kind: 'channel', name: 'Globoplay + Telecine', key: 'telecine',
      host: { id: GLOBO_PKG, name: 'Globoplay' }, icon, ...GLOBO_PRICES.telecineCombo, comboPrice: true,
    });
  }

  // Anything we don't recognise: name it rather than guess a bucket for it.
  const unknown = names.filter(n => !isAdsPlan(n) && !isPremiumPlan(n) && !isTelecinePlan(n) && !isLegacyPlan(n));
  for (const n of unknown) {
    rows.push({ ...base, bucket: 'extra', kind: 'channel', name: n, key: serviceKey(n), host: { id: GLOBO_PKG, name: 'Globoplay' }, icon, monthly: null });
  }

  if (rows.length) return rows;
  // Only legacy plan names left — true for titles kept for old subscribers. Don't claim it is
  // included (a new subscriber can't watch it) and don't claim a price we can't name.
  if (names.some(isLegacyPlan)) {
    return [{ ...base, bucket: 'included', monthly: null, uncertain: 'Só em planos antigos do Globoplay, não nos vendidos hoje.' }];
  }
  return unsure('O Globoplay não informa em qual plano este título está.');
}

function names(rows) {
  return [...new Set(rows.map(r => r.name))];
}

export function summarize(b) {
  const ownedRows = [...b.included, ...b.extra].filter(r => r.owned);
  if (ownedRows.length) return { tone: 'ok', kind: 'owned', names: names(ownedRows) };
  if (b.included.length) {
    const prices = b.included.map(perMonth).filter(v => v != null);
    return { tone: 'ok', kind: 'included', names: names(b.included), from: prices.length ? Math.min(...prices) : null };
  }
  if (b.free.length) return { tone: 'ok', kind: 'free', names: names(b.free) };
  if (b.extra.length) {
    const prices = b.extra.map(perMonth).filter(v => v != null);
    return { tone: 'extra', kind: 'extra', names: names(b.extra), from: prices.length ? Math.min(...prices) : null };
  }
  const tx = [...b.rent, ...b.buy].map(r => r.priceValue).filter(v => v != null);
  if (b.rent.length || b.buy.length) return { tone: 'money', kind: b.rent.length ? 'rent' : 'buy', from: tx.length ? Math.min(...tx) : null };
  if (b.cinema.length) return { tone: 'money', kind: 'cinema', names: names(b.cinema) };
  return { tone: 'bad', kind: 'none' };
}

/**
 * What a saved list is worth: which titles you can already watch, which single subscription
 * would unlock the most of the rest, and what is about to disappear.
 *
 * @param items [{ path, title, buckets }] — buckets from classify()
 * @param owned Set of serviceKey()s the user subscribes to
 */
export function planForList(items, owned = new Set()) {
  const own = new Set(owned);
  if (own.has('globoplaypremium')) own.add('globoplay');

  const ready = [];      // already covered by something you pay for, or free
  const missing = [];    // needs a subscription you don't have
  const payPer = [];     // only rent/buy/cinema
  const gone = [];       // not in Brazil at all
  const leaving = [];    // disappearing soon, from a service you have

  const soon = (iso) => {
    if (!iso) return null;
    const days = Math.ceil((new Date(iso + 'T23:59:59-03:00') - Date.now()) / 864e5);
    return days >= 0 && days <= 45 ? days : null;
  };

  for (const it of items) {
    const b = it.buckets;
    if (!b) continue;
    const subs = [...b.included, ...b.extra, ...b.free];
    const mine = subs.filter(r => r.owned || r.bucket === 'free');

    if (mine.length) {
      ready.push({ ...it, via: mine });
      for (const r of mine) {
        const d = soon(r.leavingOn);
        if (d != null) leaving.push({ ...it, service: r.name, days: d, on: r.leavingOn });
      }
    } else if (subs.length) {
      missing.push({ ...it, options: subs });
    } else if (b.rent.length || b.buy.length || b.cinema.length) {
      payPer.push(it);
    } else {
      gone.push(it);
    }
  }

  // One row per service across everything you can't yet watch, cheapest-first within a tie.
  const tally = new Map();
  for (const it of missing) {
    const seen = new Set();
    for (const r of it.options) {
      if (seen.has(r.key)) continue;   // same service twice on one title counts once
      seen.add(r.key);
      const e = tally.get(r.key) || { key: r.key, name: r.name, host: r.host, kind: r.kind, monthly: perMonth(r), titles: [] };
      if (e.monthly == null) e.monthly = perMonth(r);
      e.titles.push(it.title);
      tally.set(r.key, e);
    }
  }
  const best = [...tally.values()]
    .sort((a, c) => c.titles.length - a.titles.length || ((a.monthly ?? 1e9) - (c.monthly ?? 1e9)) || a.name.localeCompare(c.name, 'pt-BR'));

  leaving.sort((a, c) => a.days - c.days);
  return { ready, missing, payPer, gone, leaving, best, total: items.length };
}
