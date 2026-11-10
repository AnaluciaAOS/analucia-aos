// The one list of secret patterns (SPEC-0006 §4), shared by the push guard (SPEC-0004 §5, aos check-push),
// the setup check secrets_tracked (SPEC-0005 §5) and the adoption audit (aos adopt), so they always agree.
// Findings name the kind, file, commit and line — never the value, not even a masked part.
//
// TOKEN_PATTERNS: token formats. Used by every caller; the push guard uses exactly these (its behavior is unchanged).
// CONTEXT_PATTERNS: shapes that are secrets only in context (an assignment in a .env-like file, a credential in a
// URL). Used by the audit, which reads whole projects; placeholders are excluded.
export const TOKEN_PATTERNS = {
  github_token: { description: 'GitHub token (personal, OAuth, user-to-server, server-to-server, refresh)', pattern: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\\b' },
  github_fine_grained_pat: { description: 'GitHub fine-grained personal access token', pattern: '\\bgithub_pat_[A-Za-z0-9_]{50,}\\b' },
  anthropic_api_key: { description: 'Anthropic API key', pattern: '\\bsk-ant-[A-Za-z0-9_-]{20,}' },
  aws_access_key_id: { description: 'AWS access key ID', pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b' },
  private_key_block: { description: 'PEM private key block', pattern: '-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----' },
  resend_api_key: { description: 'Resend API key', pattern: '\\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{24,}\\b' },
};

// A value that is obviously a placeholder, not a secret.
const PLACEHOLDER = /^(?:["']?)(?:\$\{?[A-Za-z_][\w]*\}?|<[^>]*>|\*+|x+|changeme|change_me|example|placeholder|secret|password|passwd|pass|token|your[_-]?\w*|\.\.\.|…|null|none|todo|tbd)?(?:["']?)$/i;

export const CONTEXT_PATTERNS = {
  env_secret_assignment: {
    description: 'Secret-like assignment in a .env-like file (PASSWORD, SECRET, TOKEN, API_KEY, PRIVATE_KEY)',
    appliesTo: (file) => isEnvLike(file),
    test: (line) => {
      const m = /^\s*(?:export\s+)?[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*[=:]\s*(.*?)\s*$/i.exec(line);
      return Boolean(m && m[1] && !m[1].startsWith('#') && !PLACEHOLDER.test(m[1]));
    },
  },
  url_credential: {
    description: 'Credential in a URL (scheme://user:secret@host)',
    appliesTo: () => true,
    test: (line) => {
      for (const m of line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:([^\s/@'"`]+)@[^\s/'"`]+/gi)) {
        if (!PLACEHOLDER.test(m[1]) && !m[1].includes('${')) return true;
      }
      return false;
    },
  },
};

// .env, .env.local, .env.production, prod.env … but not the committed templates.
export const isEnvLike = (file) => {
  const base = String(file).split('/').pop();
  if (/\.(example|sample|template|dist)$/i.test(base)) return false;
  return /^\.env(\..+)?$/i.test(base) || /\.env$/i.test(base);
};

// [{ name, re }] for the token patterns (push guard, setup check).
export function tokenPatterns() {
  return Object.entries(TOKEN_PATTERNS).map(([name, p]) => ({ name, re: new RegExp(p.pattern) }));
}

// The kinds of secret in one line of one file: token patterns everywhere, context patterns where they apply.
export function secretKindsIn(file, line, tokens = tokenPatterns()) {
  const kinds = [];
  for (const t of tokens) if (t.re.test(line)) kinds.push(t.name);
  for (const [name, c] of Object.entries(CONTEXT_PATTERNS)) if (c.appliesTo(file) && c.test(line)) kinds.push(name);
  return kinds;
}
