import { spawn } from "node:child_process";

import { CliError } from "./errors.js";
import { USER_AGENT } from "./version.js";

export const CUSTOMER_CLI_CLIENT_ID = "warpmetal-customer-cli";
export const DEFAULT_IDENTITY_ORIGIN = "https://identity.warpmetal.com";
export const DEFAULT_ACCOUNT_ORIGIN = "https://warpmetal.com";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SAFE_ERROR = /^[a-z][a-z0-9_]{0,63}$/;

export function validateOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid ${label}: ${value}`, { exitCode: 2 });
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CliError(
      `${label} must use HTTPS (HTTP is allowed for localhost).`,
      { exitCode: 2 },
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new CliError(
      `${label} must be an origin without credentials, path, query, or fragment data.`,
      { exitCode: 2 },
    );
  }
  return url.origin;
}

function responseError(data, status) {
  const candidate =
    typeof data?.error === "string"
      ? data.error
      : data?.error?.code || data?.detail?.code;
  const code = SAFE_ERROR.test(candidate || "") ? candidate : "unavailable";
  return new CliError(`Account authorization failed: ${code} (HTTP ${status}).`, {
    exitCode: code === "access_denied" || code === "denied" ? 4 : 3,
    code,
  });
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CliError("The account service returned an invalid response.", {
      exitCode: 3,
      code: "invalid_response",
    });
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function delay(milliseconds, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    let cancel;
    const timer = setTimeout(() => {
      if (cancel) signal.removeEventListener("abort", cancel);
      resolveDelay();
    }, milliseconds);
    if (!signal) return;
    cancel = () => {
      clearTimeout(timer);
      rejectDelay(
        new CliError("Account authorization was cancelled.", {
          exitCode: 130,
          code: "cancelled",
        }),
      );
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

function exactScopes(value) {
  if (typeof value !== "string") return null;
  const scopes = value.split(/\s+/).filter(Boolean);
  if (
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !["cli:read", "cli:write"].includes(scope))
  ) {
    return null;
  }
  return scopes;
}

function validateToken(data, requestedScopes) {
  const scopes = exactScopes(data?.scope);
  if (
    typeof data?.access_token !== "string" ||
    data.access_token.length === 0 ||
    typeof data?.refresh_token !== "string" ||
    !data.refresh_token.startsWith("wmclr_") ||
    data?.token_type?.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(data?.expires_in) ||
    data.expires_in <= 0 ||
    !scopes ||
    scopes.some((scope) => !requestedScopes.includes(scope)) ||
    !requestedScopes.every((scope) => scopes.includes(scope))
  ) {
    throw new CliError("The account service returned an invalid token response.", {
      exitCode: 3,
      code: "invalid_response",
    });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: new Date(Date.now() + data.expires_in * 1_000).toISOString(),
    scopes,
  };
}

export class CustomerAuthClient {
  constructor({ identityOrigin, accountOrigin, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new CliError("This Node.js runtime does not provide fetch().", {
        exitCode: 2,
      });
    }
    this.identityOrigin = validateOrigin(
      identityOrigin || DEFAULT_IDENTITY_ORIGIN,
      "WarpMetal Identity URL",
    );
    this.accountOrigin = validateOrigin(
      accountOrigin || DEFAULT_ACCOUNT_ORIGIN,
      "WarpMetal account URL",
    );
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #form(path, fields, { signal } = {}) {
    const url = new URL(path, `${this.identityOrigin}/`);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams(fields).toString(),
        signal: combinedSignal(signal, this.timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CliError("Account authorization was cancelled.", {
          exitCode: 130,
          code: "cancelled",
        });
      }
      throw new CliError(`Could not reach ${url.origin}.`, {
        exitCode: 3,
        code: "unavailable",
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CliError("Account authorization refused an HTTP redirect.", {
        exitCode: 3,
        code: "redirect_refused",
      });
    }
    const data = parseJson(await response.text());
    return { ok: response.ok, status: response.status, data };
  }

  async begin(scopes, { signal } = {}) {
    const result = await this.#form(
      "/oauth/device_authorization",
      { client_id: CUSTOMER_CLI_CLIENT_ID, scope: scopes.join(" ") },
      { signal },
    );
    if (!result.ok) throw responseError(result.data, result.status);
    const data = result.data;
    if (
      typeof data?.device_code !== "string" ||
      data.device_code.length === 0 ||
      typeof data?.user_code !== "string" ||
      data.user_code.length === 0 ||
      !Number.isSafeInteger(data?.expires_in) ||
      data.expires_in <= 0 ||
      !Number.isSafeInteger(data?.interval) ||
      data.interval <= 0
    ) {
      throw new CliError("The account service returned an invalid device authorization.", {
        exitCode: 3,
        code: "invalid_response",
      });
    }
    let verification;
    let complete;
    try {
      verification = new URL(data.verification_uri);
      complete = new URL(data.verification_uri_complete);
    } catch {
      throw new CliError("The account service returned an invalid verification URL.", {
        exitCode: 3,
        code: "invalid_response",
      });
    }
    if (
      verification.origin !== this.accountOrigin ||
      complete.origin !== this.accountOrigin ||
      verification.username ||
      verification.password ||
      complete.username ||
      complete.password ||
      verification.hash ||
      complete.hash ||
      verification.pathname !== "/account/cli" ||
      complete.pathname !== "/account/cli" ||
      verification.search ||
      complete.searchParams.size !== 1 ||
      complete.searchParams.get("user_code") !== data.user_code
    ) {
      throw new CliError("The account service returned an untrusted verification URL.", {
        exitCode: 3,
        code: "invalid_response",
      });
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: verification.toString(),
      verificationUriComplete: complete.toString(),
      expiresIn: data.expires_in,
      interval: data.interval,
      scopes,
    };
  }

  async poll(device, { signal } = {}) {
    const deadline = Date.now() + device.expiresIn * 1_000;
    let interval = device.interval * 1_000;
    while (Date.now() < deadline) {
      await delay(Math.min(interval, Math.max(1, deadline - Date.now())), signal);
      if (Date.now() >= deadline) break;
      const result = await this.#form(
        "/oauth/token",
        {
          grant_type: DEVICE_GRANT,
          device_code: device.deviceCode,
          client_id: CUSTOMER_CLI_CLIENT_ID,
        },
        { signal },
      );
      if (result.ok) return validateToken(result.data, device.scopes);
      const code =
        typeof result.data?.error === "string"
          ? result.data.error
          : result.data?.error?.code || result.data?.detail?.code;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += 5_000;
        continue;
      }
      throw responseError(result.data, result.status);
    }
    throw new CliError("Account authorization failed: expired_token.", {
      exitCode: 3,
      code: "expired_token",
    });
  }

  async refresh(refreshToken, scopes, { signal } = {}) {
    const result = await this.#form(
      "/oauth/token",
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CUSTOMER_CLI_CLIENT_ID,
      },
      { signal },
    );
    if (!result.ok) throw responseError(result.data, result.status);
    return validateToken(result.data, scopes);
  }

  async revoke(refreshToken, { signal } = {}) {
    const result = await this.#form(
      "/oauth/revoke",
      { token: refreshToken, client_id: CUSTOMER_CLI_CLIENT_ID },
      { signal },
    );
    if (!result.ok) throw responseError(result.data, result.status);
  }
}

export function openVerificationPage(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnImpl(command[0], command[1], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
