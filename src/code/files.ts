/**
 * Which workspace files the assistant reads, the limits it reads them under, and what it hides from the model.
 *
 * Inspection is text-based: files are recognized by name/extension and searched as lines of text. There is no parser
 * for any language, so the app never claims to "understand" a syntax tree; the model reads excerpts.
 *
 * Secret redaction is a best-effort pattern match (key=value pairs with secret-sounding names, well-known token
 * formats, private-key blocks) and files that usually hold secrets are not read at all. It can miss secrets in other
 * shapes and can redact harmless values: it reduces exposure to the on-device model, it is not a guarantee.
 */
import { baseName } from './paths';

/** Limits for one workspace; deliberately small for a 2048-token on-device model and a mid-range phone. */
export const LIMITS = {
  maxEntries: 3000, // files and folders listed by one scan
  maxScanDepth: 12,
  maxFileBytes: 200_000, // a larger file is listed but not read
  maxSearchFiles: 250, // files a content search reads
  maxSearchBytes: 3_000_000, // total bytes a content search reads
  maxHits: 60,
  contextTokens: 1000, // source text given to the model for one question
  proposalContextTokens: 800, // less for a change proposal: the answer (edits) needs room
  maxExcerptLines: 60,
};

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript',
  cjs: 'JavaScript', py: 'Python', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', cs: 'C#', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  md: 'Markdown', xml: 'XML', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS', gradle: 'Gradle', properties: 'Properties',
  toml: 'TOML', ini: 'INI', cfg: 'INI', txt: 'Text', sh: 'Shell', bat: 'Batch', ps1: 'PowerShell', go: 'Go', rs: 'Rust',
  swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cc: 'C++', m: 'Objective-C', rb: 'Ruby', php: 'PHP', sql: 'SQL',
  csproj: 'XML', sln: 'Text', pro: 'Text', cmake: 'CMake', dart: 'Dart', vue: 'Vue', svelte: 'Svelte', graphql: 'GraphQL',
};
const LANG_BY_NAME: Record<string, string> = {
  dockerfile: 'Dockerfile', makefile: 'Makefile', gemfile: 'Ruby', podfile: 'Ruby', '.gitignore': 'Text', '.editorconfig': 'INI',
  '.eslintrc': 'JSON', '.prettierrc': 'JSON', '.babelrc': 'JSON', 'cmakelists.txt': 'CMake', license: 'Text', readme: 'Text',
};
/** Folders that hold generated output or downloaded dependencies: never scanned. */
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out', 'target', '.gradle', '.idea',
  '.vscode', 'pods', '__pycache__', '.venv', 'venv', 'env', '.next', '.nuxt', 'coverage', '.cache', 'bin', 'obj', '.dart_tool',
  '.expo', 'vendor', 'deriveddata', '.pytest_cache', '.mypy_cache', '.tox']);
/** Files the app never reads or edits because they usually hold secrets or signing keys. */
const SECRET_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|der|crt|cer|gpg|asc|ovpn)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|local\.properties|keystore\.properties|service-account.*\.json)$/i;
/** Files that describe a project (shown first and preferred for "summarize the architecture"). */
export const PROJECT_FILES = /^(package\.json|tsconfig(\..+)?\.json|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|pom\.xml|requirements\.txt|pyproject\.toml|setup\.py|setup\.cfg|.*\.csproj|.*\.sln|cargo\.toml|go\.mod|readme(\.md|\.txt)?|app\.json|babel\.config\.js|metro\.config\.js|androidmanifest\.xml|dockerfile|makefile|cmakelists\.txt)$/i;

/** The language label of a supported text file, or null (binary, unknown, or a minified/lock file). */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (/\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|gradlew(\.bat)?)$/.test(lower)) return null;
  if (LANG_BY_NAME[lower]) return LANG_BY_NAME[lower];
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return LANG_BY_EXT[ext] ?? null;
}

export const isSecretFile = (path: string) => SECRET_FILE.test(baseName(path));
export const isIgnoredDir = (name: string) => IGNORED_DIRS.has(name.toLowerCase());

/** Text that is really binary: NUL characters, or many replacement/control characters (a lossy decode). */
export function looksBinary(text: string, lossy = false): boolean {
  if (text.includes('\u0000')) return true;
  const sample = text.slice(0, 4000);
  if (!sample) return false;
  // eslint-disable-next-line no-control-regex
  const odd = (sample.match(/[�\u0001-\u0008\u000e-\u001f]/g) ?? []).length;
  return odd / sample.length > (lossy ? 0.01 : 0.05);
}

// ---------------------------------------------------------------- secret redaction

export const REDACTED = '«redacted»';
const SECRET_NAME = '[\\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?key|credential|signing[_-]?key|store[_-]?password)[\\w.-]*';
// name = value / name: value / "name": "value" (value quoted or up to the end of the token)
const ASSIGNMENT = new RegExp(`(["']?${SECRET_NAME}["']?\\s*[:=]\\s*)(?:"([^"\\n]{3,})"|'([^'\\n]{3,})'|([^\\s,;'"\\n]{3,}))`, 'gi');
const TOKENS = /\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bhf_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}|\bglpat-[A-Za-z0-9_-]{16,}/g;
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/**
 * Text with recognizable secrets replaced by «redacted» (line structure kept, so line numbers stay right).
 * @returns the redacted text and how many values were hidden
 */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text.replace(KEY_BLOCK, m => { count++; return m.split('\n').map((_l, i) => (i === 0 ? REDACTED : '')).join('\n'); });
  out = out.replace(ASSIGNMENT, (m, head: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? '';
    // Placeholders and references are not secrets: process.env.X, ${VAR}, <your-key>, getString(...), empty-ish.
    if (/^(process\.env|\$\{|<|\{\{|os\.environ|System\.getenv|BuildConfig\.|null|undefined|true|false|none|xxx+|\*+|changeme)/i.test(value) || /[()\s]/.test(value)) return m;
    // An unquoted value is usually code (`token: string`, `password = input.value`): only hide ones that look like
    // generated keys (8+ characters mixing letters and digits, not a dotted name).
    if (bare !== undefined && !(bare.length >= 8 && /\d/.test(bare) && /[a-z]/i.test(bare) && !/^[A-Za-z_]+\./.test(bare))) return m;
    count++;
    return `${head}${dq !== undefined ? `"${REDACTED}"` : sq !== undefined ? `'${REDACTED}'` : REDACTED}`;
  });
  out = out.replace(TOKENS, () => { count++; return REDACTED; });
  return { text: out, count };
}
