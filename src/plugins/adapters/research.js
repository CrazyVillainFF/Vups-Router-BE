import { boundedText, queryString, requestJson, requestText } from "../http.js";
import { integer, object, text } from "./schema.js";

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function xmlTag(entry, tag) {
  const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]).replace(/\s+/g, " ").trim() : "";
}

function arxivEntries(xml, limit) {
  return [...String(xml || "").matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .slice(0, limit)
    .map(match => {
      const entry = match[1];
      const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
        .slice(0, 8)
        .map(author => decodeXml(author[1]).trim())
        .filter(Boolean);
      return {
        id: xmlTag(entry, "id"),
        title: xmlTag(entry, "title"),
        summary: boundedText(xmlTag(entry, "summary"), 1200),
        published: xmlTag(entry, "published"),
        authors
      };
    });
}

const wikipedia = {
  id: "wikipedia",
  tools: [
    {
      name: "search",
      description: "Search Wikipedia articles and return titles, snippets, and page URLs.",
      inputSchema: object({
        query: text("Search terms.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    },
    {
      name: "summary",
      description: "Read the lead summary of a Wikipedia article.",
      inputSchema: object({ title: text("Exact article title.", { minLength: 1, maxLength: 300 }) }, ["title"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "OpenAI", limit: 1 }, { signal });
    return { message: "Wikipedia search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "search") {
      const limit = args.limit ?? 5;
      const payload = await requestJson(
        `https://en.wikipedia.org/w/api.php?${queryString({
          action: "query",
          list: "search",
          srsearch: args.query,
          srlimit: limit,
          format: "json",
          origin: "*"
        })}`,
        { signal }
      );
      const results = (payload?.query?.search || []).map(item => ({
        title: item.title,
        snippet: boundedText(String(item.snippet || "").replace(/<[^>]+>/g, ""), 500),
        pageId: item.pageid,
        url: `https://en.wikipedia.org/?curid=${item.pageid}`
      }));
      return { query: args.query, results };
    }
    if (tool === "summary") {
      const payload = await requestJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(args.title)}`,
        { signal }
      );
      return {
        title: payload?.title || args.title,
        description: payload?.description || "",
        extract: boundedText(payload?.extract || "", 4000),
        url: payload?.content_urls?.desktop?.page || ""
      };
    }
    throw new Error("Unknown Wikipedia tool.");
  }
};

const arxiv = {
  id: "arxiv",
  tools: [
    {
      name: "search",
      description: "Search arXiv preprints and return titles, abstracts, and authors.",
      inputSchema: object({
        query: text("Search terms.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "large language models", limit: 1 }, { signal });
    return { message: "arXiv search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown arXiv tool.");
    const limit = args.limit ?? 5;
    const xml = await requestText(
      `https://export.arxiv.org/api/query?${queryString({
        search_query: `all:${args.query}`,
        start: 0,
        max_results: limit
      })}`,
      { signal }
    );
    return { query: args.query, results: arxivEntries(xml, limit) };
  }
};

const crossref = {
  id: "crossref",
  tools: [
    {
      name: "search",
      description: "Search Crossref for scholarly works and citation metadata.",
      inputSchema: object({
        query: text("Search terms.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "machine learning", limit: 1 }, { signal });
    return { message: "Crossref search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown Crossref tool.");
    const limit = args.limit ?? 5;
    const payload = await requestJson(
      `https://api.crossref.org/works?${queryString({
        query: args.query,
        rows: limit,
        select: "DOI,title,author,published,URL,type"
      })}`,
      { signal }
    );
    const results = (payload?.message?.items || []).map(item => ({
      doi: item.DOI,
      title: boundedText(Array.isArray(item.title) ? item.title[0] : item.title, 400),
      authors: (item.author || []).slice(0, 8).map(author => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean),
      published: item.published?.["date-parts"]?.[0]?.join("-") || "",
      type: item.type || "",
      url: item.URL || ""
    }));
    return { query: args.query, results };
  }
};

const openalex = {
  id: "openalex",
  tools: [
    {
      name: "search",
      description: "Search OpenAlex for scholarly works and citation counts.",
      inputSchema: object({
        query: text("Search terms.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "artificial intelligence", limit: 1 }, { signal });
    return { message: "OpenAlex search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown OpenAlex tool.");
    const limit = args.limit ?? 5;
    const payload = await requestJson(
      `https://api.openalex.org/works?${queryString({
        search: args.query,
        "per-page": limit,
        select: "id,doi,title,publication_year,cited_by_count,primary_location,authorships"
      })}`,
      { signal }
    );
    const results = (payload?.results || []).map(item => ({
      id: item.id,
      doi: item.doi || "",
      title: boundedText(item.title, 400),
      year: item.publication_year ?? null,
      citedBy: item.cited_by_count ?? null,
      source: item.primary_location?.source?.display_name || "",
      authors: (item.authorships || []).slice(0, 8).map(author => author.author?.display_name).filter(Boolean)
    }));
    return { query: args.query, results };
  }
};

const pubmed = {
  id: "pubmed",
  tools: [
    {
      name: "search",
      description: "Search PubMed for biomedical literature and return article summaries.",
      inputSchema: object({
        query: text("Search terms.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "CRISPR", limit: 1 }, { signal });
    return { message: "PubMed search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown PubMed tool.");
    const limit = args.limit ?? 5;
    const search = await requestJson(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${queryString({
        db: "pubmed",
        term: args.query,
        retmode: "json",
        retmax: limit
      })}`,
      { signal }
    );
    const ids = search?.esearchresult?.idlist || [];
    if (!ids.length) return { query: args.query, results: [] };
    const summaries = await requestJson(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${queryString({
        db: "pubmed",
        id: ids.join(","),
        retmode: "json"
      })}`,
      { signal }
    );
    const results = ids.map(id => {
      const item = summaries?.result?.[id] || {};
      return {
        pmid: id,
        title: boundedText(item.title, 500),
        journal: item.fulljournalname || item.source || "",
        published: item.pubdate || "",
        authors: (item.authors || []).slice(0, 8).map(author => author.name).filter(Boolean),
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
      };
    });
    return { query: args.query, results };
  }
};

const openstreetmap = {
  id: "openstreetmap",
  tools: [
    {
      name: "search",
      description: "Search OpenStreetMap places with Nominatim.",
      inputSchema: object({
        query: text("Place name or address.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    },
    {
      name: "reverse",
      description: "Reverse-geocode latitude and longitude into an address.",
      inputSchema: object({
        latitude: { type: "number", description: "Latitude.", minimum: -90, maximum: 90 },
        longitude: { type: "number", description: "Longitude.", minimum: -180, maximum: 180 }
      }, ["latitude", "longitude"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "Eiffel Tower", limit: 1 }, { signal });
    return { message: "OpenStreetMap search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "search") {
      const payload = await requestJson(
        `https://nominatim.openstreetmap.org/search?${queryString({
          format: "jsonv2",
          q: args.query,
          limit: args.limit ?? 5,
          addressdetails: 1
        })}`,
        { signal }
      );
      return {
        query: args.query,
        results: (payload || []).map(item => ({
          name: item.display_name,
          latitude: Number(item.lat),
          longitude: Number(item.lon),
          type: item.type || "",
          category: item.category || ""
        }))
      };
    }
    if (tool === "reverse") {
      const payload = await requestJson(
        `https://nominatim.openstreetmap.org/reverse?${queryString({
          format: "jsonv2",
          lat: args.latitude,
          lon: args.longitude,
          addressdetails: 1
        })}`,
        { signal }
      );
      return {
        name: payload?.display_name || "",
        latitude: Number(payload?.lat),
        longitude: Number(payload?.lon),
        address: payload?.address || {}
      };
    }
    throw new Error("Unknown OpenStreetMap tool.");
  }
};

const restcountries = {
  id: "restcountries",
  tools: [
    {
      name: "country",
      description: "Look up a country by name and return capital, region, population, currencies, languages, and flag.",
      inputSchema: object({ name: text("Country name.", { minLength: 1, maxLength: 120 }) }, ["name"])
    },
    {
      name: "region",
      description: "List countries in a region.",
      inputSchema: object({
        region: text("Region such as Africa, Americas, Asia, Europe, or Oceania.", { minLength: 1, maxLength: 40 }),
        limit: integer("Number of results (1-20).", { minimum: 1, maximum: 20 })
      }, ["region"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("country", { name: "France" }, { signal });
    return { message: "REST Countries is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "country") {
      const payload = await requestJson(
        `https://restcountries.com/v3.1/name/${encodeURIComponent(args.name)}?fields=name,capital,region,subregion,population,currencies,languages,flags`,
        { signal }
      );
      const item = Array.isArray(payload) ? payload[0] : null;
      if (!item) return { name: args.name, country: null };
      return {
        name: item.name?.common || args.name,
        officialName: item.name?.official || "",
        capital: item.capital || [],
        region: item.region || "",
        subregion: item.subregion || "",
        population: item.population ?? null,
        currencies: item.currencies || {},
        languages: item.languages || {},
        flag: item.flags?.svg || item.flags?.png || ""
      };
    }
    if (tool === "region") {
      const limit = args.limit ?? 10;
      const payload = await requestJson(
        `https://restcountries.com/v3.1/region/${encodeURIComponent(args.region)}?fields=name,capital,population`,
        { signal }
      );
      return {
        region: args.region,
        results: (Array.isArray(payload) ? payload : []).slice(0, limit).map(item => ({
          name: item.name?.common || "",
          capital: item.capital || [],
          population: item.population ?? null
        }))
      };
    }
    throw new Error("Unknown REST Countries tool.");
  }
};

const openlibrary = {
  id: "openlibrary",
  tools: [
    {
      name: "search",
      description: "Search Open Library for books and return titles, authors, and publication years.",
      inputSchema: object({
        query: text("Book title, author, or subject.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "The Left Hand of Darkness", limit: 1 }, { signal });
    return { message: "Open Library search is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown Open Library tool.");
    const limit = args.limit ?? 5;
    const payload = await requestJson(
      `https://openlibrary.org/search.json?${queryString({
        q: args.query,
        limit,
        fields: "key,title,author_name,first_publish_year,edition_count"
      })}`,
      { signal }
    );
    return {
      query: args.query,
      results: (payload?.docs || []).map(item => ({
        key: item.key,
        title: item.title || "",
        authors: item.author_name || [],
        firstPublished: item.first_publish_year ?? null,
        editions: item.edition_count ?? null,
        url: item.key ? `https://openlibrary.org${item.key}` : ""
      }))
    };
  }
};

export const researchAdapters = {
  wikipedia,
  arxiv,
  crossref,
  openalex,
  pubmed,
  openstreetmap,
  restcountries,
  openlibrary
};
