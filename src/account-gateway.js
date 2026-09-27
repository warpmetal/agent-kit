import { CliError } from "./errors.js";
import { AccountSessionStore } from "./account-session.js";
import {
  CustomerAuthClient,
  DEFAULT_ACCOUNT_ORIGIN,
  DEFAULT_IDENTITY_ORIGIN,
  validateOrigin,
} from "./customer-auth.js";
import { USER_AGENT } from "./version.js";

function safeGatewayCode(data) {
  const value = data?.code ?? data?.error?.code;
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : "unavailable";
}

function allowedAccountRoute(method, path) {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (method === "POST") return path === "/account/cli/orders";
  if (method !== "GET") return false;
  return (
    [
      "/account/cli/whoami",
      "/account/cli/devices",
      "/account/cli/orders",
    ].includes(path) ||
    /^\/account\/cli\/(?:devices|orders)\/[^/?#]+$/.test(path)
  );
}

export class AccountGatewayClient {
  constructor({
    accountOrigin,
    accessToken,
    scopes = [],
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    this.accountOrigin = validateOrigin(
      accountOrigin || DEFAULT_ACCOUNT_ORIGIN,
      "WarpMetal account URL",
    );
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new CliError("A WarpMetal account access token is required.", {
        exitCode: 4,
        code: "invalid_token",
      });
    }
    this.accessToken = accessToken;
    this.scopes = scopes;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { body, idempotencyKey } = {}) {
    if (!allowedAccountRoute(method, path)) {
      throw new CliError("The requested account gateway route is not allowed.", {
        exitCode: 2,
        code: "account_route_not_allowed",
      });
    }
    const url = new URL(path, `${this.accountOrigin}/`);
    if (url.origin !== this.accountOrigin || `${url.pathname}${url.search}${url.hash}` !== path) {
      throw new CliError("The requested account gateway route is not allowed.", {
        exitCode: 2,
        code: "account_route_not_allowed",
      });
    }
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "manual",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CliError(`Could not reach ${url.origin}.`, {
        exitCode: 3,
        code: "unavailable",
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CliError("The account gateway refused an HTTP redirect.", {
        exitCode: 3,
        code: "redirect_refused",
      });
    }
    let data;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new CliError("The account gateway returned an invalid response.", {
        exitCode: 3,
        code: "invalid_response",
      });
    }
    if (!response.ok) {
      const code = safeGatewayCode(data);
      throw new CliError(`Account request failed: ${code} (HTTP ${response.status}).`, {
        exitCode: response.status === 401 || response.status === 403 ? 4 : 3,
        code,
      });
    }
    return data;
  }

  whoami() {
    return this.request("GET", "/account/cli/whoami");
  }

  orders() {
    return this.request("GET", "/account/cli/orders");
  }

  order(id) {
    return this.request("GET", `/account/cli/orders/${encodeURIComponent(id)}`);
  }

  devices() {
    return this.request("GET", "/account/cli/devices");
  }

  device(id) {
    return this.request("GET", `/account/cli/devices/${encodeURIComponent(id)}`);
  }

  prepareOrder(body, idempotencyKey) {
    if (!this.scopes.includes("cli:write")) {
      throw new CliError("This account session does not include cli:write.", {
        exitCode: 4,
        code: "insufficient_scope",
      });
    }
    return this.request("POST", "/account/cli/orders", { body, idempotencyKey });
  }
}

export function accountSessionContext({
  stateDirectory,
  identityOrigin = DEFAULT_IDENTITY_ORIGIN,
  accountOrigin = DEFAULT_ACCOUNT_ORIGIN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const checkedIdentity = validateOrigin(identityOrigin, "WarpMetal Identity URL");
  const checkedAccount = validateOrigin(accountOrigin, "WarpMetal account URL");
  return {
    identityOrigin: checkedIdentity,
    accountOrigin: checkedAccount,
    auth: new CustomerAuthClient({
      identityOrigin: checkedIdentity,
      accountOrigin: checkedAccount,
      fetchImpl,
    }),
    store: new AccountSessionStore(stateDirectory, {
      identityOrigin: checkedIdentity,
      accountOrigin: checkedAccount,
    }),
    fetchImpl,
  };
}

export async function authenticatedAccountClient(options) {
  const context = accountSessionContext(options);
  return context.store.withLock(async () => {
    let session = await context.store.read();
    if (!session) return null;
    if (Date.parse(session.accessExpiresAt) <= Date.now() + 30_000) {
      let refreshed;
      try {
        refreshed = await context.auth.refresh(
          session.refreshToken,
          session.scopes,
        );
      } catch (error) {
        await context.store.clear();
        if (error?.code === "unavailable") {
          throw new CliError(
            "Refresh completion is unknown, so the saved session was cleared. Run warpmetal login again.",
            { exitCode: 3, code: "refresh_ambiguous" },
          );
        }
        throw error;
      }
      try {
        session = { ...session, ...refreshed, refreshedAt: new Date().toISOString() };
        await context.store.write(session);
      } catch (error) {
        await context.store.clear();
        throw new CliError(
          "The rotated account session could not be saved, so local credentials were cleared. Run warpmetal login again.",
          { exitCode: 3, code: "refresh_ambiguous" },
        );
      }
    }
    return {
      client: new AccountGatewayClient({
        accountOrigin: context.accountOrigin,
        accessToken: session.accessToken,
        scopes: session.scopes,
        fetchImpl: context.fetchImpl,
      }),
      session,
      context,
    };
  });
}
