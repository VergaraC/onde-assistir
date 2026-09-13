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

// Globoplay's own API names the plans that unlock a title. Only "Padrão com Anúncios" is the
// basic plan sold today; "Padrão" (no ads) and "Globoplay" are legacy plans old subscribers keep.
// A title that lists them but not "Padrão com Anúncios" is NOT in the plan a new subscriber gets.
const GLOBO_ADS_BASE = 'Padrão com Anúncios';
const GLOBO_LEGACY = new Set(['Padrão', 'Globoplay']);
const GLOBO_PKG = 307;

// Fallback prices (BRL/month, checked 2026-09-13) for plans JustWatch doesn't price.
export const GLOBO_PRICES = { base: 22.90, premium: 39.90, telecineCombo: 47.90 };

const QUALITY_RANK = { _4K: 4, HD: 3, SD: 2 };

export function serviceKey(name) {
  const s = String(name || '')
    .replace(CHANNEL_SUFFIX, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '');
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
    let monthly = null, trialDays = null;
    for (const o of p.planOffers || []) {
      const v = o.retailPriceValue, d = o.durationDays;
      if (o.isTrial) { if (d && d <= 31) trialDays = Math.max(trialDays || 0, d); continue; }
      if (v == null || d == null || d < 28 || d > 31 || v < 3 || v > 250) continue;
      if (monthly == null || v < monthly) monthly = v;
    }
    map.set(p.packageId, {
      id: p.packageId,
      name: p.clearName,
      icon: p.icon,
      monthly,
      trialDays,
      plans: (p.planOffers || []).map(o => ({ title: (o.title || '').trim().toLowerCase(), value: o.retailPriceValue, days: o.durationDays })),
    });
  }
  for (const [tier, parent] of Object.entries(TIER_OF)) {
    const t = map.get(Number(tier)), p = map.get(parent);
    if (t && p && t.monthly != null && (p.monthly == null || t.monthly < p.monthly)) p.monthly = t.monthly;
  }
  return map;
}

function globoPrice(pkgIndex, titleWord, fallback) {
  const g = pkgIndex && pkgIndex.get(GLOBO_PKG);
  const hit = g && g.plans.find(pl => pl.title.includes(titleWord) && pl.days >= 28 && pl.days <= 31 && pl.value > 3 && pl.value < 250);
  return hit ? hit.value : fallback;
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

  const byMonthly = (x, y) => (y.owned - x.owned) || ((x.monthly ?? 1e9) - (y.monthly ?? 1e9)) || x.name.localeCompare(y.name, 'pt-BR');
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
  const basicPrice = globoPrice(pkgs, 'anuncio', GLOBO_PRICES.base);
  if (answer.error) {
    return [{ ...base, bucket: 'included', monthly: basicPrice, uncertain: 'Não consegui confirmar o plano no Globoplay agora.' }];
  }
  const names = answer.services || [];
  if (!names.length) {
    return [{ ...base, bucket: 'included', monthly: basicPrice, uncertain: 'O Globoplay não confirma que o título está disponível agora.' }];
  }
  if (names.includes(GLOBO_ADS_BASE)) {
    return [{ ...base, bucket: 'included', monthly: basicPrice, note: 'No plano básico' }];
  }
  const rows = [];
  if (names.includes('Premium')) {
    rows.push({
      ...base, bucket: 'extra', kind: 'plan', name: 'Globoplay Premium', key: 'globoplaypremium',
      icon, monthly: globoPrice(pkgs, 'premium', GLOBO_PRICES.premium), note: 'Não está no plano com anúncios',
    });
  }
  if (names.includes('Telecine')) {
    rows.push({
      ...base, bucket: 'extra', kind: 'channel', name: 'Globoplay + Telecine', key: 'telecine',
      host: { id: GLOBO_PKG, name: 'Globoplay' }, icon, monthly: GLOBO_PRICES.telecineCombo, comboPrice: true,
    });
  }
  for (const n of names) {
    if (n === 'Premium' || n === 'Telecine' || GLOBO_LEGACY.has(n)) continue;
    rows.push({ ...base, bucket: 'extra', kind: 'channel', name: n, key: serviceKey(n), host: { id: GLOBO_PKG, name: 'Globoplay' }, icon, monthly: null });
  }
  if (!rows.length && names.some(n => GLOBO_LEGACY.has(n))) {
    rows.push({ ...base, bucket: 'included', monthly: null, note: 'Só no antigo plano Padrão sem anúncios' });
  }
  return rows;
}

function names(rows) {
  return [...new Set(rows.map(r => r.name))];
}

export function summarize(b) {
  const ownedRows = [...b.included, ...b.extra].filter(r => r.owned);
  if (ownedRows.length) return { tone: 'ok', kind: 'owned', names: names(ownedRows) };
  if (b.included.length) {
    const prices = b.included.map(r => r.monthly).filter(v => v != null);
    return { tone: 'ok', kind: 'included', names: names(b.included), from: prices.length ? Math.min(...prices) : null };
  }
  if (b.free.length) return { tone: 'ok', kind: 'free', names: names(b.free) };
  if (b.extra.length) {
    const prices = b.extra.map(r => r.monthly).filter(v => v != null);
    return { tone: 'extra', kind: 'extra', names: names(b.extra), from: prices.length ? Math.min(...prices) : null };
  }
  const tx = [...b.rent, ...b.buy].map(r => r.priceValue).filter(v => v != null);
  if (b.rent.length || b.buy.length) return { tone: 'money', kind: b.rent.length ? 'rent' : 'buy', from: tx.length ? Math.min(...tx) : null };
  if (b.cinema.length) return { tone: 'money', kind: 'cinema', names: names(b.cinema) };
  return { tone: 'bad', kind: 'none' };
}
