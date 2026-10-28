import { boundedText, queryString, readPublicUrl, requestJson } from "../http.js";
import { integer, object, text } from "./schema.js";

const urlreader = {
  id: "urlreader",
  tools: [
    {
      name: "read",
      description: "Read a public web page as text. Private and local network addresses are blocked.",
      inputSchema: object({
        url: text("Public http or https URL.", { minLength: 8, maxLength: 2000, format: "uri" }),
        maxChars: integer("Maximum characters to return (500-20000).", { minimum: 500, maximum: 20000 })
      }, ["url"])
    }
  ],
  async testConnection({ signal }) {
    const result = await this.execute("read", { url: "https://example.com", maxChars: 500 }, { signal });
    if (!result.text) throw new Error("The URL reader returned no text.");
    return { message: "The URL reader is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "read") throw new Error("Unknown URL Reader tool.");
    return readPublicUrl(args.url, { maxChars: args.maxChars ?? 12000, signal });
  }
};

const timezone = {
  id: "timezone",
  tools: [
    {
      name: "current",
      description: "Read the current local time in an IANA time zone.",
      inputSchema: object({ zone: text("IANA time zone, such as Europe/London.", { minLength: 1, maxLength: 80 }) }, ["zone"])
    },
    {
      name: "list",
      description: "List IANA time zones, optionally filtered by a search term.",
      inputSchema: object({ query: text("Optional zone search term.", { maxLength: 80 }) })
    }
  ],
  async testConnection() {
    await this.execute("current", { zone: "UTC" }, {});
    return { message: "Time zone calculations are available." };
  },
  async execute(tool, args) {
    if (tool === "current") {
      const zone = String(args.zone || "").trim();
      let formatter;
      try {
        formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          dateStyle: "full",
          timeStyle: "long"
        });
      } catch {
        throw new Error("Enter a valid IANA time zone, such as Europe/London.");
      }
      const now = new Date();
      return {
        zone,
        localTime: formatter.format(now),
        utc: now.toISOString(),
        offset: new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
          .formatToParts(now)
          .find(part => part.type === "timeZoneName")?.value || ""
      };
    }
    if (tool === "list") {
      const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
      const query = String(args.query || "").toLowerCase();
      const matches = zones.filter(zone => !query || zone.toLowerCase().includes(query));
      return { query: args.query || "", count: matches.length, zones: matches.slice(0, 100) };
    }
    throw new Error("Unknown Time Zone tool.");
  }
};

const unsplash = {
  id: "unsplash",
  tools: [
    {
      name: "search_photos",
      description: "Search Unsplash photos and return image URLs and attribution.",
      inputSchema: object({
        query: text("Photo search query.", { minLength: 1, maxLength: 200 }),
        limit: integer("Number of photos (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ credentials, signal }) {
    await requestJson("https://api.unsplash.com/photos?per_page=1", {
      headers: { Authorization: `Client-ID ${credentials?.accessKey || ""}` },
      signal
    });
    return { message: "Unsplash access key accepted." };
  },
  async execute(tool, args, { credentials, signal }) {
    if (tool !== "search_photos") throw new Error("Unknown Unsplash tool.");
    if (!credentials?.accessKey) throw new Error("An Unsplash access key is required.");
    const payload = await requestJson(
      `https://api.unsplash.com/search/photos?${queryString({
        query: args.query,
        per_page: args.limit ?? 5,
        content_filter: "high"
      })}`,
      { headers: { Authorization: `Client-ID ${credentials.accessKey}` }, signal }
    );
    return {
      query: args.query,
      results: (payload?.results || []).map(photo => ({
        id: photo.id,
        description: boundedText(photo.description || photo.alt_description, 500),
        width: photo.width ?? null,
        height: photo.height ?? null,
        color: photo.color || "",
        image: photo.urls?.regular || photo.urls?.small || "",
        page: photo.links?.html || "",
        author: photo.user?.name || "",
        authorUrl: photo.user?.links?.html || ""
      }))
    };
  }
};

const deepl = {
  id: "deepl",
  tools: [
    {
      name: "translate",
      description: "Translate text with DeepL. The text is sent to the DeepL API.",
      inputSchema: object({
        text: text("Text to translate.", { minLength: 1, maxLength: 10000 }),
        targetLang: text("Target language code, such as DE or EN-US.", { minLength: 2, maxLength: 10 }),
        sourceLang: text("Optional source language code.", { maxLength: 10 })
      }, ["text", "targetLang"])
    }
  ],
  async testConnection({ config, credentials, signal }) {
    const base = config?.tier === "pro" ? "https://api.deepl.com" : "https://api-free.deepl.com";
    await requestJson(`${base}/v2/usage`, {
      headers: { Authorization: `DeepL-Auth-Key ${credentials?.apiKey || ""}` },
      signal
    });
    return { message: "DeepL API key accepted." };
  },
  async execute(tool, args, { config, credentials, signal }) {
    if (tool !== "translate") throw new Error("Unknown DeepL tool.");
    if (!credentials?.apiKey) throw new Error("A DeepL API key is required.");
    const base = config?.tier === "pro" ? "https://api.deepl.com" : "https://api-free.deepl.com";
    const payload = await requestJson(`${base}/v2/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${credentials.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: [args.text],
        target_lang: args.targetLang,
        ...(args.sourceLang ? { source_lang: args.sourceLang } : {})
      }),
      signal
    });
    return {
      translations: (payload?.translations || []).map(item => ({
        text: boundedText(item.text, 10000),
        detectedSourceLanguage: item.detected_source_language || ""
      }))
    };
  }
};

const wikimedia = {
  id: "wikimedia",
  tools: [
    {
      name: "search_images",
      description: "Search Wikimedia Commons for freely licensed images.",
      inputSchema: object({
        query: text("Image search query.", { minLength: 1, maxLength: 200 }),
        limit: integer("Number of images (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search_images", { query: "Eiffel Tower", limit: 1 }, { signal });
    return { message: "Wikimedia Commons is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search_images") throw new Error("Unknown Wikimedia Commons tool.");
    const payload = await requestJson(
      `https://commons.wikimedia.org/w/api.php?${queryString({
        action: "query",
        generator: "search",
        gsrsearch: args.query,
        gsrnamespace: 6,
        gsrlimit: args.limit ?? 5,
        prop: "imageinfo",
        iiprop: "url|extmetadata",
        iiurlwidth: 640,
        format: "json",
        origin: "*"
      })}`,
      { signal }
    );
    const pages = Object.values(payload?.query?.pages || {});
    return {
      query: args.query,
      results: pages.map(page => {
        const info = page.imageinfo?.[0] || {};
        const metadata = info.extmetadata || {};
        return {
          title: page.title,
          thumbnail: info.thumburl || info.url || "",
          url: info.descriptionurl || "",
          license: metadata.LicenseShortName?.value || "",
          artist: boundedText(String(metadata.Artist?.value || "").replace(/<[^>]+>/g, ""), 200)
        };
      })
    };
  }
};

export const utilityAdapters = {
  urlreader,
  timezone,
  unsplash,
  deepl,
  wikimedia
};
