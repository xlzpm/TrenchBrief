export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

const REDACTED_KEY = /token|secret|password|authorization|api[-_]?key|bearer|credential/i;

/**
 * One JSON object per line so a log drain can index briefs, cache hits,
 * and rate-limit decisions without parsing free text.
 */
export function createLogger(
  write: (line: string, level: LogLevel) => void = writeLine,
): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...sanitizeFields(fields),
    };
    write(JSON.stringify(entry), level);
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export const log = createLogger();

export function errorFields(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 300) };
  }
  return { name: "Error", message: "Unknown failure" };
}

function writeLine(line: string, level: LogLevel): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const sanitized = sanitize(fields, 0);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as LogFields;
  }
  return {};
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactText(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = REDACTED_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

function redactText(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
}
