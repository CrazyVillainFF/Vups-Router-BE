import { PluginError } from "../errors.js";
import { queryString, boundedText, requestJson, requestJsonPage } from "../http.js";
import { boolean, integer, object, text } from "./schema.js";

const API = "https://api.github.com";
const MAX_FILE_CHARS = 40000;
const MAX_CONTENT_BYTES = 3 * 1024 * 1024;
const MAX_PATCH_CHARS = 6000;
const MAX_ENTRIES = 300;

// Both connection methods land in the same credential shape: an access token from
// the personal-token form (`token`) or the OAuth token from the sign-in (`accessToken`).
function tokenOf(credentials) {
  return String(credentials?.token || credentials?.accessToken || "").trim();
}

function githubHeaders(credentials = {}) {
  const token = tokenOf(credentials);
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function requireToken(credentials, what) {
  if (!tokenOf(credentials)) {
    throw new PluginError(
      `Reading ${what} needs a GitHub token. Save an access token or sign in with GitHub, then try again.`,
      400,
      "token_required"
    );
  }
}

function encodePath(value) {
  return String(value || "")
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

// File bodies and diffs are clipped, never trimmed: a unified-diff line's leading
// space and a file's trailing newline are part of the content the user asked for.
function clamp(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

function repoBase(owner, repo) {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function repositorySummary(item) {
  if (!item) return null;
  return {
    fullName: item.full_name,
    owner: item.owner?.login || String(item.full_name || "").split("/")[0] || "",
    name: item.name,
    description: boundedText(item.description, 500),
    url: item.html_url,
    defaultBranch: item.default_branch || "",
    private: Boolean(item.private),
    visibility: item.visibility || (item.private ? "private" : "public"),
    fork: Boolean(item.fork),
    archived: Boolean(item.archived),
    stars: item.stargazers_count ?? null,
    forks: item.forks_count ?? null,
    openIssues: item.open_issues_count ?? null,
    language: item.language || "",
    updatedAt: item.updated_at || "",
    permissions: item.permissions
      ? { pull: Boolean(item.permissions.pull), push: Boolean(item.permissions.push), admin: Boolean(item.permissions.admin) }
      : null
  };
}

function commitSummary(item) {
  return {
    sha: item.sha,
    message: boundedText(item.commit?.message, 300),
    author: item.commit?.author?.name || item.author?.login || "",
    login: item.author?.login || "",
    date: item.commit?.author?.date || "",
    url: item.html_url || ""
  };
}

function entrySummary(item) {
  return {
    name: item.name,
    path: item.path,
    type: item.type,
    size: item.size ?? null,
    sha: item.sha || "",
    url: item.html_url || "",
    downloadUrl: item.download_url || ""
  };
}

function issueSummary(item) {
  return {
    number: item.number,
    title: boundedText(item.title, 300),
    state: item.state,
    author: item.user?.login || "",
    labels: (item.labels || []).map(label => label.name),
    comments: item.comments ?? null,
    url: item.html_url,
    updatedAt: item.updated_at || ""
  };
}

function pullSummary(item) {
  return {
    number: item.number,
    title: boundedText(item.title, 300),
    state: item.state,
    draft: Boolean(item.draft),
    author: item.user?.login || "",
    head: item.head?.label || "",
    headSha: item.head?.sha || "",
    base: item.base?.label || "",
    url: item.html_url,
    mergedAt: item.merged_at || "",
    createdAt: item.created_at || "",
    additions: item.additions ?? null,
    deletions: item.deletions ?? null,
    changedFiles: item.changed_files ?? null
  };
}

function fileChangeSummary(item) {
  return {
    filename: item.filename,
    status: item.status,
    additions: item.additions ?? null,
    deletions: item.deletions ?? null,
    changes: item.changes ?? null,
    patch: item.patch ? clamp(item.patch, MAX_PATCH_CHARS) : ""
  };
}

function decodeContent(payload) {
  const raw = String(payload.content || "").replace(/\s+/g, "");
  const buffer = Buffer.from(raw, "base64");
  const text = buffer.toString("utf8");
  return { text, binary: buffer.includes(0), bytes: buffer.length };
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
      name: "list_repositories",
      description: "List repositories the connected GitHub account owns or contributes to. Needs a token.",
      inputSchema: object({
        affiliation: text("Whose repositories: owner, collaborator, organization_member, or none.", {
          enum: ["owner", "collaborator", "organization_member", "none"]
        }),
        visibility: text("Only public or only private repositories.", { enum: ["public", "private", "all"] }),
        sort: text("Sort order.", { enum: ["created", "updated", "pushed", "full_name"] }),
        direction: text("Sort direction.", { enum: ["asc", "desc"] }),
        page: integer("Page number, starting at 1.", { minimum: 1, maximum: 100 }),
        perPage: integer("Repositories per page (1-100).", { minimum: 1, maximum: 100 })
      })
    },
    {
      name: "repository",
      description: "Read metadata for one GitHub repository, including its default branch and your permissions.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 })
      }, ["owner", "repo"])
    },
    {
      name: "list_files",
      description: "List the files and folders in a repository path on a branch, tag, or commit.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        path: text("Folder path inside the repository. Empty for the root.", { maxLength: 400 }),
        branch: text("Branch, tag, or commit. Defaults to the repository default branch.", { maxLength: 200 }),
        perPage: integer("Entries to return (1-300).", { minimum: 1, maximum: 300 })
      }, ["owner", "repo"])
    },
    {
      name: "read_file",
      description: "Read the text contents of one file in a repository.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        path: text("File path inside the repository.", { minLength: 1, maxLength: 400 }),
        branch: text("Branch, tag, or commit. Defaults to the repository default branch.", { maxLength: 200 })
      }, ["owner", "repo", "path"])
    },
    {
      name: "list_branches",
      description: "List the branches of a repository.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        page: integer("Page number, starting at 1.", { minimum: 1, maximum: 100 }),
        perPage: integer("Branches per page (1-100).", { minimum: 1, maximum: 100 })
      }, ["owner", "repo"])
    },
    {
      name: "list_commits",
      description: "List recent commits on a branch, optionally limited to one file.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        branch: text("Branch, tag, or commit. Defaults to the repository default branch.", { maxLength: 200 }),
        path: text("Only commits that changed this file.", { maxLength: 400 }),
        page: integer("Page number, starting at 1.", { minimum: 1, maximum: 100 }),
        perPage: integer("Commits per page (1-100).", { minimum: 1, maximum: 100 })
      }, ["owner", "repo"])
    },
    {
      name: "compare_refs",
      description: "Compare two branches, tags, or commits and read the file changes between them.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        base: text("The older side of the comparison.", { minLength: 1, maxLength: 200 }),
        head: text("The newer side of the comparison.", { minLength: 1, maxLength: 200 })
      }, ["owner", "repo", "base", "head"])
    },
    {
      name: "search_code",
      description: "Search code inside repositories the connected account can read. Needs a token.",
      inputSchema: object({
        query: text("Code search query, using GitHub qualifiers such as repo:owner/name.", { minLength: 1, maxLength: 300 }),
        limit: integer("Number of results (1-10).", { minimum: 1, maximum: 10 })
      }, ["query"])
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
    },
    {
      name: "list_pull_requests",
      description: "List pull requests in a GitHub repository.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        state: text("Pull request state.", { enum: ["open", "closed", "merged", "all"] }),
        page: integer("Page number, starting at 1.", { minimum: 1, maximum: 100 }),
        perPage: integer("Pull requests per page (1-100).", { minimum: 1, maximum: 100 })
      }, ["owner", "repo"])
    },
    {
      name: "read_pull_request",
      description: "Read one pull request with its changed files and diffs.",
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        number: integer("Pull request number.", { minimum: 1, maximum: 1000000 })
      }, ["owner", "repo", "number"])
    },
    {
      name: "create_branch",
      description: "Create a branch in a GitHub repository. Requires a token and explicit confirmation.",
      sensitive: true,
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        branch: text("New branch name.", { minLength: 1, maxLength: 200 }),
        from: text("Existing branch, tag, or commit to start from.", { minLength: 1, maxLength: 200 })
      }, ["owner", "repo", "branch", "from"])
    },
    {
      name: "write_file",
      description:
        "Create or replace one file on a branch you name, as a commit. Refuses the default branch unless you allow it. Requires a token and explicit confirmation.",
      sensitive: true,
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        path: text("File path inside the repository.", { minLength: 1, maxLength: 400 }),
        content: text("The complete new contents of the file.", { minLength: 1, maxLength: 120000 }),
        branch: text("Branch to commit on. This is never the default branch unless allowed.", { minLength: 1, maxLength: 200 }),
        message: text("Commit message.", { minLength: 1, maxLength: 200 }),
        allowDefaultBranch: boolean("Set true only if you intend to commit to the repository default branch.")
      }, ["owner", "repo", "path", "content", "branch", "message"])
    },
    {
      name: "delete_file",
      description:
        "Delete one file on a branch you name, as a commit. Refuses the default branch unless you allow it. Requires a token and explicit confirmation.",
      sensitive: true,
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        path: text("File path inside the repository.", { minLength: 1, maxLength: 400 }),
        branch: text("Branch to commit on.", { minLength: 1, maxLength: 200 }),
        message: text("Commit message.", { minLength: 1, maxLength: 200 }),
        allowDefaultBranch: boolean("Set true only if you intend to commit to the repository default branch.")
      }, ["owner", "repo", "path", "branch", "message"])
    },
    {
      name: "create_pull_request",
      description: "Open a pull request from one branch to another. Requires a token and explicit confirmation.",
      sensitive: true,
      inputSchema: object({
        owner: text("Repository owner.", { minLength: 1, maxLength: 100 }),
        repo: text("Repository name.", { minLength: 1, maxLength: 100 }),
        title: text("Pull request title.", { minLength: 1, maxLength: 256 }),
        head: text("Branch containing the changes.", { minLength: 1, maxLength: 200 }),
        base: text("Branch the changes should merge into.", { minLength: 1, maxLength: 200 }),
        body: text("Pull request description.", { maxLength: 20000 }),
        draft: boolean("Open as a draft.")
      }, ["owner", "repo", "title", "head", "base"])
    }
  ],

  async testConnection({ credentials, signal }) {
    await requestJson(`${API}/rate_limit`, { headers: githubHeaders(credentials), signal });
    return { message: tokenOf(credentials) ? "GitHub token accepted." : "GitHub public API is responding." };
  },

  // The sign-in is only finished once GitHub says which account the token belongs
  // to, so the app can name the connected account instead of guessing.
  async authenticate(credentials, { signal }) {
    const me = await requestJson(`${API}/user`, { headers: githubHeaders(credentials), signal, timeoutMs: 12000 });
    return {
      login: boundedText(me?.login, 60),
      name: boundedText(me?.name, 120),
      type: boundedText(me?.type, 30),
      url: String(me?.html_url || ""),
      avatarUrl: String(me?.avatar_url || "")
    };
  },

  // Asks GitHub to drop the token itself, so disconnecting revokes access at the
  // provider instead of only deleting the local copy.
  async revoke(credentials, { config, signal }) {
    const token = tokenOf(credentials);
    if (!token || !config?.clientId || !config?.clientSecret) return;
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");
    await requestJson(`${API}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`
      },
      body: JSON.stringify({ access_token: token }),
      timeoutMs: 12000,
      signal
    });
  },

  async execute(tool, args, { credentials, signal }) {
    const headers = githubHeaders(credentials);
    const base = repoBase(args.owner, args.repo);

    if (tool === "search_repositories") {
      const payload = await requestJson(
        `${API}/search/repositories?${queryString({ q: args.query, per_page: args.limit ?? 5 })}`,
        { headers, signal }
      );
      return { query: args.query, results: (payload?.items || []).map(repositorySummary) };
    }

    if (tool === "list_repositories") {
      requireToken(credentials, "your repository list");
      const page = args.page ?? 1;
      const perPage = args.perPage ?? 30;
      const result = await requestJsonPage(
        `${API}/user/repos?${queryString({
          affiliation: args.affiliation || "owner,collaborator,organization_member",
          visibility: args.visibility && args.visibility !== "all" ? args.visibility : "",
          sort: args.sort || "updated",
          direction: args.direction || "desc",
          per_page: perPage,
          page
        })}`,
        { headers, signal }
      );
      const data = Array.isArray(result.data) ? result.data : [];
      return {
        repositories: data.map(repositorySummary),
        page,
        perPage,
        nextPage: result.nextPage ?? null,
        lastPage: result.lastPage ?? null,
        rateLimit: result.rateLimit
      };
    }

    if (tool === "repository") {
      const payload = await requestJson(base, { headers, signal });
      return repositorySummary(payload);
    }

    if (tool === "list_files") {
      const perPage = Math.min(args.perPage ?? 200, MAX_ENTRIES);
      const url = `${base}/contents/${encodePath(args.path || "")}?${queryString({ per_page: perPage, ref: args.branch })}`;
      const payload = await requestJson(url, { headers, signal, maxBytes: MAX_CONTENT_BYTES });
      if (Array.isArray(payload)) {
        const folders = payload.filter(item => item.type === "dir").map(entrySummary);
        const files = payload.filter(item => item.type !== "dir").map(entrySummary);
        return {
          path: args.path || "",
          branch: args.branch || "",
          folders: folders.slice(0, MAX_ENTRIES),
          files: files.slice(0, MAX_ENTRIES),
          truncated: payload.length >= perPage
        };
      }
      return { path: args.path || "", branch: args.branch || "", folders: [], files: [entrySummary(payload)] };
    }

    if (tool === "read_file") {
      const url = `${base}/contents/${encodePath(args.path)}?${queryString({ ref: args.branch })}`;
      const payload = await requestJson(url, { headers, signal, maxBytes: MAX_CONTENT_BYTES });
      const decoded = decodeContent(payload);
      return {
        path: payload.path || args.path,
        branch: args.branch || "",
        sha: payload.sha || "",
        size: payload.size ?? decoded.bytes,
        binary: decoded.binary,
        truncated: decoded.text.length > MAX_FILE_CHARS,
        content: decoded.binary ? "" : clamp(decoded.text, MAX_FILE_CHARS)
      };
    }

    if (tool === "list_branches") {
      const page = args.page ?? 1;
      const perPage = args.perPage ?? 50;
      const result = await requestJsonPage(
        `${base}/branches?${queryString({ per_page: perPage, page })}`,
        { headers, signal }
      );
      const data = Array.isArray(result.data) ? result.data : [];
      return {
        branches: data.map(item => ({
          name: item.name,
          sha: item.commit?.sha || "",
          protected: Boolean(item.protected)
        })),
        page,
        perPage,
        nextPage: result.nextPage ?? null,
        rateLimit: result.rateLimit
      };
    }

    if (tool === "list_commits") {
      const page = args.page ?? 1;
      const perPage = args.perPage ?? 20;
      const result = await requestJsonPage(
        `${base}/commits?${queryString({ sha: args.branch, path: args.path, per_page: perPage, page })}`,
        { headers, signal }
      );
      const data = Array.isArray(result.data) ? result.data : [];
      return {
        commits: data.map(commitSummary),
        page,
        perPage,
        nextPage: result.nextPage ?? null,
        rateLimit: result.rateLimit
      };
    }

    if (tool === "compare_refs") {
      const payload = await requestJson(
        `${base}/compare/${encodePath(args.base)}...${encodePath(args.head)}`,
        { headers, signal, maxBytes: MAX_CONTENT_BYTES }
      );
      return {
        base: payload?.base_commit?.sha || args.base,
        head: payload?.merge_base_commit?.sha || args.head,
        aheadBy: payload?.ahead_by ?? null,
        behindBy: payload?.behind_by ?? null,
        totalCommitCount: payload?.total_commits ?? null,
        commits: (payload?.commits || []).slice(0, 50).map(commitSummary),
        files: (payload?.files || []).slice(0, MAX_ENTRIES).map(fileChangeSummary),
        truncated: Boolean(payload?.files && payload.files.length >= MAX_ENTRIES)
      };
    }

    if (tool === "search_code") {
      requireToken(credentials, "code search");
      const payload = await requestJson(`${API}/search/code?${queryString({ q: args.query, per_page: args.limit ?? 5 })}`, {
        headers,
        signal
      });
      return {
        query: args.query,
        results: (payload?.items || []).map(item => ({
          repository: item.repository?.full_name || "",
          path: item.path,
          url: item.html_url,
          matches: (item.text_matches || []).map(match => boundedText(match.fragment, 600)).slice(0, 3)
        }))
      };
    }

    if (tool === "list_issues") {
      const payload = await requestJson(
        `${base}/issues?${queryString({ state: args.state || "open", per_page: args.limit ?? 10 })}`,
        { headers, signal }
      );
      return {
        issues: (Array.isArray(payload) ? payload : []).filter(item => !item.pull_request).map(issueSummary)
      };
    }

    if (tool === "create_issue") {
      requireToken(credentials, "issue creation");
      const payload = await requestJson(`${base}/issues`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title: args.title, body: args.body || "" }),
        signal
      });
      return { number: payload.number, title: payload.title, url: payload.html_url, state: payload.state };
    }

    if (tool === "list_pull_requests") {
      const page = args.page ?? 1;
      const perPage = args.perPage ?? 20;
      const result = await requestJsonPage(
        `${base}/pulls?${queryString({ state: args.state || "open", sort: "updated", direction: "desc", per_page: perPage, page })}`,
        { headers, signal }
      );
      const data = Array.isArray(result.data) ? result.data : [];
      return {
        pullRequests: data.map(pullSummary),
        page,
        perPage,
        nextPage: result.nextPage ?? null,
        rateLimit: result.rateLimit
      };
    }

    if (tool === "read_pull_request") {
      const detail = await requestJson(`${base}/pulls/${encodeURIComponent(args.number)}`, { headers, signal });
      const files = await requestJson(
        `${base}/pulls/${encodeURIComponent(args.number)}/files?${queryString({ per_page: 100 })}`,
        { headers, signal, maxBytes: MAX_CONTENT_BYTES }
      );
      return {
        ...pullSummary(detail),
        body: boundedText(detail?.body, 8000),
        files: (Array.isArray(files) ? files : []).map(fileChangeSummary)
      };
    }

    if (tool === "create_branch") {
      requireToken(credentials, "branch creation");
      const source = await requestJson(`${base}/commits/${encodePath(args.from)}`, { headers, signal });
      const sha = source?.sha;
      if (!sha) throw new PluginError(`GitHub did not recognize the starting point "${args.from}".`, 404, "unknown_ref");
      const created = await requestJson(`${base}/git/refs`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha }),
        signal
      });
      return { branch: args.branch, ref: created?.ref || `refs/heads/${args.branch}`, sha };
    }

    if (tool === "write_file" || tool === "delete_file") {
      requireToken(credentials, tool === "write_file" ? "writing a file" : "deleting a file");
      const repository = repositorySummary(await requestJson(base, { headers, signal }));
      if (repository?.defaultBranch && args.branch === repository.defaultBranch && args.allowDefaultBranch !== true) {
        throw new PluginError(
          `"${args.branch}" is the default branch of ${repository.fullName}. Name a branch you created for this change, or allow the default branch explicitly.`,
          400,
          "default_branch_guard"
        );
      }
      const url = `${base}/contents/${encodePath(args.path)}?${queryString({ ref: args.branch })}`;
      if (tool === "delete_file") {
        const current = await requestJson(url, { headers, signal, maxBytes: MAX_CONTENT_BYTES });
        if (!current?.sha) throw new PluginError(`GitHub did not find ${args.path} on ${args.branch}.`, 404, "file_not_found");
        const payload = await requestJson(url, {
          method: "DELETE",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ message: args.message, sha: current.sha, branch: args.branch }),
          signal
        });
        return { deleted: args.path, branch: args.branch, commit: payload?.commit?.sha || "" };
      }
      let sha = null;
      try {
        sha = (await requestJson(url, { headers, signal, maxBytes: MAX_CONTENT_BYTES }))?.sha || null;
      } catch {
        sha = null;
      }
      const payload = await requestJson(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: args.message,
          content: Buffer.from(String(args.content), "utf8").toString("base64"),
          branch: args.branch,
          ...(sha ? { sha } : {})
        }),
        signal
      });
      return {
        written: payload?.content?.path || args.path,
        branch: args.branch,
        commit: payload?.commit?.sha || "",
        created: !sha
      };
    }

    if (tool === "create_pull_request") {
      requireToken(credentials, "pull request creation");
      const payload = await requestJson(`${base}/pulls`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body || "",
          draft: args.draft === true
        }),
        signal
      });
      return pullSummary(payload);
    }

    throw new PluginError("Unknown GitHub tool.", 400, "unknown_tool");
  }
};

export const githubAdapter = github;
