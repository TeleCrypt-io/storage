const SENSITIVE_KEY_SOURCE =
  "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|code|state|code[_-]?verifier|device[_-]?code|(?:oidc[_-]?)?client[_-]?id|(?:matrix[_-]?)?(?:user|device)[_-]?id|(?:user|client|device|session|account|member|customer|owner|recipient|room|vault|folder|file|tree|completed)[_-]?ids?|mxid|email(?:[_-]?address)?|user(?:name)?|display[_-]?name|recovery[_-]?(?:key|secret)|(?:secret[_-]?storage|private|encryption|signing)[_-]?key|key)";
const SENSITIVE_ASSIGNMENT_PREFIX =
  `\\b${SENSITIVE_KEY_SOURCE}\\b["']?\\s*[:=]\\s*`;
const SENSITIVE_KEY_PATTERN = new RegExp(`^${SENSITIVE_KEY_SOURCE}$`, "iu");
const QUOTED_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `(${SENSITIVE_ASSIGNMENT_PREFIX})(["'])([\\s\\S]*?)\\2`,
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
  let sanitized = escapeControlCharacters(value);
  sanitized = sanitized.replace(URI_CREDENTIAL_PATTERN, "$1[REDACTED]@");
  sanitized = sanitized.replace(URI_SECRET_PARAMETER_PATTERN, "$1[REDACTED]");
  sanitized = sanitized.replace(BEARER_PATTERN, "$1[REDACTED]");
  sanitized = sanitized.replace(QUOTED_SENSITIVE_ASSIGNMENT_PATTERN, "$1$2[REDACTED]$2");
  sanitized = sanitized.replace(UNQUOTED_SENSITIVE_ASSIGNMENT_PATTERN, "$1[REDACTED]");
  sanitized = sanitized.replace(TOKEN_VALUE_PATTERN, "$1[REDACTED]");
  return sanitized;
}

function primitiveDetail(value: unknown): string | undefined {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return sanitizeDiagnosticText(String(value));
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type PropertyRead =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

function readProperty(value: object, key: PropertyKey): PropertyRead {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch (error) {
    return { ok: false, error };
  }
}

function propertyName(key: PropertyKey): string {
  return sanitizeDiagnosticText(String(key));
}

function formatPropertyFailure(key: PropertyKey, error: unknown, seen: Set<object>): string {
  return `${propertyName(key)}=[property unavailable: ${formatDiagnosticValue(error, seen)}]`;
}

function formatOwnProperties(
  value: object,
  seen: Set<object>,
  excluded: ReadonlySet<PropertyKey>,
): string[] {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    return [`properties=[properties unavailable: ${formatDiagnosticValue(error, seen)}]`];
  }
  const details: string[] = [];
  for (const key of keys) {
    if (excluded.has(key)) continue;
    const read = readProperty(value, key);
    if (!read.ok) {
      details.push(formatPropertyFailure(key, read.error, seen));
      continue;
    }
    const keyText = propertyName(key);
    details.push(
      `${keyText}=${SENSITIVE_KEY_PATTERN.test(keyText) ? "[REDACTED]" : formatDiagnosticValue(read.value, seen)}`,
    );
  }
  return details;
}

function formatDiagnosticValue(value: unknown, seen: Set<object>): string {
  const primitive = primitiveDetail(value);
  if (primitive !== undefined) return primitive;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (!isObject(value)) return sanitizeDiagnosticText(String(value));
  if (seen.has(value)) return "[circular diagnostic reference]";
  seen.add(value);

  try {
    const messageRead = readProperty(value, "message");
    const isErrorLike = value instanceof Error ||
      (messageRead.ok && typeof messageRead.value === "string");
    if (isErrorLike) {
      const details: string[] = [];
      if (!messageRead.ok) {
        details.push(formatPropertyFailure("message", messageRead.error, seen));
      } else if (typeof messageRead.value === "string") {
        details.push(
          messageRead.value === ""
            ? "[error without a message]"
            : sanitizeDiagnosticText(messageRead.value),
        );
      } else if (messageRead.value !== undefined) {
        details.push(`message=${formatDiagnosticValue(messageRead.value, seen)}`);
      } else {
        details.push("[error without a message]");
      }
      const name = readProperty(value, "name");
      if (!name.ok) {
        details.push(formatPropertyFailure("name", name.error, seen));
      } else if (name.value !== undefined) {
        details.push(`name=${formatDiagnosticValue(name.value, seen)}`);
      }
      const stack = readProperty(value, "stack");
      if (!stack.ok) {
        details.push(formatPropertyFailure("stack", stack.error, seen));
      } else if (stack.value !== undefined) {
        details.push(`stack=${formatDiagnosticValue(stack.value, seen)}`);
      }
      const cause = readProperty(value, "cause");
      if (!cause.ok) {
        details.push(formatPropertyFailure("cause", cause.error, seen));
      } else if (cause.value !== undefined) {
        details.push(`cause: ${formatDiagnosticValue(cause.value, seen)}`);
      }
      if (value instanceof AggregateError) {
        const errors = readProperty(value, "errors");
        if (!errors.ok) {
          details.push(formatPropertyFailure("errors", errors.error, seen));
        } else if (Array.isArray(errors.value)) {
          details.push(`errors: [${errors.value.map((error) => formatDiagnosticValue(error, seen)).join(", ")}]`);
        } else {
          details.push(`errors=${formatDiagnosticValue(errors.value, seen)}`);
        }
      }
      details.push(...formatOwnProperties(value, seen, new Set(["name", "message", "stack", "cause", "errors"])));
      return details.join("; ");
    }

    if (Array.isArray(value)) {
      const items = value.map((item) => formatDiagnosticValue(item, seen));
      const properties = formatOwnProperties(
        value,
        seen,
        new Set<PropertyKey>(["length", ...Array.from(value.keys(), (index) => String(index))]),
      );
      return properties.length === 0
        ? `[${items.join(", ")}]`
        : `[${items.join(", ")}; ${properties.join(", ")}]`;
    }

    const properties = formatOwnProperties(value, seen, new Set<PropertyKey>());
    if (properties.length > 0) return `{ ${properties.join(", ")} }`;
    try {
      return sanitizeDiagnosticText(Object.prototype.toString.call(value));
    } catch (error) {
      return `[object description unavailable: ${formatDiagnosticValue(error, seen)}]`;
    }
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
