# Onde Assistir

Where can I watch this movie or series **in Brazil**, right now — and what does it cost?

**Live:** https://vergarac.github.io/onde-assistir/

For any title it answers:

- **Incluído na assinatura** — included in a subscription (Netflix, Prime Video, Globoplay, Disney+, HBO Max, Apple TV…)
- **Precisa de plano ou canal extra** — needs a paid channel inside another service (e.g. Telecine or MGM+ inside Prime Video) or a higher plan (Globoplay Premium), with the monthly price
- **Grátis**, **Alugar**, **Comprar**, **No cinema** — with prices in BRL
- **Não está em nenhum serviço no Brasil** — when it isn't available at all

Mark the services you pay for under **Meus serviços** and it tells you when you can already watch.

## How it works

Static site on GitHub Pages. No server, no API keys, no cost.

| Source | Used for | How it's reached |
| --- | --- | --- |
| JustWatch GraphQL (unofficial) | availability, rent/buy prices, channel prices, leaving dates, links | sandboxed `srcdoc` iframe (origin `null`, which JustWatch's CORS allows; github.io is not allowed) |
| Globoplay GraphQL | which Globoplay plan unlocks a title (basic / Premium / Telecine) | direct `fetch` — CORS is open |

Accuracy rules live in [`classify.js`](classify.js):

- Channels are detected by JustWatch's `addonParent` **or** by name (`… Amazon Channel`, `… Apple TV Channel`) — the field alone misses ~36% of Brazilian channels.
- A service you can subscribe to directly is shown once, as itself (HBO Max is not also listed as a Prime channel).
- Ad tiers (Prime Video with Ads, Netflix with Ads) are folded into their service, not shown as extras.
- JustWatch lists many Globoplay titles as plain "Globoplay", but ~70% of them are not in the basic plan. Globoplay's own API decides: basic plan, Premium, or the Telecine combo.
- Brazilian productions keep their Portuguese title (JustWatch's pt-BR localisation often falls back to English).

## Known gaps

Claro tv+, Vivo Play, YouTube and Google TV don't publish their catalogues. The app links to a search on each instead of guessing.

## Staying correct

Both APIs change without notice, and the dangerous failure is silent: the app keeps working
while saying something false. In October 2026 Globoplay renamed its cheapest plan from
"Padrão com Anúncios" to "com anúncios"; an exact-string match stopped recognising it and
every ad-plan film was reported as needing Premium. Nothing errored.

`checkup.mjs` guards that class of bug — it verifies the transport, every field the app reads,
that **all** Globoplay plan labels are ones `classify.js` can place, that prices are in reais
and plausible, and that no Globoplay row appears without naming its plan. It runs daily on
GitHub Actions and opens an issue (which GitHub emails) when something breaks.

Globoplay's prices are not in any readable API — JustWatch served the pre-October numbers for
weeks — so they live in `GLOBO_PRICES` in `classify.js`, with an `asOf` date the checkup warns on.

## Develop

```bash
python3 -m http.server 4180      # then open http://localhost:4180
node test.mjs                    # live regression test against JustWatch + Globoplay
node checkup.mjs                 # the daily health check, run by hand
```

`worker.js` is an optional Cloudflare Worker relay. It's only needed if the sandboxed-iframe route ever stops working; set `RELAY` in `app.js` to its URL.

Availability data by [JustWatch](https://www.justwatch.com/br). Not affiliated with JustWatch, Globoplay or any streaming service.
