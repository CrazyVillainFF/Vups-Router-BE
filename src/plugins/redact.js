// Upstream services sometimes echo request details back in an error body. Every
// message that reaches the app, the database, or the audit trail passes through
// here so a credential can never be read back out of a plugin error.

export const REDACTED = "[redacted]";

const PATTERNS = [
  // Provider token formats.
  { regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: () => REDACTED },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, replace: () => REDACTED },
  { regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
  { regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replace: () => REDACTED },
  // Authorization headers keep their scheme so the sentence still reads.
  {
    regex: /\b(Bearer|Token|Basic|DeepL-Auth-Key)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_match, scheme) => `${scheme} ${REDACTED}`
  },
  // Credential-shaped query parameters.
  {
    regex: /([?&](?:access_key|api_key|apikey|client_id|client_secret|key|token|auth)=)[^&\s"']+/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`
  },
  // key=value / key: value pairs in JSON or form bodies. `authorization` is left
  // to the header rule above, which has to keep the scheme word visible.
  {
    regex:
      /((?:"|')?(?:api_?key|access_?token|refresh_?token|token|secret|password)(?:"|')?\s*[:=]\s*(?:"|')?)[^"',\s}]{6,}/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`
  }
];

export function redactSecrets(text, secrets = []) {
  let output = String(text ?? "");
  if (!output) return output;
  for (const secret of secrets) {
    const value = typeof secret === "string" ? secret.trim() : "";
    // Anything shorter than six characters cannot be a usable credential and
    // would match ordinary words.
    if (value.length >= 6) output = output.split(value).join(REDACTED);
  }
  for (const { regex, replace } of PATTERNS) output = output.replace(regex, replace);
  return output;
}

// Credentials objects and form configs both end up here; duplicates collapse so
// the same secret is not scanned twice.
export function secretValues(...sources) {
  const values = new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const value of Object.values(source)) {
      if (typeof value === "string" && value.trim().length >= 6) values.add(value.trim());
    }
  }
  return [...values];
}
