/**
 * Daily health check. Run by .github/workflows/checkup.yml; also `node checkup.mjs`.
 *
 * This app reads two APIs nobody promises to keep stable, so the failure mode that matters
 * is not a crash — it is the app quietly saying something false. In October 2026 Globoplay
 * renamed its cheapest plan from "Padrão com Anúncios" to "com anúncios"; the exact-string
 * match stopped recognising it, and for four days every ad-plan film was reported as
 * needing Globoplay Premium. Nothing errored. These checks exist to catch that class of bug.
 *
 * FAIL = the live app is wrong or broken now. WARN = it will be soon.
 */
import { classify, indexPackages, GLOBO_PRICES, perMonth } from './classify.js';

const JW = 'https://apis.justwatch.com/graphql';
const GLOBO = 'https://multicloud-jarvis.globo.com/graphql';
const GLOBO_HEADERS = {
  'Content-Type': 'application/json',
  'x-tenant-id': 'globo-play',
  'x-platform-id': 'web',
  'x-client-version': '2025.01.1',
  'x-device-id': 'desktop',
};
const SITE = 'https://vergarac.github.io/onde-assistir/';

// Plan labels classify.js knows how to place. Anything else is a rename or a new product,
// and a human needs to look at it before the app starts guessing.
const KNOWN_PLAN = /anuncio|premium|telecine|^padrao$|^globoplay$/;
const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const PRICE_MAX_AGE_DAYS = 120;
const SAMPLE = ['Matrix 1999', 'Cidade de Deus', 'Tropa de Elite', 'Ainda Estou Aqui', 'Vale Tudo 1988', 'O Auto da Compadecida'];

const problems = [];
const fail = (what, detail) => { problems.push({ level: 'FAIL', what, detail }); console.log(`FAIL  ${what}\n      ${detail}`); };
const warn = (what, detail) => { problems.push({ level: 'WARN', what, detail }); console.log(`WARN  ${what}\n      ${detail}`); };
const skip = (what, detail) => { problems.push({ level: 'SKIP', what, detail }); console.log(`skip  ${what}\n      ${detail}`); };
const pass = what => console.log(`ok    ${what}`);

// Globoplay only returns its plan list to Brazilian IPs. The app is used from São Paulo, so
// this matters for where the CHECK runs, not for the app: GitHub's runners are in the US and
// see an empty subscriptionServices for every title. Those checks are skipped there rather
// than reported as breakage — but it also means CI cannot catch a Globoplay plan rename.
// The app's own defence is classify.js, which refuses to place a label it doesn't recognise.
let inBrazil = false;
try {
  const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
  inBrazil = /^loc=BR$/m.test(trace);
} catch {}
console.log(inBrazil ? 'note  running from Brazil — Globoplay plan checks are active\n' : 'note  running outside Brazil — Globoplay plan checks will be skipped\n');

async function jw(query, variables = {}, headers = {}) {
  const r = await fetch(JW, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query, variables }) });
  const json = await r.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return { data: json.data, res: r };
}

// ---------------------------------------------------------------- 1. transport

// The app reaches JustWatch from a sandboxed iframe, whose origin is the literal "null".
// JustWatch allows that and not github.io; if they ever tighten it, the app goes dark.
try {
  const r = await fetch(JW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify({ query: '{ popularTitles(country: BR, first: 1) { edges { node { id } } } }' }),
  });
  const acao = r.headers.get('access-control-allow-origin');
  if (!r.ok) fail('JustWatch is not answering', `HTTP ${r.status}`);
  else if (acao !== 'null') fail('JustWatch stopped allowing the sandboxed-iframe route', `access-control-allow-origin: ${acao ?? '(absent)'} — set RELAY in app.js to the deployed worker.js`);
  else pass('JustWatch answers, and still allows the null-origin route');
} catch (e) { fail('JustWatch is unreachable', String(e)); }

try {
  const r = await fetch(SITE, { method: 'GET' });
  r.ok ? pass('the site is up') : fail('the site is down', `HTTP ${r.status}`);
} catch (e) { fail('the site is unreachable', String(e)); }

// ---------------------------------------------------------------- 2. JustWatch shape

// Every field the app reads, in one query: if JustWatch drops one, this throws by name.
let offersNode = null;
try {
  const { data } = await jw(`query { url(fullPath: "/br/filme/matrix") { node {
    ... on MovieOrShowOrSeason {
      content(country: BR, language: "pt-BR") { title posterUrl runtime ... on MovieOrShowContent { originalTitle productionCountries } }
      offers(country: BR, platform: WEB) { monetizationType presentationType retailPrice(language: "pt-BR") retailPriceValue standardWebURL availableTo
        package { packageId clearName icon addonParent(country: BR, platform: WEB) { packageId clearName } } } } } } }`);
  offersNode = data.url.node;
  if (!offersNode?.offers?.length) fail('JustWatch returned no offers for a title that should have them', 'Matrix came back empty');
  else pass(`JustWatch still returns every field the app reads (${offersNode.offers.length} offers)`);
} catch (e) { fail('the JustWatch query the app sends no longer works', String(e)); }

let pkgs = new Map();
try {
  const { data } = await jw(`query { packages(country: BR, platform: WEB, includeAddons: true) {
    packageId clearName icon addonParent(country: BR, platform: WEB) { packageId clearName }
    planOffers(country: BR, platform: WEB) { title retailPriceValue currency durationDays isTrial } } }`);
  pkgs = indexPackages(data.packages);
  const addons = data.packages.filter(p => p.addonParent).length;
  const named = data.packages.filter(p => /amazon channel|apple tv channel/i.test(p.clearName)).length;
  if (data.packages.length < 100) fail('the Brazilian package list shrank', `${data.packages.length} packages (was ~136)`);
  else pass(`${data.packages.length} BR packages, ${addons} flagged as channels by the API, ${named} by name`);
  if (addons === 0) fail('addonParent stopped flagging anything', 'channel detection now rests on the name rule alone');
} catch (e) { fail('the JustWatch package query no longer works', String(e)); }

// ---------------------------------------------------------------- 3. Globoplay

async function globo(body) {
  const r = await fetch(GLOBO, { method: 'POST', headers: GLOBO_HEADERS, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

const TITLE_Q = 'query T($id: String!) { title(titleId: $id) { headline subscriptionServices { name } } }';
const VIDEO_Q = 'query V($id: ID!) { video(id: $id) { title { headline subscriptionServices { name } } } }';

// Works from anywhere: proves the endpoint still accepts the four x-* headers and that the
// query the app sends is still valid. What comes back is geo-dependent and checked below.
try {
  await globo({ query: TITLE_Q, variables: { id: 'rJrXxvJ2s8' } });
  await globo({ query: VIDEO_Q, variables: { id: '7982037' } });
  pass('Globoplay accepts the headers and both queries the app sends');
} catch (e) { fail('Globoplay rejected the request', `${e} — check the four x-* headers and the query shape`); }

if (!inBrazil) {
  skip('Globoplay content checks', 'films, plan names and prices are only served to Brazilian IPs — run `node checkup.mjs` from São Paulo for the full sweep');
} else {
  try {
    const d = await globo({ query: TITLE_Q, variables: { id: 'rJrXxvJ2s8' } });
    if (!d?.title?.headline) fail('Globoplay stopped resolving film links (/t/)', 'title(titleId) returned nothing from a Brazilian IP');
    else if (!d.title.subscriptionServices?.length) fail('Globoplay stopped naming the plans for a title', 'subscriptionServices came back empty from a Brazilian IP');
    else pass('Globoplay answers film links (/t/) with its plan list');
  } catch (e) { fail('the Globoplay film query no longer works', String(e)); }

  try {
    const d = await globo({ query: VIDEO_Q, variables: { id: '7982037' } });
    if (!d?.video?.title) fail('Globoplay stopped resolving series links (/v/)', 'video(id) returned no title from a Brazilian IP');
    else pass('Globoplay answers series links (/v/)');
  } catch (e) { fail('the Globoplay series query no longer works', String(e)); }

  // The rename check: sweep real titles and assert every plan label is one we can place.
  try {
    const { data } = await jw(`query { popularTitles(country: BR, first: 40, filter: {packages: ["gop"], objectTypes: [MOVIE]}) {
      edges { node { offers(country: BR, platform: WEB, filter: {packages: ["gop"]}) { standardWebURL } } } } }`);
    const seen = new Map();
    let resolved = 0;
    for (const e of data.popularTitles.edges) {
      const url = (e.node.offers || [])[0]?.standardWebURL || '';
      const t = url.match(/\/t\/([A-Za-z0-9]+)/)?.[1];
      const v = url.match(/\/v\/(\d+)/)?.[1];
      if (!t && !v) continue;
      let title;
      try {
        const d = t ? await globo({ query: TITLE_Q, variables: { id: t } })
                    : await globo({ query: VIDEO_Q, variables: { id: v } });
        title = t ? d?.title : d?.video?.title;
      } catch { continue; }
      if (!title) continue;
      resolved++;
      for (const svc of title.subscriptionServices || []) seen.set(svc.name, (seen.get(svc.name) || 0) + 1);
    }
    const labels = [...seen.keys()];
    const unknown = labels.filter(n => !KNOWN_PLAN.test(fold(n)));
    if (!resolved) fail('no Globoplay title could be resolved at all', 'the link format in standardWebURL may have changed');
    else if (!labels.length) fail('Globoplay returned no plan names for any title', `${resolved} titles resolved, none named a plan`);
    else if (unknown.length) fail('Globoplay is using plan names the app cannot place', `${unknown.map(n => `"${n}"`).join(', ')} — teach classify.js about them before the app starts guessing`);
    else {
      pass(`Globoplay plan names all recognised across ${resolved} titles (${labels.join(', ')})`);
      if (!labels.some(n => /anuncio/.test(fold(n)))) warn('no ad-supported plan appeared in the sample', 'if that plan was retired, the pricing and wording need revisiting');
    }
  } catch (e) { warn('could not sweep Globoplay plan names', String(e)); }
}

// ---------------------------------------------------------------- 4. prices

const ageDays = Math.floor((Date.now() - Date.parse(GLOBO_PRICES.asOf)) / 864e5);
if (Number.isNaN(ageDays)) fail('GLOBO_PRICES.asOf is not a date', String(GLOBO_PRICES.asOf));
else if (ageDays > PRICE_MAX_AGE_DAYS) warn(`the hand-kept Globoplay prices are ${ageDays} days old`, `check ${GLOBO_PRICES.source} and update GLOBO_PRICES.asOf`);
else pass(`hand-kept Globoplay prices are ${ageDays} days old`);

// A price that is absurd is worse than no price. JustWatch has shipped both (R$ 20.280,00/363d).
for (const [, p] of pkgs) {
  if (p.monthly != null && (p.monthly < 3 || p.monthly > 200)) {
    warn(`implausible monthly price for ${p.name}`, `R$ ${p.monthly} — indexPackages should be filtering this out`);
  }
  // Services whose plan prices disagree wildly show no price at all. Listing them keeps that
  // visible: if a familiar service appears here, JustWatch's data for it is worth a look.
  const real = (p.plans || []).filter(x => x.days >= 28 && x.days <= 31 && x.value > 3 && x.value < 250).map(x => x.value).sort((a, b) => a - b);
  if (real.length > 1 && real[0] < real[1] * 0.5) {
    warn(`no price shown for ${p.name}`, `its plans disagree (R$ ${real[0]} vs R$ ${real[1]}) — one of them is a promotion or mislabelled`);
  }
}

// ---------------------------------------------------------------- 5. what the app would say

let checked = 0;
for (const q of SAMPLE) {
  try {
    const { data: s } = await jw(`query S($q: String!) { popularTitles(country: BR, first: 1, filter: {searchQuery: $q}) {
      edges { node { content(country: BR, language: "pt-BR") { fullPath } } } } }`, { q });
    const path = s.popularTitles.edges[0]?.node.content.fullPath;
    if (!path) { warn(`search found nothing for "${q}"`, 'skipped'); continue; }
    const { data: o } = await jw(`query O($path: String!) { url(fullPath: $path) { node { ... on MovieOrShowOrSeason {
      offers(country: BR, platform: WEB) { monetizationType presentationType retailPrice(language: "pt-BR") retailPriceValue standardWebURL availableTo
        package { packageId clearName icon addonParent(country: BR, platform: WEB) { packageId clearName } } } } } } }`, { path });
    const offers = o.url.node?.offers || [];
    const gOffer = offers.find(x => x.package.packageId === 307 && x.monetizationType === 'FLATRATE');
    let globoplay = null;
    if (gOffer) {
      const url = gOffer.standardWebURL || '';
      const t = url.match(/\/t\/([A-Za-z0-9]+)/)?.[1];
      const v = url.match(/\/v\/(\d+)/)?.[1];
      try {
        const d = t
          ? await globo({ query: 'query T($id: String!) { title(titleId: $id) { subscriptionServices { name } } }', variables: { id: t } })
          : await globo({ query: 'query V($id: ID!) { video(id: $id) { title { subscriptionServices { name } } } }', variables: { id: v } });
        const ti = t ? d?.title : d?.video?.title;
        globoplay = ti ? { services: (ti.subscriptionServices || []).map(x => x.name) } : { services: [] };
      } catch { globoplay = { error: true }; }
    }
    const b = classify(offers, { packages: pkgs, globoplay, owned: new Set() });
    checked++;

    // A Globoplay row must always say which plan it needs, or admit it doesn't know.
    for (const r of [...b.included, ...b.extra]) {
      if (/globoplay/i.test(r.name) && !r.note && !r.uncertain && r.kind !== 'plan') {
        fail(`"${q}" shows Globoplay without naming a plan`, 'this is the shape the October rename produced');
      }
    }
    // A subscription row offering a price must offer a sane one.
    for (const r of [...b.included, ...b.extra]) {
      const p = perMonth(r);
      if (p != null && (p < 3 || p > 200)) fail(`"${q}" shows an implausible price for ${r.name}`, `R$ ${p}/mês`);
    }
    if (!b.summary) fail(`"${q}" produced no answer`, 'classify returned no summary');
  } catch (e) { warn(`could not check "${q}"`, String(e)); }
}
if (checked) pass(`${checked} sample titles classified without a bad shape`);

// ---------------------------------------------------------------- verdict

const fails = problems.filter(p => p.level === 'FAIL');
const warns = problems.filter(p => p.level === 'WARN');
const skips = problems.filter(p => p.level === 'SKIP');
const tail = skips.length ? `, ${skips.length} skipped (needs a Brazilian IP)` : '';
console.log('');
if (fails.length) console.log(`${fails.length} FAIL, ${warns.length} WARN${tail} — the app is wrong or broken right now.`);
else if (warns.length) console.log(`0 FAIL, ${warns.length} WARN${tail} — working, but needs attention soon.`);
else console.log(`All good${tail}.`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  const body = problems.length
    ? problems.map(p => `- **${p.level}** ${p.what}\n  - ${p.detail}`).join('\n')
    : 'All checks passed.';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Onde Assistir checkup\n\n${body}\n`);
}
process.exit(fails.length ? 1 : 0);
