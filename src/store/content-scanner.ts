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

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

/**
 * Scan memory content for injection/exfiltration patterns.
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

  return null;
}
