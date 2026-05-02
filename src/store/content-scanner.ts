/**
 * Content scanner — blocks injection/exfiltration in memory writes.
 * Ported from hermes-agent/tools/memory_tool.py (_MEMORY_THREAT_PATTERNS, _INVISIBLE_CHARS, _scan_memory_content).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

const MEMORY_THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: "bypass_restrictions" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: "read_secrets" },
  { pattern: /authorized_keys/i, id: "ssh_backdoor" },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: "ssh_access" },
];

/**
 * Secret detection patterns — checks for credentials, API keys, tokens, and
 * environment variable leaks that should never be persisted to memory.
 * Ported from pk-pi-hermes-evolve engine.ts scanForSecrets().
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string; severity: "high" | "medium" }> = [
  // API keys
  { pattern: /\bsk-ant-api\S{10,}\b/, id: "anthropic_api_key", severity: "high" },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: "openrouter_api_key", severity: "high" },
  { pattern: /\bsk-\S{20,}\b/, id: "openai_api_key", severity: "high" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: "aws_access_key", severity: "high" },
  // Tokens
  { pattern: /\bghp_\S{10,}\b/, id: "github_personal_token", severity: "high" },
  { pattern: /\bghu_\S{10,}\b/, id: "github_user_token", severity: "high" },
  { pattern: /\bxoxb-\S{10,}\b/, id: "slack_bot_token", severity: "high" },
  { pattern: /\bxapp-\S{10,}\b/, id: "slack_app_token", severity: "high" },
  { pattern: /\bntn_\S{10,}\b/, id: "notion_token", severity: "high" },
  { pattern: /\bBearer\s+\S{20,}\b/, id: "bearer_auth_token", severity: "high" },
  // SSH keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: "private_key_block", severity: "high" },
  // Environment variable names that indicate secrets
  { pattern: /\bANTHROPIC_API_KEY\b/, id: "env_anthropic_key", severity: "medium" },
  { pattern: /\bOPENAI_API_KEY\b/, id: "env_openai_key", severity: "medium" },
  { pattern: /\bOPENROUTER_API_KEY\b/, id: "env_openrouter_key", severity: "medium" },
  { pattern: /\bGITHUB_TOKEN\b/, id: "env_github_token", severity: "medium" },
  { pattern: /\bAWS_SECRET_ACCESS_KEY\b/, id: "env_aws_secret", severity: "medium" },
  { pattern: /\bDATABASE_URL\b/, id: "env_database_url", severity: "medium" },
  // Inline secret assignments (likely accidental paste)
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: "password_assignment", severity: "medium" },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: "secret_assignment", severity: "medium" },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: "token_assignment", severity: "medium" },
];

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

/**
 * Scan memory content for injection/exfiltration patterns AND secret leaks.
 * Returns an error string if blocked, or null if content is safe.
 */
export function scanContent(content: string): string | null {
  // Check invisible unicode
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (possible injection).`;
    }
  }

  // Check threat patterns
  for (const { pattern, id } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${id}'. Memory entries are injected into the system prompt and must not contain injection or exfiltration payloads.`;
    }
  }

  // Check secret patterns
  for (const { pattern, id, severity } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content looks like a ${severity}-severity credential or secret ('${id}'). Never persist API keys, tokens, or passwords to memory. Use an .env file or secrets manager instead.`;
    }
  }

  return null;
}

/**
 * Scan content for secrets only (no threat patterns).
 * Returns an array of matched secret IDs, or empty array if none found.
 * Useful for non-blocking warnings (e.g., pre-fill checks in interviews).
 */
export function scanSecrets(content: string): string[] {
  const found: string[] = [];
  for (const { pattern, id } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      found.push(id);
    }
  }
  return found;
}
