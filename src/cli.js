import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  booleanOption,
  integerOption,
  parseArguments,
  rejectUnknownOptions,
  stringOption,
} from "./args.js";
import { WarpMetalClient } from "./api.js";
import { CliError, toErrorMessage } from "./errors.js";
import { installSkill } from "./install-skill.js";
import { readSshPublicKey, signSshChallenge } from "./ssh.js";
import { resolveStateDirectory, StateStore } from "./state.js";

const VERSION = "0.1.0";
const TASK_TERMINAL_STATES = new Set([
  "ready",
  "expired",
  "cancellation_pending",
  "cancelled",
  "failed",
  "manual_review",
]);
const OPERATION_TERMINAL_STATES = new Set(["succeeded", "failed", "manual_review"]);
const COMMON_OPTIONS = ["base-url", "json", "state-dir", "help"];

const HELP = `WarpMetal CLI ${VERSION}

Usage:
  warpmetal health [--json]
  warpmetal catalog [--plan <planId>] [--json]
  warpmetal order prepare --plan <planId> --hostname <name> --os <exact-name>
    --ssh-public-key-file <path> [--email <address>] [--idempotency-key <key>]
  warpmetal order status --task <taskId> [--wait] [--timeout-seconds <n>]
  warpmetal checkout challenge --task <taskId>
  warpmetal checkout submit --task <taskId> --payment-signature-file <path>
    [--wait] [--timeout-seconds <n>]
  warpmetal server login --server <serverId> --identity <private-key-path>
  warpmetal server get --server <serverId>
  warpmetal server power --server <serverId> --action <boot|reboot|shutdown>
    --confirm <same-action> [--wait] [--idempotency-key <key>]
  warpmetal operation get --operation <operationId> [--server <serverId>] [--wait]
  warpmetal state list
  warpmetal agent install --target <codex|claude|all> [--scope <user|project>] [--force]

Global options:
  --base-url <url>       Override https://api.warpmetal.com
  --state-dir <path>     Override the private state directory
  --json                 Emit structured, secret-redacted JSON
  --help                 Show help
  --version              Show the CLI version

Credential environment variables:
  WARPMETAL_OWNER_TOKEN  Recovery/bootstrap credential for one explicit command
  WARPMETAL_ACCESS_TOKEN Short-lived SSH-derived credential for one explicit command
  WARPMETAL_API_URL      Alternate API origin
  WARPMETAL_HOME         Alternate state directory

The CLI never accepts bearer tokens directly as command-line arguments.
`;

function writeLine(stream, value = "") {
  stream.write(`${value}\n`);
}

function emit(stream, value, json, human) {
  if (json) writeLine(stream, JSON.stringify(value, null, 2));
  else writeLine(stream, human);
}

function idempotencyKey(kind) {
  return `${kind}-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID()}`;
}

function delay(seconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, seconds * 1_000));
}

function timeoutDeadline(seconds) {
  return Date.now() + seconds * 1_000;
}

function ensureBeforeDeadline(deadline, label) {
  if (Date.now() >= deadline) {
    throw new CliError(`${label} did not reach a terminal state before the timeout.`, {
      exitCode: 8,
    });
  }
}

function suggestedDelay(result, fallback = 2) {
  const retry = Number(result.headers?.["retry-after"]);
  const bodyDelay = Number(result.data?.pollAfterSeconds);
  const candidate = Number.isFinite(retry) && retry > 0 ? retry : bodyDelay;
  return Math.max(1, Math.min(30, Number.isFinite(candidate) && candidate > 0 ? candidate : fallback));
}

async function readHeaderValueFile(path, label) {
  const value = (await readFile(resolve(path), "utf8")).trim();
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new CliError(`${label} must contain one non-empty HTTP header value.`, { exitCode: 2 });
  }
  if (Buffer.byteLength(value) > 64 * 1024) {
    throw new CliError(`${label} is too large.`, { exitCode: 2 });
  }
  return value;
}

async function credentialFromFile(options) {
  const tokenFile = stringOption(options, "token-file");
  return tokenFile ? readHeaderValueFile(tokenFile, "The token file") : undefined;
}

async function requireTaskToken(store, taskId, options, env) {
  const token = (await credentialFromFile(options)) || (await store.taskToken(taskId, env));
  if (!token) {
    throw new CliError(
      `No credential is available for ${taskId}. Restore the private state file, set WARPMETAL_OWNER_TOKEN, or use --token-file.`,
      { exitCode: 4 },
    );
  }
  return token;
}

async function requireServerToken(store, serverId, options, env) {
  const token = (await credentialFromFile(options)) || (await store.serverToken(serverId, env));
  if (!token) {
    throw new CliError(
      `No credential is available for ${serverId}. Run warpmetal server login or provide a recovery token through the environment or --token-file.`,
      { exitCode: 4 },
    );
  }
  return token;
}

function safePreparedOrder(data, stateFile) {
  return {
    task: data.task,
    warning: data.warning,
    credential: {
      stored: true,
      stateFile,
      printed: false,
    },
  };
}

function catalogHuman(data) {
  return data.products
    .map((product) => {
      const header = `${product.id}: $${product.priceUsd}/${product.termDays} days`;
      const systems = product.operatingSystems.map((system) => `  - ${system.name}`).join("\n");
      return `${header}\n${systems}`;
    })
    .join("\n");
}

async function pollTask(client, taskId, token, timeoutSeconds) {
  const deadline = timeoutDeadline(timeoutSeconds);
  while (true) {
    const result = await client.getTask(taskId, token);
    if (TASK_TERMINAL_STATES.has(result.data?.task?.state)) return result;
    ensureBeforeDeadline(deadline, `Task ${taskId}`);
    await delay(suggestedDelay(result));
  }
}

async function pollOperation(client, operationId, token, timeoutSeconds) {
  const deadline = timeoutDeadline(timeoutSeconds);
  while (true) {
    const result = await client.getOperation(operationId, token);
    if (OPERATION_TERMINAL_STATES.has(result.data?.operation?.state)) return result;
    ensureBeforeDeadline(deadline, `Operation ${operationId}`);
    await delay(suggestedDelay(result));
  }
}

function challengeResult(taskId, checkoutBody, response) {
  const paymentRequired = response.headers["payment-required"];
  if (response.status === 402 && !paymentRequired) {
    throw new CliError("WarpMetal returned HTTP 402 without PAYMENT-REQUIRED.");
  }
  return {
    status: response.data?.status,
    taskId,
    paymentAttemptId:
      response.data?.paymentAttemptId || response.headers["x-warpmetal-payment-attempt"],
    paymentRequired,
    checkoutBodySha256: createHash("sha256").update(checkoutBody).digest("hex"),
  };
}

async function handleHealth(client, { json, stdout }) {
  const result = await client.health();
  emit(
    stdout,
    result.data,
    json,
    `Service: ${result.data?.status}\nPurchasing ready: ${Boolean(result.data?.purchasingReady)}`,
  );
  return result.data?.purchasingReady ? 0 : 3;
}

async function handleCatalog(client, options, { json, stdout }) {
  const result = await client.catalog();
  const plan = stringOption(options, "plan");
  const data = plan
    ? { ...result.data, products: result.data.products.filter((product) => product.id === plan) }
    : result.data;
  if (plan && data.products.length === 0) {
    throw new CliError(`Unknown WarpMetal plan: ${plan}`, { exitCode: 2 });
  }
  emit(stdout, data, json, catalogHuman(data));
  return 0;
}

async function handlePrepareOrder(client, store, options, context) {
  const planId = stringOption(options, "plan", { required: true });
  const hostname = stringOption(options, "hostname", { required: true });
  const osName = stringOption(options, "os", { required: true });
  const publicKeyFile = stringOption(options, "ssh-public-key-file", { required: true });
  const email = stringOption(options, "email");

  const health = await client.health();
  if (!health.data?.purchasingReady) {
    throw new CliError("WarpMetal purchasing is not ready. No order was created.", {
      exitCode: 3,
      details: health.data,
    });
  }
  const catalog = (await client.catalog()).data;
  const product = catalog.products.find((candidate) => candidate.id === planId);
  if (!product) {
    throw new CliError(`Unknown live WarpMetal plan: ${planId}`, { exitCode: 2 });
  }
  if (!product?.operatingSystems?.some((system) => system.name === osName)) {
    throw new CliError(
      `--os must exactly match a live free operating-system name for the ${planId} plan.`,
      { exitCode: 2 },
    );
  }

  const sshPublicKey = await readSshPublicKey(publicKeyFile);
  const request = { planId, hostname, osName, sshPublicKey };
  if (email) request.email = email;
  const key = stringOption(options, "idempotency-key") || idempotencyKey("order");
  const response = await client.prepareOrder(request, key);
  const checkoutBody = JSON.stringify({ taskId: response.data.task.id });
  await store.savePreparedOrder(response.data, checkoutBody);
  const safe = safePreparedOrder(response.data, store.path);
  emit(
    context.stdout,
    safe,
    context.json,
    `Prepared ${safe.task.id} for server ${safe.task.serverId}.\nRecovery credential saved to ${store.path} and not printed.`,
  );
  return 0;
}

async function handleTaskStatus(client, store, options, context) {
  const taskId = stringOption(options, "task", { required: true });
  const token = await requireTaskToken(store, taskId, options, context.env);
  const timeout = integerOption(options, "timeout-seconds", 900);
  const result = booleanOption(options, "wait")
    ? await pollTask(client, taskId, token, timeout)
    : await client.getTask(taskId, token);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${result.data.task.id}: ${result.data.task.state}${result.data.task.publicIp ? ` (${result.data.task.publicIp})` : ""}`,
  );
  return result.data.task.state === "manual_review" ? 6 : 0;
}

async function handleCheckoutChallenge(client, store, options, context) {
  const taskId = stringOption(options, "task", { required: true });
  const order = await store.order(taskId);
  if (!order?.checkoutPath || !order?.checkoutBody) {
    throw new CliError(`No exact checkout state exists for ${taskId}.`, { exitCode: 2 });
  }
  const token = await requireTaskToken(store, taskId, options, context.env);
  const response = await client.checkout(order.checkoutPath, {
    bodyText: order.checkoutBody,
    token,
  });
  const safe = challengeResult(taskId, order.checkoutBody, response);
  if (safe.paymentRequired) {
    await store.savePaymentChallenge(taskId, safe);
  }
  emit(
    context.stdout,
    safe,
    context.json,
    response.status === 402
      ? `Payment authorization required for ${taskId}.\nPAYMENT-REQUIRED: ${safe.paymentRequired}`
      : `Checkout status for ${taskId}: ${safe.status}`,
  );
  return response.status === 409 ? 6 : response.status === 402 ? 7 : 0;
}

async function handleCheckoutSubmit(client, store, options, context) {
  const taskId = stringOption(options, "task", { required: true });
  const signatureFile = stringOption(options, "payment-signature-file", { required: true });
  const paymentSignature = await readHeaderValueFile(signatureFile, "The payment signature file");
  const order = await store.order(taskId);
  if (!order?.checkoutPath || !order?.checkoutBody) {
    throw new CliError(`No exact checkout state exists for ${taskId}.`, { exitCode: 2 });
  }
  const token = await requireTaskToken(store, taskId, options, context.env);
  const wait = booleanOption(options, "wait");
  const deadline = timeoutDeadline(integerOption(options, "timeout-seconds", 900));

  while (true) {
    const response = await client.checkout(order.checkoutPath, {
      bodyText: order.checkoutBody,
      token,
      paymentSignature,
    });
    const safe = challengeResult(taskId, order.checkoutBody, response);
    if (safe.paymentRequired) await store.savePaymentChallenge(taskId, safe);
    const retryable =
      response.status === 202 &&
      ["payment_pending", "payment_finalizing"].includes(response.data?.status);
    if (wait && retryable) {
      ensureBeforeDeadline(deadline, `Checkout ${taskId}`);
      await delay(suggestedDelay(response));
      continue;
    }

    const output = {
      ...safe,
      task: response.data?.task,
      message: response.data?.message,
    };
    emit(
      context.stdout,
      output,
      context.json,
      `Checkout status for ${taskId}: ${output.status}${output.message ? `\n${output.message}` : ""}`,
    );
    if (response.status === 409) return 6;
    if (response.status === 402) return 7;
    if (retryable) return 8;
    return 0;
  }
}

async function handleServerLogin(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const identity = stringOption(options, "identity", { required: true });
  const challenge = (await client.issueSshChallenge(serverId)).data;
  const signature = await signSshChallenge(challenge.payload, identity);
  const token = (await client.exchangeSshChallenge(serverId, challenge.challengeId, signature)).data;
  await store.saveAccessToken(serverId, token.accessToken, token.expiresAt);
  const safe = {
    serverId,
    sshFingerprint: challenge.sshFingerprint,
    accessTokenExpiresAt: token.expiresAt,
    credential: { stored: true, stateFile: store.path, printed: false },
  };
  emit(
    context.stdout,
    safe,
    context.json,
    `Authenticated ${serverId} until ${token.expiresAt}. The access token was saved and not printed.`,
  );
  return 0;
}

async function handleServerGet(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = await client.getServer(serverId, token);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${serverId}: ${result.data.task.state}${result.data.task.publicIp ? ` (${result.data.task.publicIp})` : ""}`,
  );
  return 0;
}

async function handleServerPower(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const action = stringOption(options, "action", { required: true });
  const confirmation = stringOption(options, "confirm", { required: true });
  if (!["boot", "reboot", "shutdown"].includes(action)) {
    throw new CliError("--action must be boot, reboot, or shutdown.", { exitCode: 2 });
  }
  if (confirmation !== action) {
    throw new CliError(`Confirm this operation with --confirm ${action}.`, { exitCode: 2 });
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const key = stringOption(options, "idempotency-key") || idempotencyKey(`power-${action}`);
  let result = await client.powerServer(serverId, action, token, key);
  const operationId = result.data?.operation?.id;
  if (!operationId) throw new CliError("WarpMetal did not return an operation ID.");
  await store.saveOperation(operationId, serverId, `power:${action}`);
  if (booleanOption(options, "wait")) {
    result = await pollOperation(
      client,
      operationId,
      token,
      integerOption(options, "timeout-seconds", 900),
    );
  }
  emit(
    context.stdout,
    result.data,
    context.json,
    `Power ${action} operation ${operationId}: ${result.data.operation.state}`,
  );
  return result.data.operation.state === "manual_review" ? 6 : 0;
}

async function handleOperationGet(client, store, options, context) {
  const operationId = stringOption(options, "operation", { required: true });
  const saved = await store.operation(operationId);
  const serverId = stringOption(options, "server") || saved?.serverId;
  if (!serverId) {
    throw new CliError("--server is required when the operation is not present in local state.", {
      exitCode: 2,
    });
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = booleanOption(options, "wait")
    ? await pollOperation(
        client,
        operationId,
        token,
        integerOption(options, "timeout-seconds", 900),
      )
    : await client.getOperation(operationId, token);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${operationId}: ${result.data.operation.state}`,
  );
  return result.data.operation.state === "manual_review" ? 6 : 0;
}

async function dispatch(positionals, options, context) {
  const command = positionals.join(" ");
  if (!command || command === "help" || booleanOption(options, "help")) {
    writeLine(context.stdout, HELP.trimEnd());
    return 0;
  }
  if (command === "version") {
    rejectUnknownOptions(options, ["json"]);
    if (context.json) emit(context.stdout, { version: VERSION }, true, VERSION);
    else writeLine(context.stdout, VERSION);
    return 0;
  }
  if (command === "agent install") {
    rejectUnknownOptions(options, [...COMMON_OPTIONS, "target", "scope", "force"]);
    const target = stringOption(options, "target", { required: true });
    const scope = stringOption(options, "scope") || "user";
    const installed = await installSkill(target, {
      scope,
      force: booleanOption(options, "force"),
      cwd: context.cwd,
      env: context.env,
    });
    emit(
      context.stdout,
      { installed },
      context.json,
      installed.map((entry) => `Installed WarpMetal skill for ${entry.target}: ${entry.path}`).join("\n"),
    );
    return 0;
  }

  const baseUrl = stringOption(options, "base-url");
  const stateDir = stringOption(options, "state-dir") || resolveStateDirectory({ env: context.env });
  const client = new WarpMetalClient({
    baseUrl: baseUrl || context.env.WARPMETAL_API_URL,
    fetchImpl: context.fetchImpl,
  });
  const store = new StateStore(stateDir);

  switch (command) {
    case "health":
      rejectUnknownOptions(options, COMMON_OPTIONS);
      return handleHealth(client, context);
    case "catalog":
      rejectUnknownOptions(options, [...COMMON_OPTIONS, "plan"]);
      return handleCatalog(client, options, context);
    case "order prepare":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "plan",
        "hostname",
        "os",
        "ssh-public-key-file",
        "email",
        "idempotency-key",
      ]);
      return handlePrepareOrder(client, store, options, context);
    case "order status":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "task",
        "token-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleTaskStatus(client, store, options, context);
    case "checkout challenge":
      rejectUnknownOptions(options, [...COMMON_OPTIONS, "task", "token-file"]);
      return handleCheckoutChallenge(client, store, options, context);
    case "checkout submit":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "task",
        "token-file",
        "payment-signature-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleCheckoutSubmit(client, store, options, context);
    case "server login":
      rejectUnknownOptions(options, [...COMMON_OPTIONS, "server", "identity"]);
      return handleServerLogin(client, store, options, context);
    case "server get":
      rejectUnknownOptions(options, [...COMMON_OPTIONS, "server", "token-file"]);
      return handleServerGet(client, store, options, context);
    case "server power":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
        "action",
        "confirm",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleServerPower(client, store, options, context);
    case "operation get":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "operation",
        "server",
        "token-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleOperationGet(client, store, options, context);
    case "state list": {
      rejectUnknownOptions(options, COMMON_OPTIONS);
      const summary = await store.summary();
      emit(
        context.stdout,
        summary,
        context.json,
        `State: ${summary.stateFile}\nOrders: ${summary.orders.length}\nServers: ${summary.servers.length}\nOperations: ${summary.operations.length}`,
      );
      return 0;
    }
    default:
      throw new CliError(`Unknown command: ${command}`, { exitCode: 2 });
  }
}

export async function main(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    cwd = process.cwd(),
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (argv.includes("--version")) {
    writeLine(stdout, VERSION);
    return 0;
  }
  const json = argv.includes("--json");
  try {
    const { positionals, options } = parseArguments(argv);
    return await dispatch(positionals, options, { stdout, stderr, env, cwd, fetchImpl, json });
  } catch (error) {
    const message = toErrorMessage(error);
    if (json) {
      writeLine(
        stderr,
        JSON.stringify({
          error: {
            type: error?.name || "Error",
            code: error?.code,
            message,
            retryAfterSeconds: error?.retryAfter ? Number(error.retryAfter) : undefined,
          },
        }),
      );
    } else {
      writeLine(stderr, `Error: ${message}`);
    }
    return error instanceof CliError ? error.exitCode : 1;
  }
}

export { HELP, VERSION };
