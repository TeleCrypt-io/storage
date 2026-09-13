const SENSITIVE_KEY_SOURCE =
  "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|code|state|code[_-]?verifier|device[_-]?code|(?:oidc[_-]?)?client[_-]?id|(?:matrix[_-]?)?(?:user|device)[_-]?id|(?:user|client|device|session|account|member|customer|owner|recipient|room|vault|folder|file|tree|completed)[_-]?ids?|mxid|email(?:[_-]?address)?|user(?:name)?|display[_-]?name|recovery[_-]?(?:key|secret)|(?:secret[_-]?storage|private|encryption|signing)[_-]?key|key)";
const SENSITIVE_ASSIGNMENT_PREFIX =
  `\\b${SENSITIVE_KEY_SOURCE}\\b["']?\\s*[:=]\\s*`;
const SENSITIVE_KEY_PATTERN = new RegExp(`^${SENSITIVE_KEY_SOURCE}$`, "iu");
const QUOTED_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX})("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`,
  "giu",
);
const UNQUOTED_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `(${SENSITIVE_ASSIGNMENT_PREFIX})([^"'\\s,;}]+)`,
  "giu",
);

const BEARER_PATTERN = /\b(Bearer\s+)[-A-Za-z0-9._~+/]+=*/giu;
const TOKEN_VALUE_PATTERN = /\b(token[-_])[-A-Za-z0-9._~+/]+/giu;
const URI_CREDENTIAL_PATTERN = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu;
const URI_SECRET_PARAMETER_PATTERN =
  /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code|state|secret|password)=)[^&#\s]*/giu;

function escapeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}

/**
 * Keeps complete diagnostic text while removing credentials and terminal
 * control characters. There is deliberately no output-size limit here.
 */
export function sanitizeDiagnosticText(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(URI_CREDENTIAL_PATTERN, "$1[REDACTED]@");
  sanitized = sanitized.replace(URI_SECRET_PARAMETER_PATTERN, "$1[REDACTED]");
  sanitized = sanitized.replace(BEARER_PATTERN, "$1[REDACTED]");
  sanitized = sanitized.replace(
    QUOTED_SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, prefix: string, quoted: string) => `${prefix}${quoted[0]}[REDACTED]${quoted[0]}`,
  );
  sanitized = sanitized.replace(UNQUOTED_SENSITIVE_ASSIGNMENT_PATTERN, "$1[REDACTED]");
  sanitized = sanitized.replace(TOKEN_VALUE_PATTERN, "$1[REDACTED]");
  return escapeControlCharacters(sanitized);
}

function primitiveDetail(value: unknown): string | undefined {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return sanitizeDiagnosticText(String(value));
  return undefined;
}

function formatDiagnosticValue(value: unknown, seen: Set<object>): string {
  const primitive = primitiveDetail(value);
  if (primitive !== undefined) return primitive;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return sanitizeDiagnosticText(String(value));
  if (seen.has(value)) return "[circular diagnostic reference]";
  seen.add(value);

  try {
    if (value instanceof Error) {
      const name = value.name || "Error";
      const message = value.message;
      const details = [
        message === "" ? "[error without a message]" : sanitizeDiagnosticText(message),
      ];
      if (name !== "Error") details.push(`name=${sanitizeDiagnosticText(name)}`);
      if (value.stack && value.stack !== `${name}: ${message}`) {
        details.push(`stack=${sanitizeDiagnosticText(value.stack)}`);
      }
      if (value.cause !== undefined) {
        details.push(`cause: ${formatDiagnosticValue(value.cause, seen)}`);
      }
      if (value instanceof AggregateError) {
        details.push(`errors: [${[...value.errors].map((error) => formatDiagnosticValue(error, seen)).join(", ")}]`);
      }
      for (const [key, child] of Object.entries(value)) {
        if (["name", "message", "stack", "cause", "errors"].includes(key)) continue;
        const safeKey = sanitizeDiagnosticText(key);
        details.push(
          `${safeKey}=${SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : formatDiagnosticValue(child, seen)}`,
        );
      }
      return details.join("; ");
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => formatDiagnosticValue(item, seen)).join(", ")}]`;
    }

    const properties = Object.entries(value).map(([key, child]) => {
      const safeKey = sanitizeDiagnosticText(key);
      return `${safeKey}=${SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : formatDiagnosticValue(child, seen)}`;
    });
    return properties.length === 0 ? "[object Object]" : `{ ${properties.join(", ")} }`;
  } finally {
    seen.delete(value);
  }
}

/** Format an error, its cause, and AggregateError members without truncation. */
export function formatDiagnosticError(error: unknown): string {
  return formatDiagnosticValue(error, new Set<object>());
}

/** Preserve a cause as a secret-safe Error for lower-level Web boundaries. */
export function sanitizeDiagnosticError(error: unknown): Error {
  return new Error(formatDiagnosticError(error));
}
