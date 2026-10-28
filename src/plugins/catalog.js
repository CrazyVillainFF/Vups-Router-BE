const NONE = Object.freeze({ type: "none", label: "No credentials required", fields: [] });
const OAUTH = Object.freeze({ type: "oauth", label: "OAuth connection", fields: [] });
const API_KEY = Object.freeze({
  type: "api_key",
  label: "API key",
  fields: [{ key: "apiKey", label: "API key", type: "password", required: true, secret: true, maxLength: 500 }]
});
const OPTIONAL_TOKEN = Object.freeze({
  type: "optional_api_key",
  label: "Optional access token",
  fields: [{ key: "token", label: "Access token (optional)", type: "password", required: false, secret: true, maxLength: 500 }]
});

const AUTH_OVERRIDES = {
  github: OPTIONAL_TOKEN,
  unsplash: {
    type: "api_key",
    label: "Unsplash access key",
    fields: [{ key: "accessKey", label: "Access key", type: "password", required: true, secret: true, maxLength: 500 }]
  },
  deepl: {
    type: "api_key",
    label: "DeepL API key",
    fields: [
      { key: "apiKey", label: "API key", type: "password", required: true, secret: true, maxLength: 500 },
      {
        key: "tier",
        label: "API plan",
        type: "select",
        required: false,
        secret: false,
        options: [
          { value: "free", label: "Free" },
          { value: "pro", label: "Pro" }
        ]
      }
    ]
  }
};

const SITES = {
  github: "https://github.com",
  "docker-hub": "https://hub.docker.com",
  npm: "https://www.npmjs.com",
  pypi: "https://pypi.org",
  wikipedia: "https://www.wikipedia.org",
  arxiv: "https://arxiv.org",
  crossref: "https://www.crossref.org",
  openalex: "https://openalex.org",
  pubmed: "https://pubmed.ncbi.nlm.nih.gov",
  openstreetmap: "https://www.openstreetmap.org",
  "rest-countries": "https://restcountries.com",
  "open-library": "https://openlibrary.org",
  "usgs-earthquakes": "https://earthquake.usgs.gov",
  zippopotam: "https://api.zippopotam.us",
  musicbrainz: "https://musicbrainz.org",
  tvmaze: "https://www.tvmaze.com",
  themealdb: "https://www.themealdb.com",
  pokeapi: "https://pokeapi.co",
  datamuse: "https://www.datamuse.com",
  "free-dictionary": "https://dictionaryapi.dev",
  "coinbase-spot": "https://www.coinbase.com",
  unsplash: "https://unsplash.com",
  "wikimedia-commons": "https://commons.wikimedia.org",
  "open-meteo": "https://open-meteo.com",
  frankfurter: "https://www.frankfurter.app",
  deepl: "https://www.deepl.com",
  "url-reader": "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
  "time-zone": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat",
  "hacker-news": "https://news.ycombinator.com",
  devto: "https://dev.to",
  stackoverflow: "https://stackoverflow.com",
  coingecko: "https://www.coingecko.com",
  "world-bank": "https://data.worldbank.org"
};

const TOOL_PERMISSIONS = {
  github: ["Read public repositories and issues", "Create issues only when you explicitly confirm"],
  unsplash: ["Search public photos"],
  deepl: ["Translate text you submit"],
  "url-reader": ["Read public web pages"],
  "time-zone": ["Calculate times locally on the server"],
  "openstreetmap": ["Search and reverse-geocode public map data"],
  "world-bank": ["Read public World Bank indicators"],
  "usgs-earthquakes": ["Read the public USGS earthquake feed"],
  zippopotam: ["Look up public postal-code and region data"],
  musicbrainz: ["Search the public MusicBrainz database"],
  tvmaze: ["Search public television show data"],
  themealdb: ["Search public recipe data"],
  pokeapi: ["Read public Pokémon species data"],
  datamuse: ["Look up words in the public Datamuse dataset"],
  "free-dictionary": ["Read public dictionary entries"],
  "coinbase-spot": ["Read public Coinbase spot prices"]
};

const ROWS = [
  ["google-drive", "Google Drive", "productivity", "Find files, folders, and documents in Google Drive.", "oauth"],
  ["google-docs", "Google Docs", "productivity", "Read and search Google Docs documents.", "oauth"],
  ["google-sheets", "Google Sheets", "productivity", "Read rows and values from Google Sheets.", "oauth"],
  ["microsoft-onedrive", "Microsoft OneDrive", "productivity", "Browse files stored in Microsoft OneDrive.", "oauth"],
  ["microsoft-word", "Microsoft Word", "productivity", "Read Word documents stored in Microsoft 365.", "oauth"],
  ["microsoft-excel", "Microsoft Excel", "productivity", "Read workbooks and worksheet values in Microsoft 365.", "oauth"],
  ["notion", "Notion", "productivity", "Search pages and databases in a Notion workspace.", "oauth"],
  ["dropbox", "Dropbox", "productivity", "Search files and folders in Dropbox.", "oauth"],
  ["box", "Box", "productivity", "Find and read files stored in Box.", "oauth"],
  ["sharepoint", "SharePoint", "productivity", "Search sites and documents in Microsoft SharePoint.", "oauth"],

  ["gmail", "Gmail", "communication", "Search and read messages in a Gmail account.", "oauth"],
  ["outlook", "Outlook", "communication", "Search and read messages in Microsoft Outlook.", "oauth"],
  ["slack", "Slack", "communication", "Read channels and search messages in a Slack workspace.", "oauth"],
  ["microsoft-teams", "Microsoft Teams", "communication", "Read channels and messages in Microsoft Teams.", "oauth"],
  ["discord", "Discord", "communication", "Read channels and messages in a Discord server.", "oauth"],
  ["telegram", "Telegram", "communication", "Send and read messages through the Telegram Bot API.", "api"],
  ["zoom", "Zoom", "communication", "List and inspect Zoom meetings.", "oauth"],
  ["google-calendar", "Google Calendar", "communication", "Read events and availability from Google Calendar.", "oauth"],
  ["microsoft-calendar", "Microsoft Calendar", "communication", "Read events and availability from Microsoft 365.", "oauth"],
  ["twilio", "Twilio", "communication", "Send SMS messages through a Twilio account.", "api"],

  ["github", "GitHub", "developer", "Search repositories, inspect issues, and create issues with an optional token.", "optional", "github"],
  ["gitlab", "GitLab", "developer", "Search projects and inspect merge requests in GitLab.", "oauth"],
  ["bitbucket", "Bitbucket", "developer", "Search repositories and pull requests in Bitbucket.", "oauth"],
  ["jira", "Jira", "developer", "Search issues and projects in Atlassian Jira.", "oauth"],
  ["linear", "Linear", "developer", "Read teams, projects, and issues in Linear.", "oauth"],
  ["confluence", "Confluence", "developer", "Search pages and spaces in Atlassian Confluence.", "oauth"],
  ["sentry", "Sentry", "developer", "Read projects, issues, and events from Sentry.", "oauth"],
  ["datadog", "Datadog", "developer", "Query monitors, dashboards, and logs in Datadog.", "api"],
  ["docker-hub", "Docker Hub", "developer", "Search public container images and inspect repository metadata.", "none", "dockerhub"],
  ["kubernetes", "Kubernetes", "developer", "Inspect cluster resources through a configured Kubernetes API.", "api"],
  ["npm", "npm Registry", "developer", "Search npm packages and read package metadata.", "none", "npm"],
  ["pypi", "PyPI", "developer", "Read package metadata from the Python Package Index.", "none", "pypi"],
  ["postman", "Postman", "developer", "Browse Postman collections and environments.", "api"],

  ["postgresql", "PostgreSQL", "data", "Query a PostgreSQL database with a restricted connection.", "api"],
  ["mysql", "MySQL", "data", "Query a MySQL database with a restricted connection.", "api"],
  ["mongodb", "MongoDB", "data", "Read collections in a MongoDB database.", "api"],
  ["redis", "Redis", "data", "Read keys and values from a Redis instance.", "api"],
  ["supabase", "Supabase", "data", "Read tables and rows from a Supabase project.", "api"],
  ["firebase", "Firebase", "data", "Read Firestore documents and collections.", "oauth"],
  ["turso", "Turso", "data", "Query a Turso/libSQL database.", "api"],
  ["neon", "Neon", "data", "Query a Neon PostgreSQL database.", "api"],
  ["planetscale", "PlanetScale", "data", "Query a PlanetScale MySQL database.", "api"],
  ["aws", "Amazon Web Services", "data", "Inspect selected AWS resources with scoped credentials.", "api"],
  ["google-cloud", "Google Cloud", "data", "Inspect selected Google Cloud resources with scoped credentials.", "oauth"],
  ["microsoft-azure", "Microsoft Azure", "data", "Inspect selected Azure resources with scoped credentials.", "oauth"],
  ["cloudflare", "Cloudflare", "data", "Read zones, DNS records, and selected analytics from Cloudflare.", "api"],

  ["zapier", "Zapier", "automation", "Trigger Zaps and inspect automation activity.", "oauth"],
  ["make", "Make", "automation", "Trigger Make scenarios and inspect runs.", "oauth"],
  ["n8n", "n8n", "automation", "Call n8n workflows through a scoped webhook or API.", "api"],
  ["ifttt", "IFTTT", "automation", "Trigger IFTTT applets through the Webhooks service.", "api"],
  ["webhooks", "Webhooks", "automation", "Send signed HTTP requests to an approved webhook endpoint.", "none"],

  ["wikipedia", "Wikipedia", "research", "Search articles and read concise page summaries.", "none", "wikipedia"],
  ["arxiv", "arXiv", "research", "Search preprint papers and read their abstracts.", "none", "arxiv"],
  ["crossref", "Crossref", "research", "Search scholarly works and citation metadata.", "none", "crossref"],
  ["openalex", "OpenAlex", "research", "Search scholarly works, authors, and citation counts.", "none", "openalex"],
  ["pubmed", "PubMed", "research", "Search biomedical literature indexed by PubMed.", "none", "pubmed"],
  ["openstreetmap", "OpenStreetMap", "research", "Search places and reverse-geocode coordinates with Nominatim.", "none", "openstreetmap"],
  ["rest-countries", "REST Countries", "research", "Look up country facts, currencies, languages, and flags.", "none", "restcountries"],
  ["open-library", "Open Library", "research", "Search books and read bibliographic metadata.", "none", "openlibrary"],
  ["usgs-earthquakes", "USGS Earthquakes", "research", "Read the live USGS feed of recent earthquakes with magnitude and depth.", "none", "usgs-earthquakes"],
  ["zippopotam", "Zippopotam.us", "research", "Look up places, states, and coordinates behind a postal code.", "none", "zippopotam"],
  ["musicbrainz", "MusicBrainz", "research", "Search the MusicBrainz encyclopedia for artists, releases, and recordings.", "none", "musicbrainz"],

  ["youtube", "YouTube", "media", "Search videos and read public video metadata.", "oauth"],
  ["vimeo", "Vimeo", "media", "Search videos and read public video metadata.", "oauth"],
  ["unsplash", "Unsplash", "media", "Search high-quality photos with an Unsplash access key.", "api", "unsplash"],
  ["wikimedia-commons", "Wikimedia Commons", "media", "Search freely licensed images and read attribution metadata.", "none", "wikimedia"],
  ["contentful", "Contentful", "media", "Read content entries and assets from Contentful.", "api"],
  ["tvmaze", "TVmaze", "media", "Search television shows and read their season and network details.", "none", "tvmaze"],
  ["themealdb", "TheMealDB", "media", "Search free recipe data with ingredients, categories, and images.", "none", "themealdb"],

  ["stripe", "Stripe", "business", "Read customers, invoices, and payment metadata from Stripe.", "api"],
  ["shopify", "Shopify", "business", "Read products, orders, and customers from a Shopify store.", "oauth"],
  ["woocommerce", "WooCommerce", "business", "Read products and orders from WooCommerce.", "api"],
  ["hubspot", "HubSpot", "business", "Search contacts, companies, and deals in HubSpot.", "oauth"],
  ["salesforce", "Salesforce", "business", "Query records in a Salesforce organization.", "oauth"],
  ["pipedrive", "Pipedrive", "business", "Read deals, people, and organizations in Pipedrive.", "oauth"],
  ["airtable", "Airtable", "business", "Read records from an Airtable base.", "api"],
  ["zendesk", "Zendesk", "business", "Search tickets and users in Zendesk.", "oauth"],

  ["grafana", "Grafana", "analytics", "Query dashboards and data sources in Grafana.", "api"],
  ["google-analytics", "Google Analytics", "analytics", "Read reports from a Google Analytics property.", "oauth"],
  ["mixpanel", "Mixpanel", "analytics", "Query events and funnels in Mixpanel.", "api"],
  ["plausible", "Plausible", "analytics", "Read site traffic and goal metrics from Plausible.", "api"],
  ["posthog", "PostHog", "analytics", "Query events, persons, and insights in PostHog.", "api"],

  ["open-meteo", "Open-Meteo", "utilities", "Read current weather and short forecasts for any coordinates.", "none", "openmeteo"],
  ["frankfurter", "Frankfurter", "utilities", "Read exchange rates and currency conversions.", "none", "frankfurter"],
  ["deepl", "DeepL", "utilities", "Translate text with a DeepL API key.", "api", "deepl"],
  ["url-reader", "URL Reader", "utilities", "Read public web pages with SSRF-safe URL validation.", "none", "urlreader"],
  ["time-zone", "Time Zone", "utilities", "Calculate the current time in any IANA time zone.", "none", "timezone"],
  ["hacker-news", "Hacker News", "utilities", "Read top stories and item details from Hacker News.", "none", "hackernews"],
  ["devto", "DEV Community", "utilities", "Read recent articles and tags from DEV Community.", "none", "devto"],
  ["stackoverflow", "Stack Overflow", "utilities", "Search Stack Overflow questions and answers.", "none", "stackoverflow"],
  ["coingecko", "CoinGecko", "utilities", "Read public cryptocurrency prices and market data.", "none", "coingecko"],
  ["world-bank", "World Bank Data", "utilities", "Read public World Bank development indicators.", "none", "worldbank"],
  ["pokeapi", "PokéAPI", "utilities", "Read species, stats, and type data from the open Pokémon database.", "none", "pokeapi"],
  ["datamuse", "Datamuse", "utilities", "Find words by rhyme, meaning, sound, or spelling.", "none", "datamuse"],
  ["free-dictionary", "Free Dictionary", "utilities", "Read English definitions, pronunciations, and example sentences.", "none", "free-dictionary"],
  ["coinbase-spot", "Coinbase Spot Prices", "utilities", "Read the current Coinbase spot price for any currency pair.", "none", "coinbase-spot"]
];

function authFor(code) {
  if (code === "none") return NONE;
  if (code === "optional") return OPTIONAL_TOKEN;
  if (code === "api") return API_KEY;
  return OAUTH;
}

function availabilityFor(auth, adapter) {
  if (!adapter) return "in_development";
  if (auth.type === "none" || auth.type === "optional_api_key") return "available";
  if (auth.type === "api_key") return "requires_setup";
  return "oauth_required";
}

function permissionsFor(id, auth) {
  if (TOOL_PERMISSIONS[id]) return TOOL_PERMISSIONS[id];
  if (auth.type === "none") return ["Read public data"];
  if (auth.type === "optional_api_key") return ["Read public data", "Use your optional token when provided"];
  if (auth.type === "api_key") return ["Use the API key you provide"];
  return ["Access data you authorize"];
}

export const PLUGIN_CATALOG = Object.freeze(ROWS.map(([id, name, category, description, authCode, adapter]) => {
  const auth = AUTH_OVERRIDES[id] || authFor(authCode);
  return Object.freeze({
    id,
    name,
    category,
    description,
    auth,
    adapter: adapter || null,
    website: SITES[id] || "",
    implemented: Boolean(adapter),
    availability: availabilityFor(auth, adapter),
    permissions: permissionsFor(id, auth)
  });
}));

const BY_ID = new Map(PLUGIN_CATALOG.map(plugin => [plugin.id, plugin]));

export function getPlugin(id) {
  return BY_ID.get(String(id || "")) || null;
}

export function catalogSummary() {
  const summary = {
    catalog: PLUGIN_CATALOG.length,
    implemented: 0,
    available: 0,
    requiresSetup: 0,
    oauthRequired: 0,
    inDevelopment: 0
  };
  for (const plugin of PLUGIN_CATALOG) {
    if (plugin.implemented) summary.implemented += 1;
    if (plugin.availability === "available") summary.available += 1;
    else if (plugin.availability === "requires_setup") summary.requiresSetup += 1;
    else if (plugin.availability === "oauth_required") summary.oauthRequired += 1;
    else summary.inDevelopment += 1;
  }
  return summary;
}
