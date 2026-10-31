// Live regression test: real JustWatch + Globoplay responses through classify().
// Run: node test.mjs
import { classify, indexPackages, displayTitle, serviceKey } from './classify.js';

const JW = 'https://apis.justwatch.com/graphql';
const GLOBO = 'https://multicloud-jarvis.globo.com/graphql';
const GLOBO_HEADERS = { 'Content-Type': 'application/json', 'x-tenant-id': 'globo-play', 'x-platform-id': 'web', 'x-client-version': '2025.01.1', 'x-device-id': 'desktop' };

const jw = async (query, variables = {}) => {
  const r = await fetch(JW, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return (await r.json()).data;
};

const PACKAGES = `query { packages(country: BR, platform: WEB, includeAddons: true) {
  packageId clearName icon addonParent(country: BR, platform: WEB) { packageId clearName }
  planOffers(country: BR, platform: WEB) { title retailPriceValue currency durationDays isTrial } } }`;
const SEARCH = `query S($q: String!) { popularTitles(country: BR, first: 1, filter: {searchQuery: $q}) {
  edges { node { content(country: BR, language: "pt-BR") { fullPath } } } } }`;
const OFFERS = `query O($path: String!) { url(fullPath: $path) { node { ... on MovieOrShowOrSeason {
  content(country: BR, language: "pt-BR") { title ... on MovieOrShowContent { originalTitle productionCountries } }
  offers(country: BR, platform: WEB) { monetizationType presentationType retailPrice(language: "pt-BR") retailPriceValue standardWebURL availableTo
    package { packageId clearName icon addonParent(country: BR, platform: WEB) { packageId clearName } } } } } } }`;

async function globo(url) {
  const titleId = (url || '').match(/\/t\/([A-Za-z0-9]+)/)?.[1];
  const videoId = (url || '').match(/\/v\/(\d+)/)?.[1];
  if (!titleId && !videoId) return { error: true };
  const body = titleId
    ? { query: 'query T($id: String!){ title(titleId:$id){ subscriptionServices { name } } }', variables: { id: titleId } }
    : { query: 'query V($id: ID!){ video(id:$id){ title { subscriptionServices { name } } } }', variables: { id: videoId } };
  const r = await fetch(GLOBO, { method: 'POST', headers: GLOBO_HEADERS, body: JSON.stringify(body) });
  if (!r.ok) return { error: true };
  const d = (await r.json()).data;
  const t = titleId ? d?.title : d?.video?.title;
  return t ? { services: (t.subscriptionServices || []).map(s => s.name) } : { services: [] };
}

const packages = indexPackages((await jw(PACKAGES)).packages);
const money = v => v == null ? '' : ` R$ ${v.toFixed(2).replace('.', ',')}`;
const per = r => r.monthly ?? r.yearly ?? null;

let failures = 0;
const expect = (cond, msg) => { console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

async function run(q, checks, owned = []) {
  const path = (await jw(SEARCH, { q })).popularTitles.edges[0].node.content.fullPath;
  const node = (await jw(OFFERS, { path })).url.node;
  const gOffer = node.offers.find(o => o.package.packageId === 307 && o.monetizationType === 'FLATRATE');
  const globoplay = gOffer ? await globo(gOffer.standardWebURL) : null;
  const b = classify(node.offers, { packages, globoplay, owned: new Set(owned) });
  console.log(`\n══ ${displayTitle(node.content)}   [${b.summary.kind}${b.summary.from != null ? money(b.summary.from) : ''}]${globoplay ? '  globoplay=' + JSON.stringify(globoplay.services || globoplay) : ''}`);
  for (const k of ['included', 'extra', 'free', 'rent', 'buy', 'cinema']) {
    for (const r of b[k]) console.log(`   ${k.padEnd(8)} ${r.name}${r.host ? ' (via ' + r.host.name + ')' : ''}${money(per(r))}${r.priceValue != null ? money(r.priceValue) : ''}${r.trialDays ? ' trial ' + r.trialDays + 'd' : ''}${r.leavingOn ? ' sai ' + r.leavingOn : ''}${r.owned ? ' ★' : ''}${r.note ? ' · ' + r.note : ''}${r.uncertain ? ' ?' + r.uncertain : ''}`);
  }
  checks(b, node);
}

const has = (rows, name, host) => rows.some(r => r.name === name && (host === undefined || (r.host && r.host.name) === host));

await run('Tropa de Elite', b => {
  expect(has(b.included, 'HBO Max'), 'HBO Max shows as its own service');
  expect(!has(b.extra, 'HBO Max'), 'HBO Max is NOT also listed as a Prime channel (Victor\'s fix)');
  expect(has(b.extra, 'Telecine', 'Prime Video'), 'Telecine still listed as a Prime channel');
  expect(has(b.included, 'Prime Video') && b.included.filter(r => r.name === 'Prime Video').length === 1, 'Prime Video once, ad tier folded in');
});
await run('Killers of the Flower Moon', b => {
  expect(has(b.included, 'Apple TV'), 'Apple TV subscription is included');
  expect(!has(b.extra, 'Apple TV'), 'Apple TV channel inside Prime is hidden');
  expect(has(b.rent, 'Apple TV'), 'Apple TV rental kept separate from the subscription');
});
await run('Divertida Mente 2', b => expect(has(b.included, 'Disney+'), 'Disney+ included'));
await run('Cidade de Deus', b => {
  const g = b.included.find(r => /globoplay/i.test(r.name));
  expect(Boolean(g) && !g.uncertain, 'ad-plan title -> included, with a named plan');
});
// Whichever Globoplay plan a title sits in, it must land in exactly one of these shapes —
// never silently default to "included" when the plan list says otherwise.
await run('Matrix 1999', b => {
  const g = [...b.included, ...b.extra].filter(r => /globoplay|telecine/i.test(r.name));
  expect(g.length > 0, 'Globoplay title produces a row');
  expect(g.every(r => r.note || r.uncertain || r.host || r.kind === 'plan'), 'every Globoplay row says which plan it needs');
});

await run('Matrix 1999', b => {
  const rows = [...b.included, ...b.extra].filter(r => /globoplay/i.test(r.name));
  expect(rows.some(r => r.owned), 'owning Globoplay Premium marks its row as yours');
  expect(b.summary.kind === 'owned', 'summary says you can already watch it');
}, ['globoplaypremium']);
await run('Cidade de Deus', b => {
  expect(b.summary.kind === 'owned', 'owning Premium also covers ad-plan titles');
}, ['globoplaypremium']);
await run('Cidade de Deus', b => {
  expect(!b.extra.some(r => r.owned), 'owning basic Globoplay does not claim Premium');
}, ['globoplay']);
await run('Ainda Estou Aqui', (b, node) => expect(displayTitle(node.content) === 'Ainda Estou Aqui', 'Brazilian film keeps its Portuguese title'));
await run('The Handmaid\'s Tale', b => {
  expect(has(b.included, 'Paramount+') && !has(b.extra, 'Paramount+'), 'Paramount+ once, not also as channels');
  expect(has(b.extra, 'MGM+', 'Prime Video'), 'MGM+ channel in Prime (Victor\'s example)');
  expect(has(b.extra, 'MGM+', 'Apple TV'), 'MGM+ channel in Apple TV (missed by addonParent)');
});
await run('Vale Tudo 1988', b => {
  const g = [...b.included, ...b.extra].find(r => /globoplay/i.test(r.name));
  expect(Boolean(g), 'series resolved through a /v/ Globoplay link');
  expect(!g.uncertain, 'and its plan was identified, not guessed');
});
await run('Hannibal Rising', b => expect(b.summary.kind === 'none', 'not available in Brazil'));

expect(serviceKey('Paramount+ Amazon Channel') === serviceKey('Paramount Plus'), 'serviceKey: Paramount+ variants match');
console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
process.exit(failures ? 1 : 0);
