const MAX_BODY_SUMMARY_LENGTH = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function trimSummary(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_BODY_SUMMARY_LENGTH
    ? `${normalized.slice(0, MAX_BODY_SUMMARY_LENGTH)}...`
    : normalized;
}

function sanitizeRoute(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?")[0].split("#")[0] || undefined;
  }
}

function bodySummary(value: unknown): string | undefined {
  if (typeof value === "string") {
    return trimSummary(value);
  }
  if (value == null) {
    return undefined;
  }
  if (isRecord(value)) {
    const summary: Record<string, unknown> = {};
    const error = isRecord(value.error) ? value.error : undefined;
    for (const key of ["code", "status", "message", "error", "reason"]) {
      if (typeof value[key] === "string" || typeof value[key] === "number" || typeof value[key] === "boolean") {
        summary[key] = value[key];
      }
    }
    if (error) {
      for (const key of ["code", "status", "message", "reason"]) {
        if (typeof error[key] === "string" || typeof error[key] === "number" || typeof error[key] === "boolean") {
          summary[`error_${key}`] = error[key];
        }
      }
    }
    const source = Object.keys(summary).length ? summary : value;
    try {
      return trimSummary(JSON.stringify(source));
    } catch {
      return undefined;
    }
  }
  try {
    return trimSummary(String(value));
  } catch {
    return undefined;
  }
}

export function externalImportUpstreamErrorDetails(
  error: unknown,
  context: {
    service?: string;
    operation?: string;
    route?: string;
    requestCount?: number;
  } = {},
) {
  const record = isRecord(error) ? error : {};
  const response = isRecord(record.response) ? record.response : {};
  const responseConfig = isRecord(response.config) ? response.config : {};
  const config = isRecord(record.config) ? record.config : {};
  const details: Record<string, unknown> = {};

  if (context.service) {
    details.upstream_service = context.service;
  }
  if (context.operation) {
    details.upstream_operation = context.operation;
  }

  const status = response.status ?? record.status ?? record.statusCode;
  if (typeof status === "number" || typeof status === "string") {
    details.upstream_status = status;
  }

  const statusText = response.statusText ?? record.statusText;
  if (typeof statusText === "string" && statusText.trim()) {
    details.upstream_status_text = statusText.trim();
  }

  const code = record.code;
  if (typeof code === "string" && code.trim()) {
    details.upstream_code = code.trim();
  }

  const route = sanitizeRoute(context.route ?? responseConfig.url ?? config.url ?? record.url);
  if (route) {
    details.upstream_route = route;
  }

  const summary = bodySummary(response.data ?? record.body ?? record.data);
  if (summary) {
    details.upstream_body_summary = summary;
  }

  if (typeof context.requestCount === "number") {
    details.request_count = context.requestCount;
  }

  return details;
}
