/**
 * Onde Assistir — app shell.
 *
 * Data paths:
 *  - JustWatch GraphQL (availability, prices, leaving dates, deep links). It only sends CORS
 *    headers to justwatch.com, localhost and the opaque "null" origin — not github.io — so calls
 *    go through a tiny sandboxed srcdoc iframe, whose origin is "null". If that ever stops
 *    working, set RELAY to a deployed worker.js URL and the app falls back to it.
 *  - Globoplay's own GraphQL (which plan unlocks a title). CORS is open, called directly.
 *
 * Everything is cached in localStorage so repeat lookups cost nothing.
 */
import { classify, indexPackages, displayTitle, posterUrl } from './classify.js';

const RELAY = '';  // optional: 'https://onde-assistir.<you>.workers.dev'

const GLOBO = 'https://multicloud-jarvis.globo.com/graphql';
const GLOBO_HEADERS = {
  'Content-Type': 'application/json',
  'x-tenant-id': 'globo-play',
  'x-platform-id': 'web',
  'x-client-version': '2025.01.1',
  'x-device-id': 'desktop',
};

const Q = {
  SearchTitles: `query SearchTitles($q: String!) {
    popularTitles(country: BR, first: 10, filter: {searchQuery: $q}) {
      edges { node { objectType
        content(country: BR, language: "pt-BR") { title originalReleaseYear fullPath posterUrl
          ... on MovieOrShowContent { originalTitle productionCountries } } } } } }`,
  GetPopular: `query GetPopular {
    popularTitles(country: BR, first: 24, filter: {objectTypes: [MOVIE]}) {
      edges { node { objectType
        content(country: BR, language: "pt-BR") { title originalReleaseYear fullPath posterUrl
          ... on MovieOrShowContent { originalTitle productionCountries } } } } } }`,
  GetTitleOffers: `query GetTitleOffers($path: String!) {
    url(fullPath: $path) { node { __typename
      ... on MovieOrShowOrSeason {
        objectType
        content(country: BR, language: "pt-BR") { title originalReleaseYear shortDescription posterUrl runtime
          ... on MovieOrShowContent { originalTitle productionCountries } }
        offers(country: BR, platform: WEB) {
          monetizationType presentationType retailPrice(language: "pt-BR") retailPriceValue standardWebURL availableTo
          package { packageId clearName icon addonParent(country: BR, platform: WEB) { packageId clearName } } } }
      ... on Show { totalSeasonCount } } } }`,
  GetPackages: `query GetPackages {
    packages(country: BR, platform: WEB, includeAddons: true) {
      packageId clearName icon
      addonParent(country: BR, platform: WEB) { packageId clearName }
      planOffers(country: BR, platform: WEB) { title retailPriceValue durationDays isTrial } } }`,
};

const TTL = {
  SearchTitles: 6 * 36e5,
  GetPopular: 6 * 36e5,
  GetTitleOffers: 3 * 36e5,
  GetPackages: 7 * 864e5,
  Globoplay: 6 * 36e5,
};

// The services people in Brazil actually subscribe to. Keys match classify.serviceKey().
const SERVICES = [
  ['netflix', 'Netflix'],
  ['primevideo', 'Prime Video'],
  ['globoplay', 'Globoplay', 'Plano básico com anúncios'],
  ['globoplaypremium', 'Globoplay Premium', 'Inclui o catálogo do básico'],
  ['telecine', 'Telecine', 'No Globoplay ou como canal no Prime Video'],
  ['disneyplus', 'Disney+'],
  ['hbomax', 'HBO Max'],
  ['appletv', 'Apple TV'],
  ['paramountplus', 'Paramount+'],
  ['mgmplus', 'MGM+', 'Canal no Prime Video ou na Apple TV'],
  ['universalplus', 'Universal+', 'Canal no Prime Video'],
  ['crunchyroll', 'Crunchyroll'],
  ['mubi', 'MUBI'],
  ['looke', 'Looke'],
];

const $ = sel => document.querySelector(sel);
const view = $('#view');
const input = $('#q');

// ---------------------------------------------------------------- storage

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch {
      // Quota: drop the response cache and try once more.
      try { Object.keys(localStorage).filter(x => x.startsWith('oa:c:')).forEach(x => localStorage.removeItem(x)); localStorage.setItem(k, JSON.stringify(v)); } catch {}
    }
  },
};

function cacheRead(kind, key) {
  const hit = store.get(`oa:c:${kind}:${key}`, null);
  return hit && Date.now() - hit.t < TTL[kind] ? hit : null;
}
function cacheWrite(kind, key, data) {
  const entry = { t: Date.now(), data };
  store.set(`oa:c:${kind}:${key}`, entry);
  return entry;
}
function pruneCache() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('oa:c:')) continue;
      const kind = k.split(':')[2];
      const v = JSON.parse(localStorage.getItem(k));
      if (!v || Date.now() - v.t > (TTL[kind] || 0)) localStorage.removeItem(k);
    }
  } catch {}
}

let owned = new Set(store.get('oa:owned', []));
let recents = store.get('oa:recent', []);

// ---------------------------------------------------------------- JustWatch transport

let bridgePromise = null;

// Runs inside <iframe sandbox="allow-scripts" srcdoc>. Forwards request bodies to the one
// JustWatch endpoint, only for this page. Inline (srcdoc) so there is no extra file to fetch.
const BRIDGE_SRC = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', async e => {
  if (e.source !== parent) return;
  const { id, body } = e.data || {};
  if (typeof id !== 'number' || typeof body !== 'string' || body.length > 8000) return;
  try {
    const r = await fetch('https://apis.justwatch.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    parent.postMessage({ id, status: r.status, text: await r.text() }, '*');
  } catch (err) {
    parent.postMessage({ id, status: 0, error: String(err) }, '*');
  }
});
parent.postMessage({ ready: true }, '*');
<\/script>`;

function getBridge() {
  if (bridgePromise) return bridgePromise;
  bridgePromise = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = BRIDGE_SRC;
    const pending = new Map();
    let seq = 0;
    const failTimer = setTimeout(() => reject(new Error('bridge did not start')), 8000);

    addEventListener('message', e => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data || {};
      if (d.ready) { clearTimeout(failTimer); resolve(send); return; }
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.status >= 200 && d.status < 300) p.resolve(d.text);
      else p.reject(new Error(d.error || `HTTP ${d.status}`));
    });

    function send(body) {
      return new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        frame.contentWindow.postMessage({ id, body }, '*');
        setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout')); }, 15000);
      });
    }
    document.body.appendChild(frame);
  });
  bridgePromise.catch(() => { bridgePromise = null; });
  return bridgePromise;
}

async function postJustWatch(body) {
  try {
    const send = await getBridge();
    return await send(body);
  } catch (err) {
    if (!RELAY) throw err;
    const r = await fetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error(`relay HTTP ${r.status}`);
    return r.text();
  }
}

class NotFound extends Error {}

async function jw(op, variables = {}, { fresh = false } = {}) {
  const key = JSON.stringify(variables);
  if (!fresh) { const hit = cacheRead(op, key); if (hit) return hit; }
  const text = await postJustWatch(JSON.stringify({ operationName: op, query: Q[op], variables }));
  const json = JSON.parse(text);
  if (json.errors && json.errors.length) {
    if (json.errors.some(e => e.extensions && e.extensions.code === 'NOT_FOUND')) throw new NotFound();
    throw new Error(json.errors[0].message);
  }
  return cacheWrite(op, key, json.data);
}

async function packages() {
  const { data } = await jw('GetPackages');
  return indexPackages(data.packages);
}

// ---------------------------------------------------------------- Globoplay

async function globoplayPlans(url, { fresh = false } = {}) {
  const titleId = (url || '').match(/\/t\/([A-Za-z0-9]+)/)?.[1];
  const videoId = (url || '').match(/\/v\/(\d+)/)?.[1];
  if (!titleId && !videoId) return { error: true };
  const key = titleId || `v${videoId}`;
  if (!fresh) { const hit = cacheRead('Globoplay', key); if (hit) return hit.data; }

  const body = titleId
    ? { query: 'query T($id: String!) { title(titleId: $id) { subscriptionServices { name } } }', variables: { id: titleId } }
    : { query: 'query V($id: ID!) { video(id: $id) { title { subscriptionServices { name } } } }', variables: { id: videoId } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(GLOBO, { method: 'POST', headers: GLOBO_HEADERS, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) return { error: true };
    const d = (await r.json()).data;
    const t = titleId ? d && d.title : d && d.video && d.video.title;
    const answer = { services: t ? (t.subscriptionServices || []).map(s => s.name) : [] };
    cacheWrite('Globoplay', key, answer);
    return answer;
  } catch {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- formatting

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function brl(v) {
  if (v == null) return '';
  // JustWatch stores R$ 19,90 as 19.89; show what the service actually charges.
  let cents = Math.round(v * 100);
  if (cents % 10 === 9) cents += 1;
  return 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function list(names = []) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
}

function runtime(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m} min`;
}

function leaving(dateStr) {
  if (!dateStr) return '';
  const end = new Date(dateStr + 'T23:59:59-03:00');
  const days = Math.ceil((end - Date.now()) / 864e5);
  if (days < 0) return '';
  if (days <= 45) return `<span class="leave soon">sai ${days <= 1 ? 'amanhã' : `em ${days} dias`}</span>`;
  return `<span class="leave">até ${end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>`;
}

function hhmm(t) {
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------------------------------------------------------------- views

function renderMineCount() {
  const n = owned.size;
  $('#mineCount').hidden = !n;
  $('#mineCount').textContent = n;
}

function tileHtml(c) {
  const img = posterUrl(c.posterUrl, 's166');
  return `<a class="tile" href="#${esc(c.fullPath)}">
    ${img ? `<img class="poster" loading="lazy" src="${esc(img)}" alt="">` : '<div class="poster"></div>'}
    <span>${esc(displayTitle(c))}</span></a>`;
}

async function renderHome() {
  document.title = 'Onde Assistir';
  const nudge = owned.size ? '' : `
    <div class="nudge"><p>Marque os serviços que você assina para ver primeiro onde você já pode assistir.</p>
    <button class="btn" type="button" data-open-mine>Marcar</button></div>`;
  const rec = recents.length ? `
    <section class="section"><h2 class="label">Buscas recentes</h2>
      <div class="chips">${recents.map(r => `<a class="chip" href="#${esc(r.path)}">${esc(r.title)}</a>`).join('')}</div></section>` : '';
  view.innerHTML = `${nudge}${rec}
    <section class="section"><h2 class="label">Em alta no Brasil</h2>
      <div class="grid" id="popular">${Array.from({ length: 12 }, () => '<div class="tile"><div class="poster skel"></div></div>').join('')}</div></section>`;
  try {
    const { data } = await jw('GetPopular');
    const grid = $('#popular');
    if (grid) grid.innerHTML = data.popularTitles.edges.map(e => tileHtml(e.node.content)).join('');
  } catch {
    const grid = $('#popular');
    if (grid) grid.outerHTML = errorHtml('Não consegui carregar os filmes em alta agora.');
  }
}

let searchSeq = 0;
let openFirstWhenReady = false;

function searchSkeleton() {
  if (view.querySelector('.results[data-loading]')) return;
  view.innerHTML = `<div class="results" data-loading>${Array.from({ length: 4 }, () => '<div class="result"><div class="ph skel"></div><div style="flex:1"><div class="skel" style="height:14px;width:60%"></div></div></div>').join('')}</div>`;
}

async function renderSearch(q) {
  const my = ++searchSeq;
  searchSkeleton();
  try {
    const { data } = await jw('SearchTitles', { q });
    if (my !== searchSeq) return;
    const edges = data.popularTitles.edges;
    if (!edges.length) { openFirstWhenReady = false; view.innerHTML = `<p class="muted">Nada encontrado para “${esc(q)}”.</p>`; return; }
    view.innerHTML = `<div class="results" data-q="${esc(q)}">${edges.map(({ node }) => {
      const c = node.content;
      const img = posterUrl(c.posterUrl, 's166');
      const t = displayTitle(c);
      const alt = c.originalTitle && c.originalTitle !== t ? c.originalTitle : '';
      return `<a class="result" href="#${esc(c.fullPath)}" data-title="${esc(t)}">
        ${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : '<div class="ph"></div>'}
        <div><div class="t">${esc(t)}</div>
        <div class="m">${esc([c.originalReleaseYear, node.objectType === 'SHOW' ? 'Série' : 'Filme', alt].filter(Boolean).join(' · '))}</div></div></a>`;
    }).join('')}</div>`;
    if (openFirstWhenReady) {
      openFirstWhenReady = false;
      location.hash = view.querySelector('.result').getAttribute('href');
    }
  } catch {
    openFirstWhenReady = false;
    if (my === searchSeq) view.innerHTML = errorHtml('Não consegui buscar agora.', 'retry-search');
  }
}

function errorHtml(msg, action = 'retry') {
  return `<div class="error"><p><strong>${esc(msg)}</strong><br>Verifique a conexão e tente de novo.</p>
    <button class="btn" type="button" data-${action}>Tentar de novo</button></div>`;
}

function rowHtml(r, bucket) {
  const tag = r.url ? 'a' : 'div';
  const attrs = r.url ? ` href="${esc(r.url)}" target="_blank" rel="noopener"` : '';
  const logo = r.icon ? `<img class="logo" loading="lazy" src="${esc(r.icon)}" alt="">` : '<div class="logo"></div>';
  let detail = '', end = '';

  if (bucket === 'included') {
    detail = [r.note, r.monthly != null ? `a partir de ${brl(r.monthly)}/mês` : ''].filter(Boolean).join(' · ');
    end = leaving(r.leavingOn) || (r.quality ? `<span class="leave">${esc(r.quality)}</span>` : '');
  } else if (bucket === 'extra') {
    if (r.kind === 'plan') detail = r.note || 'Plano acima do básico';
    else if (r.comboPrice) detail = 'Combo mensal, também dá acesso ao Telecine';
    else detail = `Canal no ${r.host ? r.host.name : 'serviço'}${r.trialDays ? ` · ${r.trialDays} dias grátis` : ''}`;
    if (r.leavingOn) detail += ` · ${leaving(r.leavingOn)}`;
    // A channel is paid on top of its host; plans and combos are the whole price.
    const plus = r.kind === 'channel' && !r.comboPrice ? '+' : '';
    end = r.monthly != null ? `<span class="price">${plus}${brl(r.monthly)}<small>/mês</small></span>` : '';
  } else if (bucket === 'free') {
    detail = 'Com anúncios';
    end = leaving(r.leavingOn);
  } else if (bucket === 'rent' || bucket === 'buy') {
    detail = r.quality ? `Melhor qualidade: ${esc(r.quality)}` : '';
    end = `<span class="price">${esc(r.priceValue != null ? brl(r.priceValue) : (r.price || ''))}</span>`;
  } else if (bucket === 'cinema') {
    detail = 'Em cartaz';
  }
  if (r.uncertain) detail = `<span class="d warn">${esc(r.uncertain)}</span>`;
  else detail = detail ? `<div class="d">${detail}</div>` : '';

  return `<${tag} class="row"${attrs}>${logo}
    <div class="txt">
      <div class="top"><span class="n">${esc(r.name)}</span>${end ? `<span class="end">${end}</span>` : ''}</div>
      ${r.owned ? '<span class="yours">você assina</span>' : ''}${detail}
    </div></${tag}>`;
}

const GROUPS = [
  ['included', 'Incluído na assinatura', 'ok'],
  ['extra', 'Precisa de plano ou canal extra', 'extra'],
  ['free', 'Grátis', 'ok'],
  ['rent', 'Alugar', 'money'],
  ['buy', 'Comprar', 'money'],
  ['cinema', 'No cinema', 'money'],
];

function answerHtml(s) {
  // Only the entry for s.kind is used; list() tolerates the names the other kinds don't have.
  const pick = {
    owned: ['Você já pode assistir', `No seu ${list(s.names)}.`],
    included: ['Incluído em assinatura', `${list(s.names)}${s.from != null ? ` · a partir de ${brl(s.from)}/mês` : ''}.`],
    free: ['Grátis', `Com anúncios no ${list(s.names)}.`],
    extra: ['Só com plano ou canal extra', s.from != null ? `A partir de ${brl(s.from)}/mês.` : 'Veja as opções abaixo.'],
    rent: ['Só para alugar ou comprar', s.from != null ? `A partir de ${brl(s.from)}.` : ''],
    buy: ['Só para comprar', s.from != null ? `A partir de ${brl(s.from)}.` : ''],
    cinema: ['Em cartaz nos cinemas', `${list(s.names)}.`],
    none: ['Não está em nenhum serviço no Brasil', 'Nem para alugar ou comprar, segundo a JustWatch.'],
  }[s.kind];
  return `<div class="answer tone-${s.tone}"><div class="big">${esc(pick[0])}</div>${pick[1] ? `<div class="sub">${esc(pick[1])}</div>` : ''}</div>`;
}

let current = null;  // { path, node, fetchedAt, globoplay }

async function renderTitle(path, { fresh = false } = {}) {
  view.innerHTML = `
    <button class="back" type="button" data-back>‹ Voltar</button>
    <div class="head"><div class="poster skel"></div><div><div class="skel" style="height:26px;width:80%"></div><div class="skel" style="height:14px;width:40%;margin-top:10px"></div></div></div>
    <div class="skel" style="height:74px;border-radius:14px"></div>
    <div class="skel" style="height:180px;border-radius:14px"></div>`;
  window.scrollTo(0, 0);

  let entry, pkgs;
  try {
    [entry, pkgs] = await Promise.all([jw('GetTitleOffers', { path }, { fresh }), packages()]);
  } catch (err) {
    if (location.hash.slice(1) !== path) return;
    view.innerHTML = `<button class="back" type="button" data-back>‹ Voltar</button>` +
      (err instanceof NotFound ? `<p class="muted">Não encontrei esse título.</p>` : errorHtml('Não consegui consultar a JustWatch agora.'));
    return;
  }
  if (location.hash.slice(1) !== path) return;

  const node = entry.data.url.node;
  const gOffer = (node.offers || []).find(o => o.package.packageId === 307 && o.monetizationType === 'FLATRATE');
  const globoplay = gOffer ? await globoplayPlans(gOffer.standardWebURL, { fresh }) : null;
  if (location.hash.slice(1) !== path) return;

  current = { path, node, fetchedAt: entry.t, globoplay, pkgs };
  const c = node.content;
  const title = displayTitle(c);
  recents = [{ path, title }, ...recents.filter(r => r.path !== path)].slice(0, 8);
  store.set('oa:recent', recents);
  try {
    paintTitle();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<button class="back" type="button" data-back>‹ Voltar</button>` + errorHtml('Algo deu errado ao montar esta página.');
  }
}

function paintTitle() {
  const { path, node, fetchedAt, globoplay, pkgs } = current;
  const c = node.content;
  const title = displayTitle(c);
  document.title = `${title} — Onde Assistir`;
  const b = classify(node.offers, { packages: pkgs, globoplay, owned });
  // Show the original title only for foreign films ("Matrix" / "The Matrix"), never an English
  // fallback under a Brazilian one.
  const other = c.originalTitle && c.originalTitle !== title ? c.originalTitle : '';
  const isShow = node.objectType === 'SHOW';
  const meta = [
    c.originalReleaseYear,
    isShow ? (node.totalSeasonCount ? `Série · ${node.totalSeasonCount} temporada${node.totalSeasonCount > 1 ? 's' : ''}` : 'Série') : 'Filme',
    isShow ? '' : runtime(c.runtime),
  ].filter(Boolean).join(' · ');
  const img = posterUrl(c.posterUrl, 's332');

  const groups = GROUPS.map(([key, label, tone]) => b[key].length ? `
    <section class="group tone-${tone}"><h2 class="label">${label}</h2>
      <div class="list">${b[key].map(r => rowHtml(r, key)).join('')}</div></section>` : '').join('');

  const q = encodeURIComponent(`${title} ${c.originalReleaseYear || ''}`.trim());
  const sources = globoplay ? 'JustWatch e Globoplay' : 'JustWatch';

  view.innerHTML = `
    <button class="back" type="button" data-back>‹ Voltar</button>
    <div class="head">
      ${img ? `<img class="poster" src="${esc(img)}" alt="">` : '<div class="poster"></div>'}
      <div><h1>${esc(title)}</h1>${other ? `<div class="orig">${esc(other)}</div>` : ''}<div class="meta">${esc(meta)}</div></div>
    </div>
    ${answerHtml(b.summary)}
    ${isShow ? '<p class="muted" style="margin:-8px 0 0;font-size:13.5px">Disponibilidade da série; algumas temporadas podem estar em outro lugar.</p>' : ''}
    ${groups}
    <section class="also">
      <h2 class="label">Conferir também</h2>
      <p>Claro tv+, Vivo Play, YouTube e Google TV não publicam o catálogo, então não dá para checar automaticamente.</p>
      <div class="links">
        <a href="https://www.google.com/search?q=onde+assistir+${q}" target="_blank" rel="noopener">Google</a>
        <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' filme')}" target="_blank" rel="noopener">YouTube</a>
        <a href="https://www.clarotvmais.com.br/busca?q=${encodeURIComponent(title)}" target="_blank" rel="noopener">Claro tv+</a>
      </div>
    </section>
    <footer class="foot">
      <div>Consultado às ${hhmm(fetchedAt)} · Dados de ${sources}. <a href="https://www.justwatch.com${esc(path)}" target="_blank" rel="noopener">Ver na JustWatch</a></div>
      <div class="acts">
        <button class="btn ghost" type="button" data-refresh>Atualizar</button>
        <button class="btn ghost" type="button" data-share>Compartilhar</button>
      </div>
    </footer>`;
}

// ---------------------------------------------------------------- routing & events

function route() {
  const path = decodeURIComponent(location.hash.slice(1));
  if (path.startsWith('/br/')) {
    renderTitle(path);
  } else {
    current = null;
    if (input.value.trim().length >= 2) renderSearch(input.value.trim());
    else renderHome();
  }
}

let typingTimer;
input.addEventListener('input', () => {
  const v = input.value.trim();
  $('#clear').hidden = !input.value;
  clearTimeout(typingTimer);
  if (location.hash.slice(1).startsWith('/br/')) {
    // Typing while a title is open goes back to search results.
    if (v.length >= 2) { history.pushState(null, '', '#/'); current = null; }
    else return;
  }
  openFirstWhenReady = false;
  if (v.length < 2) { searchSeq++; renderHome(); return; }
  searchSkeleton();   // clear old results at once so nothing stale can be tapped
  typingTimer = setTimeout(() => renderSearch(v), 280);
});

input.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = input.value.trim();
  if (v.length < 2) return;
  e.preventDefault();
  input.blur();
  const box = view.querySelector('.results[data-q]');
  if (box && box.dataset.q === v && box.querySelector('.result')) {
    location.hash = box.querySelector('.result').getAttribute('href');
  } else {
    clearTimeout(typingTimer);
    openFirstWhenReady = true;
    renderSearch(v);
  }
});

$('#clear').addEventListener('click', () => {
  input.value = '';
  $('#clear').hidden = true;
  searchSeq++;
  if (!location.hash.slice(1).startsWith('/br/')) renderHome();
  input.focus();
});

view.addEventListener('click', async e => {
  const t = e.target.closest('[data-back],[data-refresh],[data-share],[data-retry],[data-retry-search],[data-open-mine],.result');
  if (!t) return;
  if (t.matches('.result')) { input.blur(); return; }
  if (t.hasAttribute('data-back')) {
    // Go back if we navigated here inside the app; a shared link opened cold goes home.
    if (sessionStorage.getItem('oa:inapp')) history.back();
    else location.hash = '#/';
    return;
  }
  if (t.hasAttribute('data-refresh') && current) { renderTitle(current.path, { fresh: true }); return; }
  if (t.hasAttribute('data-retry')) { route(); return; }
  if (t.hasAttribute('data-retry-search')) { renderSearch(input.value.trim()); return; }
  if (t.hasAttribute('data-open-mine')) { openSheet(); return; }
  if (t.hasAttribute('data-share') && current) {
    const title = displayTitle(current.node.content);
    const url = location.href;
    if (navigator.share) { try { await navigator.share({ title, text: `Onde assistir ${title}`, url }); } catch {} }
    else { try { await navigator.clipboard.writeText(url); toast('Link copiado'); } catch { toast(url); } }
  }
});

// ---------------------------------------------------------------- my services sheet

const sheet = $('#sheet');

function openSheet() {
  $('#opts').innerHTML = SERVICES.map(([key, name, hint]) => `
    <label class="opt"><input type="checkbox" value="${key}" ${owned.has(key) ? 'checked' : ''}>
      <span>${esc(name)}${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`).join('');
  sheet.showModal();
  history.pushState({ sheet: true }, '', location.href);
}

function closeSheet(fromPop) {
  if (!sheet.open) return;
  sheet.close();
  if (!fromPop && history.state && history.state.sheet) history.back();
}

$('#mineBtn').addEventListener('click', openSheet);
$('#sheetDone').addEventListener('click', () => closeSheet(false));
sheet.addEventListener('cancel', e => { e.preventDefault(); closeSheet(false); });
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(false); });
$('#opts').addEventListener('change', e => {
  const box = e.target;
  if (box.checked) owned.add(box.value); else owned.delete(box.value);
  store.set('oa:owned', [...owned]);
  renderMineCount();
  if (current) { try { paintTitle(); } catch (err) { console.error(err); } }
  else if (!input.value.trim()) renderHome();
});

addEventListener('popstate', () => { if (sheet.open) closeSheet(true); });
addEventListener('hashchange', () => { sessionStorage.setItem('oa:inapp', '1'); route(); });

// ---------------------------------------------------------------- boot

pruneCache();
renderMineCount();
route();
getBridge().catch(() => {});   // warm up so the first search is quick

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
