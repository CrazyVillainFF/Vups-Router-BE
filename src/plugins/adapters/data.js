import { boundedText, queryString, requestJson } from "../http.js";
import { integer, number, object, text } from "./schema.js";

const openmeteo = {
  id: "openmeteo",
  tools: [
    {
      name: "current",
      description: "Read current weather conditions for a latitude and longitude.",
      inputSchema: object({
        latitude: number("Latitude.", { minimum: -90, maximum: 90 }),
        longitude: number("Longitude.", { minimum: -180, maximum: 180 })
      }, ["latitude", "longitude"])
    },
    {
      name: "forecast",
      description: "Read a short daily weather forecast for a latitude and longitude.",
      inputSchema: object({
        latitude: number("Latitude.", { minimum: -90, maximum: 90 }),
        longitude: number("Longitude.", { minimum: -180, maximum: 180 }),
        days: integer("Forecast days (1-7).", { minimum: 1, maximum: 7 })
      }, ["latitude", "longitude"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("current", { latitude: 51.5072, longitude: -0.1276 }, { signal });
    return { message: "Open-Meteo is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "current") {
      const payload = await requestJson(
        `https://api.open-meteo.com/v1/forecast?${queryString({
          latitude: args.latitude,
          longitude: args.longitude,
          current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code",
          timezone: "auto"
        })}`,
        { signal }
      );
      return {
        latitude: payload?.latitude,
        longitude: payload?.longitude,
        timezone: payload?.timezone,
        current: payload?.current || {}
      };
    }
    if (tool === "forecast") {
      const payload = await requestJson(
        `https://api.open-meteo.com/v1/forecast?${queryString({
          latitude: args.latitude,
          longitude: args.longitude,
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
          forecast_days: args.days ?? 3,
          timezone: "auto"
        })}`,
        { signal }
      );
      return {
        latitude: payload?.latitude,
        longitude: payload?.longitude,
        timezone: payload?.timezone,
        daily: payload?.daily || {}
      };
    }
    throw new Error("Unknown Open-Meteo tool.");
  }
};

const frankfurter = {
  id: "frankfurter",
  tools: [
    {
      name: "latest",
      description: "Read the latest exchange rate from one currency to another.",
      inputSchema: object({
        from: text("Source currency code, such as USD.", { minLength: 3, maxLength: 3 }),
        to: text("Target currency code, such as EUR.", { minLength: 3, maxLength: 3 }),
        amount: number("Amount to convert.", { minimum: 0, maximum: 1000000000 })
      }, ["from", "to"])
    },
    {
      name: "currencies",
      description: "List currencies supported by Frankfurter.",
      inputSchema: object({})
    }
  ],
  async testConnection({ signal }) {
    await this.execute("latest", { from: "USD", to: "EUR", amount: 1 }, { signal });
    return { message: "Frankfurter exchange rates are responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "latest") {
      const payload = await requestJson(
        `https://api.frankfurter.app/latest?${queryString({ from: args.from, to: args.to })}`,
        { signal }
      );
      const rate = payload?.rates?.[String(args.to).toUpperCase()];
      const amount = args.amount ?? 1;
      return {
        from: payload?.base || args.from.toUpperCase(),
        to: String(args.to).toUpperCase(),
        rate: rate ?? null,
        amount,
        converted: typeof rate === "number" ? Number((rate * amount).toFixed(6)) : null,
        date: payload?.date || ""
      };
    }
    if (tool === "currencies") {
      const payload = await requestJson("https://api.frankfurter.app/currencies", { signal });
      return { currencies: payload || {} };
    }
    throw new Error("Unknown Frankfurter tool.");
  }
};

const coingecko = {
  id: "coingecko",
  tools: [
    {
      name: "price",
      description: "Read public cryptocurrency prices from CoinGecko.",
      inputSchema: object({
        ids: text("Comma-separated CoinGecko coin IDs, such as bitcoin,ethereum.", { minLength: 1, maxLength: 300 }),
        currencies: text("Comma-separated fiat or asset currencies, such as usd,eur.", { minLength: 1, maxLength: 100 })
      }, ["ids"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("price", { ids: "bitcoin", currencies: "usd" }, { signal });
    return { message: "CoinGecko public prices are responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "price") throw new Error("Unknown CoinGecko tool.");
    const payload = await requestJson(
      `https://api.coingecko.com/api/v3/simple/price?${queryString({
        ids: args.ids,
        vs_currencies: args.currencies || "usd",
        include_last_updated_at: true
      })}`,
      { signal }
    );
    return { prices: payload || {} };
  }
};

const hackernews = {
  id: "hackernews",
  tools: [
    {
      name: "top",
      description: "Read current top stories from Hacker News.",
      inputSchema: object({ limit: integer("Number of stories (1-10).", { minimum: 1, maximum: 10 }) })
    },
    {
      name: "item",
      description: "Read a Hacker News story or comment by item ID.",
      inputSchema: object({ id: integer("Hacker News item ID.", { minimum: 1 }) }, ["id"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("top", { limit: 1 }, { signal });
    return { message: "Hacker News is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "top") {
      const ids = await requestJson("https://hacker-news.firebaseio.com/v0/topstories.json", { signal });
      const selected = (Array.isArray(ids) ? ids : []).slice(0, args.limit ?? 5);
      const items = await Promise.all(selected.map(id => requestJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal })));
      return {
        stories: items.filter(Boolean).map(item => ({
          id: item.id,
          title: boundedText(item.title, 300),
          url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
          score: item.score ?? null,
          author: item.by || "",
          comments: item.descendants ?? null
        }))
      };
    }
    if (tool === "item") {
      const item = await requestJson(`https://hacker-news.firebaseio.com/v0/item/${args.id}.json`, { signal });
      if (!item) return { id: args.id, item: null };
      return {
        id: item.id,
        type: item.type || "",
        title: boundedText(item.title, 300),
        text: boundedText(String(item.text || "").replace(/<[^>]+>/g, " "), 3000),
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        score: item.score ?? null,
        author: item.by || "",
        comments: item.descendants ?? null
      };
    }
    throw new Error("Unknown Hacker News tool.");
  }
};

const worldbank = {
  id: "worldbank",
  tools: [
    {
      name: "indicator",
      description: "Read a World Bank development indicator for a country.",
      inputSchema: object({
        country: text("ISO country code, such as USA or IND.", { minLength: 2, maxLength: 3 }),
        indicator: text("World Bank indicator code, such as NY.GDP.MKTP.CD.", { minLength: 2, maxLength: 60 }),
        limit: integer("Number of recent observations (1-20).", { minimum: 1, maximum: 20 })
      }, ["country", "indicator"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("indicator", { country: "USA", indicator: "NY.GDP.MKTP.CD", limit: 1 }, { signal });
    return { message: "World Bank data is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "indicator") throw new Error("Unknown World Bank tool.");
    const payload = await requestJson(
      `https://api.worldbank.org/v2/country/${encodeURIComponent(args.country)}/indicator/${encodeURIComponent(args.indicator)}?${queryString({
        format: "json",
        per_page: args.limit ?? 5
      })}`,
      { signal }
    );
    const rows = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];
    return {
      country: args.country,
      indicator: args.indicator,
      observations: rows.map(row => ({
        date: row.date,
        value: row.value,
        unit: row.unit || "",
        country: row.country?.value || ""
      }))
    };
  }
};

export const dataAdapters = {
  openmeteo,
  frankfurter,
  coingecko,
  hackernews,
  worldbank
};
