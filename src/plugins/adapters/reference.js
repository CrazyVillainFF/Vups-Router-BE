import { PluginError } from "../errors.js";
import { boundedText, queryString, requestJson, requestText } from "../http.js";
import { integer, listResult, object, text } from "./schema.js";

const FEED_MAGNITUDES = new Set(["all", "1.0", "2.5", "4.5"]);
const FEED_PERIODS = new Set(["hour", "day", "week", "month"]);

const usgsEarthquakes = {
  id: "usgs-earthquakes",
  tools: [
    {
      name: "recent",
      description: "List the most recent earthquakes from the USGS live feed, newest first.",
      inputSchema: object({
        magnitude: text("Minimum magnitude band: all, 1.0, 2.5, or 4.5.", { maxLength: 4 }),
        period: text("Feed window: hour, day, week, or month.", { maxLength: 6 }),
        limit: integer("Maximum earthquakes to return (1-50).", { minimum: 1, maximum: 50 })
      })
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson", { signal });
    if (!Array.isArray(payload?.features)) throw new Error("The USGS feed did not return a feature list.");
    return { message: "The USGS earthquake feed is responding.", featureCount: payload.features.length };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "recent") throw new Error("Unknown USGS Earthquakes tool.");
    const magnitude = FEED_MAGNITUDES.has(args.magnitude) ? args.magnitude : "all";
    const period = FEED_PERIODS.has(args.period) ? args.period : "day";
    const payload = await requestJson(
      `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${magnitude}_${period}.geojson`,
      { signal }
    );
    const features = [...(payload?.features || [])]
      .sort((a, b) => (b?.properties?.time || 0) - (a?.properties?.time || 0))
      .slice(0, args.limit ?? 20);
    return listResult(
      features.map(feature => ({
        title: boundedText(feature?.properties?.title, 300),
        magnitude: feature?.properties?.mag ?? null,
        place: boundedText(feature?.properties?.place, 300),
        time: feature?.properties?.time ? new Date(feature.properties.time).toISOString() : "",
        depthKm: feature?.geometry?.coordinates?.[2] ?? null,
        latitude: feature?.geometry?.coordinates?.[1] ?? null,
        longitude: feature?.geometry?.coordinates?.[0] ?? null,
        detailUrl: feature?.properties?.url || ""
      })),
      "earthquakes"
    );
  }
};

const tvmaze = {
  id: "tvmaze",
  tools: [
    {
      name: "search_shows",
      description: "Search TheTVmaze's public database for television shows.",
      inputSchema: object({
        query: text("Show name to search for.", { minLength: 1, maxLength: 200 }),
        limit: integer("Maximum shows to return (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    },
    {
      name: "show_details",
      description: "Read a TVmaze show by its numeric id, including genres, network, and season count.",
      inputSchema: object({
        showId: integer("TVmaze show id.")
      }, ["showId"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://api.tvmaze.com/shows/8", { signal });
    if (!payload?.id) throw new Error("TVmaze returned no show record.");
    return { message: "TVmaze is responding.", show: payload.name };
  },
  async execute(tool, args, { signal }) {
    if (tool === "search_shows") {
      const payload = await requestJson(
        `https://api.tvmaze.com/search/shows?${queryString({ q: args.query })}`,
        { signal }
      );
      const shows = (Array.isArray(payload) ? payload : []).slice(0, args.limit ?? 5).map(entry => entry?.show || entry);
      return listResult(shows.map(show => ({
        id: show?.id ?? null,
        name: boundedText(show?.name, 200),
        year: show?.premiered?.slice(0, 4) || "",
        status: show?.status || "",
        genres: Array.isArray(show?.genres) ? show.genres : [],
        network: show?.network?.name || show?.networks?.[0]?.name || "",
        summary: boundedText(String(show?.summary || "").replace(/<\/?p>/g, ""), 600),
        url: show?.url || ""
      })), "shows");
    }
    if (tool === "show_details") {
      const id = Number(args.showId);
      if (!Number.isInteger(id) || id < 1) throw new Error("Enter a positive TVmaze show id.");
      const payload = await requestJson(`https://api.tvmaze.com/shows/${id}?${queryString({ embed: "seasons" })}`, { signal });
      const show = payload?.id ? payload : null;
      if (!show) throw new Error("No TVmaze show has that id.");
      return {
        id: show.id,
        name: boundedText(show.name, 200),
        premiered: show.premiered || "",
        ended: show.ended || "",
        status: show.status || "",
        genres: Array.isArray(show.genres) ? show.genres : [],
        language: show.language || "",
        network: show.network?.name || "",
        country: show.network?.country?.name || "",
        averageRuntime: show.averageRuntime ?? null,
        seasons: (payload?.embedded?.seasons || []).map(season => ({
          number: season?.number ?? null,
          name: boundedText(season?.name, 200),
          episodeCount: season?.episodeOrder ?? null,
          premiere: season?.premiere || "",
          finale: season?.finale || ""
        })),
        seasonCount: Array.isArray(payload?.embedded?.seasons) ? payload.embedded.seasons.length : 0,
        rating: show.rating?.average ?? null,
        summary: boundedText(String(show.summary || "").replace(/<\/?p>/g, ""), 1500),
        url: show.url || ""
      };
    }
    throw new Error("Unknown TVmaze tool.");
  }
};

const pokeapi = {
  id: "pokeapi",
  tools: [
    {
      name: "get_pokemon",
      description: "Read a Pokémon species record from PokéAPI by name or National Dex number.",
      inputSchema: object({
        nameOrId: text("Pokémon name (lowercase) or dex number.", { minLength: 1, maxLength: 40 })
      }, ["nameOrId"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://pokeapi.co/api/v2/pokemon/1", { signal });
    if (!payload?.name) throw new Error("PokéAPI returned no Pokémon record.");
    return { message: "PokéAPI is responding.", sample: payload.name };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "get_pokemon") throw new Error("Unknown PokéAPI tool.");
    const key = String(args.nameOrId || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!key) throw new Error("Enter a Pokémon name or dex number.");
    const payload = await requestJson(`https://pokeapi.co/api/v2/pokemon/${key}`, { signal });
    if (!payload?.name) throw new Error("PokéAPI has no record for that Pokémon.");
    return {
      id: payload.id ?? null,
      name: payload.name,
      height: payload.height ?? null,
      weight: payload.weight ?? null,
      baseExperience: payload.base_experience ?? null,
      types: (payload.types || []).map(entry => entry?.type?.name).filter(Boolean),
      abilities: (payload.abilities || []).filter(entry => entry?.is_hidden !== true)
        .map(entry => entry?.ability?.name).filter(Boolean),
      stats: (payload.stats || []).map(entry => ({
        name: entry?.stat?.name,
        base: entry?.base_stat ?? null
      })),
      gameVersions: (payload.version_details || []).map(entry => entry?.version?.name).filter(Boolean).slice(0, 20)
    };
  }
};

const zippopotam = {
  id: "zippopotam",
  tools: [
    {
      name: "lookup_postal_code",
      description: "Look up places for a postal code using the Zippopotam.us public dataset.",
      inputSchema: object({
        country: text("Two-letter ISO country code, such as US or DE.", { minLength: 2, maxLength: 2 }),
        postalCode: text("Postal code.", { minLength: 1, maxLength: 20 })
      }, ["country", "postalCode"])
    },
    {
      name: "list_states",
      description: "List the states or regions of a country for postal-code lookups.",
      inputSchema: object({
        country: text("Two-letter ISO country code, such as US.", { minLength: 2, maxLength: 2 })
      }, ["country"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://api.zippopotam.us/us/90210", { signal });
    if (!Array.isArray(payload?.places)) throw new Error("Zippopotam.us returned no places.");
    return { message: "Zippopotam.us is responding.", country: payload.country };
  },
  async execute(tool, args, { signal }) {
    const country = String(args.country || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (country.length !== 2) throw new Error("Enter a two-letter ISO country code.");
    if (tool === "lookup_postal_code") {
      const code = String(args.postalCode || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "");
      if (!code) throw new Error("Enter a postal code.");
      const payload = await requestJson(`https://api.zippopotam.us/${country}/${encodeURIComponent(code)}`, { signal });
      return {
        country: payload?.country || "",
        countryAbbreviation: payload?.["country abbreviation"] || country.toUpperCase(),
        postalCode: payload?.["post code"] || code,
        places: (payload?.places || []).map(place => ({
          name: boundedText(place?.place_name, 200),
          state: place?.["state"] || "",
          stateCode: place?.["state abbreviation"] || "",
          latitude: place?.["latitude"] || "",
          longitude: place?.["longitude"] || ""
        })),
        count: Array.isArray(payload?.places) ? payload.places.length : 0
      };
    }
    if (tool === "list_states") {
      const payload = await requestJson(`https://api.zippopotam.us/${country}`, { signal });
      const states = Array.isArray(payload?.states) ? payload.states : [];
      return listResult(states.map(state => ({
        code: state?.["abbreviation"] || "",
        name: boundedText(state?.name, 200)
      })), "states");
    }
    throw new Error("Unknown Zippopotam.us tool.");
  }
};

const MUSICBRAINZ_ENDPOINTS = { artist: "artist", recording: "recording", release: "release", label: "label" };

const musicbrainz = {
  id: "musicbrainz",
  tools: [
    {
      name: "search",
      description: "Search the MusicBrainz open music encyclopedia for artists, recordings, releases, or labels.",
      inputSchema: object({
        entity: text("What to search: artist, recording, release, or label.", { maxLength: 10 }),
        query: text("Search query.", { minLength: 1, maxLength: 300 }),
        limit: integer("Maximum results (1-25).", { minimum: 1, maximum: 25 })
      }, ["entity", "query"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson(
      `https://musicbrainz.org/ws/2/artist?${queryString({ query: "Radiohead", fmt: "json", limit: 1 })}`,
      { signal }
    );
    if (!Array.isArray(payload?.artists)) throw new Error("MusicBrainz returned no artist results.");
    return { message: "MusicBrainz is responding.", sample: payload.artists[0]?.name || "" };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown MusicBrainz tool.");
    const entity = MUSICBRAINZ_ENDPOINTS[String(args.entity || "").toLowerCase()];
    if (!entity) throw new Error("Choose artist, recording, release, or label.");
    const payload = await requestJson(
      `https://musicbrainz.org/ws/2/${entity}?${queryString({
        query: args.query,
        fmt: "json",
        limit: args.limit ?? 10
      })}`,
      { signal }
    );
    const rows = payload?.[`${entity}s`] || [];
    return {
      entity,
      query: args.query,
      count: rows.length,
      total: payload?.["hit-count"] ?? null,
      results: rows.map(row => ({
        id: row.id,
        name: boundedText(row.name || row.title, 300),
        sortName: boundedText(row["sort-name"] || "", 300),
        type: row.type || "",
        country: row.country || row["country-code"] || "",
        beginYear: row["life-span"]?.begin?.slice(0, 4) || row.date?.slice(0, 4) || "",
        disambiguation: boundedText(row.disambiguation || "", 200),
        url: `https://musicbrainz.org/${entity}/${row.id}`
      }))
    };
  }
};

const DATAMUSE_RELATIONS = {
  rhyme: "rel_rhy",
  similar: "ml",
  synonym: "rel_syn",
  triggers: "rel_trg",
  "sounds like": "rel_snd",
  "starts with": "s",
  "ends with": "e"
};

const datamuse = {
  id: "datamuse",
  tools: [
    {
      name: "solve_words",
      description: "Find words by meaning, rhyme, sound, or spelling using the Datamuse word-finding API.",
      inputSchema: object({
        query: text("The word or phrase to look up.", { minLength: 1, maxLength: 100 }),
        relation: text("Relation: rhyme, similar, synonym, triggers, sounds like, starts with, ends with.", { maxLength: 14 }),
        max: integer("Maximum words to return (1-25).", { minimum: 1, maximum: 25 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson(`https://api.datamuse.com/words?${queryString({ rel_rhy: "cat", max: 1 })}`, { signal });
    if (!Array.isArray(payload)) throw new Error("Datamuse did not return a word list.");
    return { message: "Datamuse is responding.", sample: payload[0]?.word || "" };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "solve_words") throw new Error("Unknown Datamuse tool.");
    const relationKey = String(args.relation || "similar").toLowerCase();
    const param = DATAMUSE_RELATIONS[relationKey] || DATAMUSE_RELATIONS.similar;
    const payload = await requestJson(
      `https://api.datamuse.com/words?${queryString({ [param]: args.query, max: args.max ?? 15 })}`,
      { signal }
    );
    const words = Array.isArray(payload) ? payload : [];
    return {
      query: args.query,
      relation: relationKey,
      count: words.length,
      words: words.map(word => ({
        word: boundedText(word?.word, 100),
        frequency: word?.frequency ?? null,
        rhymes: word?.rhymes ?? null,
        links: word?.n ?? null
      }))
    };
  }
};

const freeDictionary = {
  id: "free-dictionary",
  tools: [
    {
      name: "define_word",
      description: "Read dictionary definitions, pronunciations, and examples for an English word.",
      inputSchema: object({
        word: text("The word to define.", { minLength: 1, maxLength: 64 })
      }, ["word"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://api.dictionaryapi.dev/api/v2/entries/en/serendipity", { signal });
    if (!Array.isArray(payload) || payload.length === 0) throw new Error("The dictionary returned no entries.");
    return { message: "The free dictionary API is responding.", sample: payload[0]?.word || "" };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "define_word") throw new Error("Unknown dictionary tool.");
    const word = String(args.word || "").trim().toLowerCase().replace(/[^a-z-]/g, "");
    if (!word) throw new Error("Enter a word to define.");
    let payload;
    try {
      payload = await requestJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`, { signal });
    } catch (error) {
      if (error?.status === 404 || error?.code === "upstream_error") {
        throw new PluginError(`The dictionary has no entry for "${word}".`, 404, "not_found");
      }
      throw error;
    }
    const entries = Array.isArray(payload) ? payload : [];
    return {
      word,
      count: entries.length,
      entries: entries.map(entry => ({
        word: entry?.word || word,
        pronunciation: entry?.phonetic || (entry?.phonetics || []).find(item => item?.text)?.text || "",
        audioUrl: (entry?.phonetics || []).find(item => item?.audio)?.audio || "",
        meanings: (entry?.meanings || []).map(meaning => ({
          partOfSpeech: meaning?.partOfSpeech || "",
          definitions: (meaning?.definitions || []).slice(0, 5).map(definition => ({
            definition: boundedText(definition?.definition, 600),
            example: boundedText(definition?.example || "", 400),
            synonyms: Array.isArray(definition?.synonyms) ? definition.synonyms.slice(0, 10) : []
          })),
          synonyms: Array.isArray(meaning?.synonyms) ? meaning.synonyms.slice(0, 10) : []
        }))
      }))
    };
  }
};

const themealdb = {
  id: "themealdb",
  tools: [
    {
      name: "search_recipes",
      description: "Search TheMealDB's free recipe database by ingredient or dish name.",
      inputSchema: object({
        query: text("Search term, such as a main ingredient.", { minLength: 1, maxLength: 120 })
      }, ["query"])
    },
    {
      name: "list_categories",
      description: "List the meal categories available in TheMealDB.",
      inputSchema: object({})
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://www.themealdb.com/api/json/v1/1/list.php?c=list", { signal });
    if (!Array.isArray(payload?.meals)) throw new Error("TheMealDB returned no categories.");
    return { message: "TheMealDB is responding.", categories: payload.meals.length };
  },
  async execute(tool, args, { signal }) {
    if (tool === "list_categories") {
      const payload = await requestJson("https://www.themealdb.com/api/json/v1/1/list.php?c=list", { signal });
      return listResult((payload?.meals || []).map(meal => ({
        name: boundedText(meal?.strCategory, 120)
      })), "categories");
    }
    if (tool === "search_recipes") {
      const raw = await requestText(
        `https://www.themealdb.com/api/json/v1/1/search.php?${queryString({ s: args.query })}`,
        { signal }
      );
      const payload = raw ? JSON.parse(raw) : { meals: null };
      const meals = Array.isArray(payload?.meals) ? payload.meals : [];
      return listResult(meals.slice(0, 10).map(meal => ({
        id: meal?.idMeal || "",
        name: boundedText(meal?.strMeal, 200),
        category: meal?.strCategory || "",
        area: meal?.strArea || "",
        instructions: boundedText(meal?.strInstructions || "", 1200),
        image: meal?.strMealThumb || "",
        ingredients: Object.keys(meal || {})
          .filter(key => /^strIngredient\d+$/.test(key) && meal[key])
          .slice(0, 12)
          .map(key => boundedText(meal[key], 80)),
        source: meal?.strSource || ""
      })), "recipes");
    }
    throw new Error("Unknown TheMealDB tool.");
  }
};

const PAIR_PATTERN = /^[A-Z0-9]{3,6}-?[A-Z0-9]{3,6}$/;

const coinbaseSpot = {
  id: "coinbase-spot",
  tools: [
    {
      name: "spot_price",
      description: "Read the current Coinbase spot price for a currency pair such as BTC-USD.",
      inputSchema: object({
        pair: text("Currency pair, such as BTC-USD or ETH-EUR.", { minLength: 5, maxLength: 15 })
      }, ["pair"])
    }
  ],
  async testConnection({ signal }) {
    const payload = await requestJson("https://api.coinbase.com/v2/prices/BTC-USD/spot", { signal });
    if (!payload?.data?.amount) throw new Error("Coinbase returned no spot price.");
    return { message: "Coinbase spot prices are responding.", sample: `1 BTC = ${payload.data.amount} ${payload.data.currency}` };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "spot_price") throw new Error("Unknown Coinbase tool.");
    const pair = String(args.pair || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!PAIR_PATTERN.test(pair)) throw new Error("Enter a currency pair such as BTC-USD.");
    const normalized = pair.includes("-") ? pair : `${pair.slice(0, 3)}-${pair.slice(3)}`;
    const payload = await requestJson(
      `https://api.coinbase.com/v2/prices/${encodeURIComponent(normalized)}/spot`,
      { signal }
    );
    return {
      pair: normalized,
      baseCurrency: payload?.data?.base_currency || normalized.split("-")[0],
      currency: payload?.data?.currency || normalized.split("-")[1],
      amount: payload?.data?.amount ?? null,
      requestedAt: payload?.data?.requested_at || "",
      source: "Coinbase public spot price API"
    };
  }
};

export const referenceAdapters = {
  "usgs-earthquakes": usgsEarthquakes,
  tvmaze,
  pokeapi,
  zippopotam,
  musicbrainz,
  datamuse,
  "free-dictionary": freeDictionary,
  themealdb,
  "coinbase-spot": coinbaseSpot
};
