import { boundedText, queryString, requestJson } from "../http.js";
import { githubAdapter } from "./github.js";
import { integer, object, text } from "./schema.js";

const dockerhub = {
  id: "dockerhub",
  tools: [
    {
      name: "search",
      description: "Search public Docker Hub container images.",
      inputSchema: object({
        query: text("Image search query.", { minLength: 1, maxLength: 200 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    },
    {
      name: "repository",
      description: "Read metadata for a Docker Hub repository.",
      inputSchema: object({
        namespace: text("Docker Hub namespace, such as library.", { minLength: 1, maxLength: 100 }),
        name: text("Repository name, such as nginx.", { minLength: 1, maxLength: 100 })
      }, ["namespace", "name"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "nginx", limit: 1 }, { signal });
    return { message: "Docker Hub is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "search") {
      const payload = await requestJson(
        `https://hub.docker.com/v2/search/repositories/?${queryString({ query: args.query, page_size: args.limit ?? 5 })}`,
        { signal }
      );
      return {
        query: args.query,
        results: (payload?.results || []).map(item => ({
          name: item.repo_name,
          description: boundedText(item.short_description, 500),
          stars: item.star_count ?? null,
          pulls: item.pull_count ?? null,
          official: Boolean(item.is_official),
          url: item.repo_name ? `https://hub.docker.com/r/${item.repo_name}` : ""
        }))
      };
    }
    if (tool === "repository") {
      const payload = await requestJson(
        `https://hub.docker.com/v2/repositories/${encodeURIComponent(args.namespace)}/${encodeURIComponent(args.name)}/`,
        { signal }
      );
      return {
        name: payload?.name || args.name,
        namespace: payload?.namespace || args.namespace,
        description: boundedText(payload?.description, 500),
        pulls: payload?.pull_count ?? null,
        stars: payload?.star_count ?? null,
        lastUpdated: payload?.last_updated || "",
        url: `https://hub.docker.com/r/${args.namespace}/${args.name}`
      };
    }
    throw new Error("Unknown Docker Hub tool.");
  }
};

const npm = {
  id: "npm",
  tools: [
    {
      name: "search",
      description: "Search the npm registry for packages.",
      inputSchema: object({
        query: text("Package search query.", { minLength: 1, maxLength: 200 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    },
    {
      name: "package",
      description: "Read metadata for an npm package.",
      inputSchema: object({ name: text("Package name.", { minLength: 1, maxLength: 214 }) }, ["name"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "express", limit: 1 }, { signal });
    return { message: "npm registry is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool === "search") {
      const payload = await requestJson(
        `https://registry.npmjs.org/-/v1/search?${queryString({ text: args.query, size: args.limit ?? 5 })}`,
        { signal }
      );
      return {
        query: args.query,
        results: (payload?.objects || []).map(item => ({
          name: item.package?.name,
          version: item.package?.version,
          description: boundedText(item.package?.description, 500),
          date: item.package?.date || "",
          links: item.package?.links || {}
        }))
      };
    }
    if (tool === "package") {
      const payload = await requestJson(`https://registry.npmjs.org/${encodeURIComponent(args.name)}`, { signal });
      const latest = payload?.["dist-tags"]?.latest;
      const info = latest ? payload?.versions?.[latest] : null;
      return {
        name: payload?.name || args.name,
        latest,
        description: boundedText(info?.description || payload?.description, 500),
        license: info?.license || "",
        repository: info?.repository?.url || "",
        homepage: info?.homepage || "",
        dependencies: info?.dependencies || {}
      };
    }
    throw new Error("Unknown npm tool.");
  }
};

const pypi = {
  id: "pypi",
  tools: [
    {
      name: "package",
      description: "Read metadata for a Python package on PyPI.",
      inputSchema: object({ name: text("Package name.", { minLength: 1, maxLength: 200 }) }, ["name"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("package", { name: "requests" }, { signal });
    return { message: "PyPI is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "package") throw new Error("Unknown PyPI tool.");
    const payload = await requestJson(`https://pypi.org/pypi/${encodeURIComponent(args.name)}/json`, { signal });
    const info = payload?.info || {};
    return {
      name: info.name || args.name,
      version: info.version || "",
      summary: boundedText(info.summary, 500),
      license: info.license || "",
      homepage: info.home_page || info.project_url || "",
      requiresPython: info.requires_python || "",
      classifiers: (info.classifiers || []).slice(0, 12)
    };
  }
};

const stackoverflow = {
  id: "stackoverflow",
  tools: [
    {
      name: "search",
      description: "Search Stack Overflow questions.",
      inputSchema: object({
        query: text("Question search query.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    }
  ],
  async testConnection({ signal }) {
    await this.execute("search", { query: "javascript fetch", limit: 1 }, { signal });
    return { message: "Stack Overflow is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "search") throw new Error("Unknown Stack Overflow tool.");
    const payload = await requestJson(
      `https://api.stackexchange.com/2.3/search/advanced?${queryString({
        order: "desc",
        sort: "relevance",
        q: args.query,
        site: "stackoverflow",
        pagesize: args.limit ?? 5,
        filter: "default"
      })}`,
      { signal }
    );
    return {
      query: args.query,
      results: (payload?.items || []).map(item => ({
        title: boundedText(item.title, 300),
        score: item.score ?? null,
        answers: item.answer_count ?? null,
        answered: Boolean(item.is_answered),
        url: item.link,
        tags: item.tags || []
      }))
    };
  }
};

const devto = {
  id: "devto",
  tools: [
    {
      name: "articles",
      description: "Read recent DEV Community articles, optionally filtered by tag.",
      inputSchema: object({
        tag: text("Optional tag, such as javascript.", { maxLength: 40 }),
        limit: integer("Number of articles (1-10).", { minimum: 1, maximum: 10 })
      })
    }
  ],
  async testConnection({ signal }) {
    await this.execute("articles", { limit: 1 }, { signal });
    return { message: "DEV Community is responding." };
  },
  async execute(tool, args, { signal }) {
    if (tool !== "articles") throw new Error("Unknown DEV Community tool.");
    const payload = await requestJson(
      `https://dev.to/api/articles?${queryString({ per_page: args.limit ?? 5, tag: args.tag })}`,
      { signal }
    );
    return {
      articles: (Array.isArray(payload) ? payload : []).map(item => ({
        title: item.title,
        url: item.url,
        description: boundedText(item.description, 500),
        author: item.user?.name || "",
        tags: item.tag_list || [],
        publishedAt: item.published_at || "",
        reactions: item.public_reactions_count ?? null
      }))
    };
  }
};

export const developerAdapters = {
  github: githubAdapter,
  dockerhub,
  npm,
  pypi,
  stackoverflow,
  devto
};
