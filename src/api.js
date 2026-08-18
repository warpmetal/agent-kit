import { ApiError, CliError } from "./errors.js";

const DEFAULT_API_URL = "https://api.warpmetal.com";

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid WarpMetal API URL: ${value}`, { exitCode: 2 });
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CliError("WarpMetal API URLs must use HTTPS (HTTP is allowed for localhost).", {
      exitCode: 2,
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError("WarpMetal API URLs cannot contain credentials, query, or fragment data.", {
      exitCode: 2,
    });
  }
  return url.toString().replace(/\/$/, "");
}

function parseResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function headerMap(headers) {
  return Object.fromEntries(headers.entries());
}

export class WarpMetalClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new CliError("This Node.js runtime does not provide fetch().", { exitCode: 2 });
    }
    this.baseUrl = validateBaseUrl(baseUrl || process.env.WARPMETAL_API_URL || DEFAULT_API_URL);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(
    method,
    path,
    {
      body,
      bodyText,
      token,
      idempotencyKey,
      paymentSignature,
      acceptStatuses = [],
    } = {},
  ) {
    const url = new URL(path, `${this.baseUrl}/`);
    const headers = {
      Accept: "application/json",
      "User-Agent": "warpmetal-cli/0.1.0",
    };
    let requestBody;
    if (bodyText !== undefined) {
      requestBody = bodyText;
      headers["Content-Type"] = "application/json";
    } else if (body !== undefined) {
      requestBody = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (paymentSignature) headers["PAYMENT-SIGNATURE"] = paymentSignature;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`Could not reach ${url.origin}: ${message}`, { exitCode: 3 });
    }

    const text = await response.text();
    const data = parseResponseBody(text);
    const result = {
      status: response.status,
      data,
      headers: headerMap(response.headers),
      bodyText: text,
    };
    if (response.ok || acceptStatuses.includes(response.status)) return result;

    const apiError = data?.error;
    throw new ApiError(apiError?.message || `Request failed with HTTP ${response.status}.`, {
      status: response.status,
      code: apiError?.code,
      retryAfter: response.headers.get("retry-after") || undefined,
      body: data,
    });
  }

  health() {
    return this.request("GET", "/api/health");
  }

  catalog() {
    return this.request("GET", "/api/catalog");
  }

  prepareOrder(body, idempotencyKey) {
    return this.request("POST", "/api/orders", { body, idempotencyKey });
  }

  getTask(taskId, token) {
    return this.request("GET", `/api/tasks/${encodeURIComponent(taskId)}`, { token });
  }

  checkout(path, { bodyText, token, paymentSignature }) {
    return this.request("POST", path, {
      bodyText,
      token,
      paymentSignature,
      acceptStatuses: [402, 409],
    });
  }

  issueSshChallenge(serverId) {
    return this.request(
      "POST",
      `/api/servers/${encodeURIComponent(serverId)}/auth/challenges`,
      { body: {} },
    );
  }

  exchangeSshChallenge(serverId, challengeId, signature) {
    return this.request(
      "POST",
      `/api/servers/${encodeURIComponent(serverId)}/auth/tokens`,
      { body: { challengeId, signature } },
    );
  }

  getServer(serverId, token) {
    return this.request("GET", `/api/servers/${encodeURIComponent(serverId)}`, { token });
  }

  powerServer(serverId, action, token, idempotencyKey) {
    return this.request("POST", `/api/servers/${encodeURIComponent(serverId)}/power`, {
      body: { action },
      token,
      idempotencyKey,
    });
  }

  getOperation(operationId, token) {
    return this.request("GET", `/api/operations/${encodeURIComponent(operationId)}`, {
      token,
    });
  }
}

export { DEFAULT_API_URL };
