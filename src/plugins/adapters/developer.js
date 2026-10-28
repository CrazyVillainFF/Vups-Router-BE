import { boundedText, queryString, requestJson } from "../http.js";
import { integer, object, text } from "./schema.js";

function githubHeaders(credentials = {}) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {})
  };
}

function githubRepository(item) {
  return {
    fullName: item.full_name,
    description: boundedText(item.description, 500),
    url: item.html_url,
    stars: item.stargazers_count ?? null,
    forks: item.forks_count ?? null,
    language: item.language || "",
    updatedAt: item.updated_at || "",
    archived: Boolean(item.archived)
  };
}

const github = {
  id: "github",
  tools: [
    {
      name: "search_repositories",
      description: "Search GitHub repositories.",
      inputSchema: object({
        query: text("Repository search query.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
    },
    {
      name: "repository",
      description: "Read metadata for one GitHub repository.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 })
      }, ["owner", "repo"])
    },
    {
      name: "list_issues",
      description: "List issues in a GitHub repository. Pull requests are excluded.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        state: text("Issue state: open, closed, or all.", { enum: ["open", "closed", "all"] }),
        limit: integer("Number of issues (1-20).", { minimum: 1, maximum: 20 })
      }, ["owner", "repo"])
    },
    {
      name: "create_issue",
      description: "Create an issue in a GitHub repository. Requires an access token and explicit confirmation.",
      sensitive: true,
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        title: text("Issue title.", { minLength: 1, maxLength: 256 }),
        body: text("Issue body.", { maxLength: 10000 })
      }, ["owner", "repo", "title"])
    }
  ],
  async testConnection({ credentials, signal }) {
    await requestJson("https://api.github.com/rate_limit", { headers: githubHeaders(credentials), signal });
    return { message: credentials?.token ? "GitHub token accepted." : "GitHub public API is responding." };
  },
  async execute(tool, args, { credentials, signal }) {
    const headers = githubHeaders(credentials);
    if (tool === "search_repositories") {
      const payload = await requestJson(
        `https://api.github.com/search/repositories?${queryString({ q: args.query, per_page: args.limit ?? 5 })}`,
        { headers, signal }
      );
      return { query: args.query, results: (payload?.items || []).map(githubRepository) };
    }
    if (tool === "repository") {
      const payload = await requestJson(
        `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`,
        { headers, signal }
      );
      return githubRepository(payload);
    }
    if (tool === "list_issues") {
      const payload = await requestJson(
        `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues?${queryString({
          state: args.state || "open",
          per_page: args.limit ?? 10
        })}`,
        { headers, signal }
      );
      return {
        issues: (Array.isArray(payload) ? payload : [])
          .filter(item => !item.pull_request)
          .map(item => ({
            number: item.number,
            title: boundedText(item.title, 300),
            state: item.state,
            author: item.user?.login || "",
            labels: (item.labels || []).map(label => label.name),
            url: item.html_url,
            updatedAt: item.updated_at || ""
          }))
      };
    }
    if (tool === "create_issue") {
      if (!credentials?.token) {
        throw new Error("A GitHub access token is required to create an issue.");
      }
      const payload = await requestJson(
        `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ title: args.title, body: args.body || "" }),
          signal
        }
      );
      return { number: payload.number, title: payload.title, url: payload.html_url, state: payload.state };
    }
    throw new Error("Unknown GitHub tool.");
  }
};

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
  github,
  dockerhub,
  npm,
  pypi,
  stackoverflow,
  devto
};
