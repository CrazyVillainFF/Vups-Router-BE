import { getAdapter } from "../src/plugins/adapters/index.js";

const PUBLIC = [
  "wikipedia",
  "arxiv",
  "crossref",
  "openalex",
  "pubmed",
  "openstreetmap",
  "restcountries",
  "openlibrary",
  "openmeteo",
  "frankfurter",
  "coingecko",
  "hackernews",
  "worldbank",
  "github",
  "dockerhub",
  "npm",
  "pypi",
  "stackoverflow",
  "devto",
  "urlreader",
  "timezone",
  "wikimedia",
  "usgs-earthquakes",
  "tvmaze",
  "pokeapi",
  "zippopotam",
  "musicbrainz",
  "datamuse",
  "free-dictionary",
  "themealdb",
  "coinbase-spot"
];

const CREDENTIALED = [
  ["unsplash", { accessKey: process.env.UNSPLASH_ACCESS_KEY || "" }, {}],
  ["deepl", { apiKey: process.env.DEEPL_API_KEY || "" }, { tier: "free" }]
];

const results = [];
for (const id of PUBLIC) {
  const adapter = getAdapter(id);
  const started = Date.now();
  try {
    const response = await adapter.testConnection({ config: {}, credentials: {}, signal: AbortSignal.timeout(25000) });
    results.push({ id, ok: true, durationMs: Date.now() - started, message: response?.message || "" });
  } catch (error) {
    results.push({ id, ok: false, durationMs: Date.now() - started, error: error?.message || String(error), code: error?.code || "" });
  }
}

for (const [id, credentials, config] of CREDENTIALED) {
  const adapter = getAdapter(id);
  if (!Object.values(credentials).some(Boolean)) {
    results.push({ id, ok: null, skipped: true, reason: "No credential supplied." });
    continue;
  }
  const started = Date.now();
  try {
    const response = await adapter.testConnection({ config, credentials, signal: AbortSignal.timeout(25000) });
    results.push({ id, ok: true, durationMs: Date.now() - started, message: response?.message || "" });
  } catch (error) {
    results.push({ id, ok: false, durationMs: Date.now() - started, error: error?.message || String(error), code: error?.code || "" });
  }
}

console.log(JSON.stringify({
  verified: results.filter(result => result.ok === true).length,
  failed: results.filter(result => result.ok === false).length,
  skipped: results.filter(result => result.ok === null).length,
  results
}, null, 2));

if (results.some(result => result.ok === false)) process.exitCode = 1;
