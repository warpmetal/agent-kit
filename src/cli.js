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
import { connectionProfile, writeConnectionProfile } from "./connection.js";
import { CliError, toErrorMessage } from "./errors.js";
import { installSkill } from "./install-skill.js";
import { installRuntime } from "./installer.js";
import {
  createPaymentRequestEnvelope,
  defaultPaymentPaths,
  paymentWorkflow,
  readPaymentArtifact,
  writePaymentRequestEnvelope,
} from "./payment.js";
import {
  readSandboxFile,
  requireTemporaryConfirmation,
  sandboxFromOptions,
  validateRuntimeCatalog,
} from "./runtime.js";
import {
  connectSandbox,
  generateSandboxKey,
  readSshPublicKey,
  signSshChallenge,
} from "./ssh.js";
import { resolveStateDirectory, StateStore } from "./state.js";
import { VERSION } from "./version.js";

const TASK_TERMINAL_STATES = new Set([
  "ready",
  "expired",
  "cancellation_pending",
  "cancelled",
  "failed",
  "manual_review",
]);
const OPERATION_TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "manual_review",
]);
const RUNTIME_TERMINAL_STATES = new Set([
  "ready",
  "degraded",
  "offline",
  "needs_reinstall",
]);
const SANDBOX_TERMINAL_STATES = new Set([
  "running",
  "stopped",
  "deleted",
  "failed",
]);
const GRANT_TERMINAL_STATES = new Set(["applied", "revoked", "failed"]);
const COMMON_OPTIONS = ["base-url", "json", "state-dir", "help"];

const HELP = `WarpMetal CLI ${VERSION}

Usage:
  warpmetal health [--json]
  warpmetal catalog [--plan <planId>] [--json]
  warpmetal order prepare --plan <planId> --hostname <name> --os <exact-name>
    --ssh-public-key-file <path> [--runtime-file <path>] [--confirm TEMPORARY]
    [--email <address>] [--idempotency-key <key>]
  warpmetal order status --task <taskId> [--wait] [--timeout-seconds <n>]
  warpmetal checkout challenge --task <taskId> [--request-envelope-out <path>]
  warpmetal checkout submit --task <taskId>
    (--payment-artifact <path> | --payment-signature-file <path>)
    [--wait] [--timeout-seconds <n>]
  warpmetal server login --server <serverId> --identity <private-key-path>
  warpmetal server get --server <serverId>
  warpmetal server power --server <serverId> --action <boot|reboot|shutdown>
    --confirm <same-action> [--wait] [--idempotency-key <key>]
  warpmetal server reload --server <serverId> --confirm ERASE --power-off-first
    [--acknowledge-agent-runtime-reset] [--hostname <name>] [--os <exact-name>]
    [--ssh-public-key-file <path>] [--wait] [--idempotency-key <key>]
  warpmetal operation get --operation <operationId> [--server <serverId>] [--wait]
  warpmetal runtime enable|get --server <serverId> [--wait]
  warpmetal runtime install --server <serverId> --identity <owner-key> --ssh-user <user>
    --confirm INSTALL [--wait]
  warpmetal sandbox create --server <serverId> --name <name> --size <size>
    [--lifetime temporary] [--expires-in-seconds <n>] [--confirm TEMPORARY] [--wait]
  warpmetal sandbox create --server <serverId> --file <batch.json> [--confirm TEMPORARY]
  warpmetal sandbox list|get|action|delete ...
  warpmetal sandbox access keygen --output <private-key-path> --confirm GENERATE
  warpmetal sandbox access grant|list|get|revoke ...
  warpmetal sandbox access refresh --server <serverId> --sandbox <sandboxId>
    --grant <grantId> --connection-file <path> --confirm REFRESH [--wait]
  warpmetal sandbox connect --connection-file <path> --identity <sandbox-key> [-- <command>]
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

function shellCommand(argv) {
  return argv
    .map((value) =>
      /^[A-Za-z0-9_./:=+@-]+$/.test(value)
        ? value
        : `'${value.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

function emit(stream, value, json, human) {
  if (json) writeLine(stream, JSON.stringify(value, null, 2));
  else writeLine(stream, human);
}

function idempotencyKey(kind) {
  return `${kind}-${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${randomUUID()}`;
}

function delay(seconds) {
  return new Promise((resolveDelay) =>
    setTimeout(resolveDelay, seconds * 1_000),
  );
}

function timeoutDeadline(seconds) {
  return Date.now() + seconds * 1_000;
}

function ensureBeforeDeadline(deadline, label) {
  if (Date.now() >= deadline) {
    throw new CliError(
      `${label} did not reach a terminal state before the timeout.`,
      {
        exitCode: 8,
      },
    );
  }
}

function suggestedDelay(result, fallback = 2) {
  const retry = Number(result.headers?.["retry-after"]);
  const bodyDelay = Number(result.data?.pollAfterSeconds);
  const candidate = Number.isFinite(retry) && retry > 0 ? retry : bodyDelay;
  return Math.max(
    1,
    Math.min(
      30,
      Number.isFinite(candidate) && candidate > 0 ? candidate : fallback,
    ),
  );
}

async function readHeaderValueFile(path, label) {
  const value = (await readFile(resolve(path), "utf8")).trim();
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new CliError(
      `${label} must contain one non-empty HTTP header value.`,
      { exitCode: 2 },
    );
  }
  if (Buffer.byteLength(value) > 64 * 1024) {
    throw new CliError(`${label} is too large.`, { exitCode: 2 });
  }
  return value;
}

async function credentialFromFile(options) {
  const tokenFile = stringOption(options, "token-file");
  return tokenFile
    ? readHeaderValueFile(tokenFile, "The token file")
    : undefined;
}

async function requireTaskToken(store, taskId, options, env) {
  const token =
    (await credentialFromFile(options)) || (await store.taskToken(taskId, env));
  if (!token) {
    throw new CliError(
      `No credential is available for ${taskId}. Restore the private state file, set WARPMETAL_OWNER_TOKEN, or use --token-file.`,
      { exitCode: 4 },
    );
  }
  return token;
}

async function requireServerToken(store, serverId, options, env) {
  const token =
    (await credentialFromFile(options)) ||
    (await store.serverToken(serverId, env));
  if (!token) {
    throw new CliError(
      `No credential is available for ${serverId}. Run warpmetal server login or provide a recovery token through the environment or --token-file.`,
      { exitCode: 4 },
    );
  }
  return token;
}

async function requireReloadToken(store, serverId, options, env) {
  const token =
    (await credentialFromFile(options)) ||
    (await store.serverOwnerToken(serverId, env));
  if (!token) {
    throw new CliError(
      `Reload requires the recovery owner credential for ${serverId} so the CLI can poll after SSH-derived tokens are revoked. Restore the private state file, set WARPMETAL_OWNER_TOKEN, or use --token-file.`,
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
      const systems = product.operatingSystems
        .map((system) => `  - ${system.name}`)
        .join("\n");
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
    if (OPERATION_TERMINAL_STATES.has(result.data?.operation?.state))
      return result;
    ensureBeforeDeadline(deadline, `Operation ${operationId}`);
    await delay(suggestedDelay(result));
  }
}

async function pollRuntime(client, serverId, token, timeoutSeconds) {
  const deadline = timeoutDeadline(timeoutSeconds);
  while (true) {
    const result = await client.getRuntime(serverId, token);
    const runtime = result.data?.runtime;
    if (
      RUNTIME_TERMINAL_STATES.has(runtime?.state) &&
      (runtime.state !== "ready" ||
        runtime.desiredRevision === runtime.appliedRevision)
    ) {
      return result;
    }
    ensureBeforeDeadline(deadline, `Runtime ${serverId}`);
    await delay(suggestedDelay(result));
  }
}

async function pollSandbox(
  client,
  serverId,
  sandboxId,
  token,
  timeoutSeconds,
  predicate = undefined,
) {
  const deadline = timeoutDeadline(timeoutSeconds);
  while (true) {
    const result = await client.getSandbox(serverId, sandboxId, token);
    if (
      SANDBOX_TERMINAL_STATES.has(result.data?.sandbox?.observedState) &&
      (!predicate || predicate(result.data.sandbox))
    ) {
      return result;
    }
    ensureBeforeDeadline(deadline, `Sandbox ${sandboxId}`);
    await delay(suggestedDelay(result));
  }
}

async function pollGrant(
  client,
  serverId,
  sandboxId,
  grantId,
  token,
  timeoutSeconds,
  predicate = undefined,
) {
  const deadline = timeoutDeadline(timeoutSeconds);
  while (true) {
    const result = await client.getAccessGrant(
      serverId,
      sandboxId,
      grantId,
      token,
    );
    if (
      GRANT_TERMINAL_STATES.has(result.data?.accessGrant?.observedState) &&
      (!predicate || predicate(result.data.accessGrant))
    )
      return result;
    ensureBeforeDeadline(deadline, `Access grant ${grantId}`);
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
      response.data?.paymentAttemptId ||
      response.headers["x-warpmetal-payment-attempt"],
    paymentRequired,
    checkoutBodySha256: createHash("sha256").update(checkoutBody).digest("hex"),
  };
}

async function attachPaymentWorkflow(
  client,
  store,
  taskId,
  order,
  safe,
  requestedEnvelopePath,
) {
  if (!safe.paymentRequired) return safe;
  const request = createPaymentRequestEnvelope({
    baseUrl: client.baseUrl,
    checkoutPath: order.checkoutPath,
    checkoutBody: order.checkoutBody,
    paymentRequired: safe.paymentRequired,
    merchantReference: taskId,
  });
  const defaults = defaultPaymentPaths(
    store.directory,
    taskId,
    request.challengeDigest,
  );
  const requestEnvelopePath = await writePaymentRequestEnvelope(
    requestedEnvelopePath || defaults.requestEnvelopePath,
    request.envelope,
  );
  const workflow = paymentWorkflow({
    taskId,
    requestEnvelopePath,
    paymentArtifactPath: defaults.paymentArtifactPath,
  });
  Object.assign(safe, {
    paymentTerms: request.terms,
    paymentRequestDigest: request.requestDigest,
    paymentChallengeDigest: request.challengeDigest,
    paymentWorkflow: workflow,
  });
  await store.savePaymentChallenge(taskId, safe);
  return safe;
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
    ? {
        ...result.data,
        products: result.data.products.filter((product) => product.id === plan),
      }
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
  const publicKeyFile = stringOption(options, "ssh-public-key-file", {
    required: true,
  });
  const email = stringOption(options, "email");
  const runtimeFile = stringOption(options, "runtime-file");
  const sandboxes = runtimeFile
    ? await readSandboxFile(runtimeFile)
    : undefined;
  if (sandboxes) {
    requireTemporaryConfirmation(sandboxes, stringOption(options, "confirm"));
  }

  const health = await client.health();
  if (!health.data?.purchasingReady) {
    throw new CliError(
      "WarpMetal purchasing is not ready. No order was created.",
      {
        exitCode: 3,
        details: health.data,
      },
    );
  }
  const catalog = (await client.catalog()).data;
  const product = catalog.products.find((candidate) => candidate.id === planId);
  if (!product) {
    throw new CliError(`Unknown live WarpMetal plan: ${planId}`, {
      exitCode: 2,
    });
  }
  if (!product?.operatingSystems?.some((system) => system.name === osName)) {
    throw new CliError(
      `--os must exactly match a live free operating-system name for the ${planId} plan.`,
      { exitCode: 2 },
    );
  }
  if (sandboxes) validateRuntimeCatalog(product, osName, sandboxes);

  const sshPublicKey = await readSshPublicKey(publicKeyFile);
  const request = { planId, hostname, osName, sshPublicKey };
  if (email) request.email = email;
  if (sandboxes) request.agentRuntime = { sandboxes };
  const key =
    stringOption(options, "idempotency-key") || idempotencyKey("order");
  const response = await client.prepareOrder(request, key);
  const checkoutBody = JSON.stringify({ taskId: response.data.task.id });
  await store.savePreparedOrder(response.data, checkoutBody);
  const safe = safePreparedOrder(response.data, store.path);
  if (sandboxes) {
    safe.agentRuntimeIntent = {
      sandboxes: sandboxes.map((sandbox) => ({
        name: sandbox.name,
        size: sandbox.size,
        lifetime: sandbox.lifetime || "persistent",
        expiresInSeconds: sandbox.expiresInSeconds,
      })),
    };
  }
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
    throw new CliError(`No exact checkout state exists for ${taskId}.`, {
      exitCode: 2,
    });
  }
  const token = await requireTaskToken(store, taskId, options, context.env);
  const response = await client.checkout(order.checkoutPath, {
    bodyText: order.checkoutBody,
    token,
  });
  const safe = await attachPaymentWorkflow(
    client,
    store,
    taskId,
    order,
    challengeResult(taskId, order.checkoutBody, response),
    stringOption(options, "request-envelope-out"),
  );
  const paymentInstructions = safe.paymentWorkflow
    ? `\nWallet package: ${safe.paymentWorkflow.signerPackage.spec} (Node ${safe.paymentWorkflow.signerNodeRequirement})\nInstall: ${shellCommand(safe.paymentWorkflow.signerPackage.install.argv)}\nVerify: ${shellCommand(safe.paymentWorkflow.signerContract.probe.argv)}\nRequest envelope: ${safe.paymentWorkflow.requestEnvelopePath}\nAuthorize: ${shellCommand(safe.paymentWorkflow.authorize.argv)}\nSubmit with WarpMetal: ${shellCommand(safe.paymentWorkflow.submit.argv)}`
    : "";
  emit(
    context.stdout,
    safe,
    context.json,
    response.status === 402
      ? `Payment authorization required for ${taskId}.${paymentInstructions}`
      : `Checkout status for ${taskId}: ${safe.status}`,
  );
  return response.status === 409 ? 6 : response.status === 402 ? 7 : 0;
}

async function handleCheckoutSubmit(client, store, options, context) {
  const taskId = stringOption(options, "task", { required: true });
  const signatureFile = stringOption(options, "payment-signature-file");
  const artifactFile = stringOption(options, "payment-artifact");
  if (Boolean(signatureFile) === Boolean(artifactFile)) {
    throw new CliError(
      "Use exactly one of --payment-artifact or --payment-signature-file.",
      { exitCode: 2 },
    );
  }
  const order = await store.order(taskId);
  if (!order?.checkoutPath || !order?.checkoutBody) {
    throw new CliError(`No exact checkout state exists for ${taskId}.`, {
      exitCode: 2,
    });
  }
  let walletPayment;
  let paymentSignature;
  if (artifactFile) {
    if (!order.paymentRequired) {
      throw new CliError(
        `No saved PAYMENT-REQUIRED challenge exists for ${taskId}. Run warpmetal checkout challenge first.`,
        { exitCode: 2 },
      );
    }
    const expected = createPaymentRequestEnvelope({
      baseUrl: client.baseUrl,
      checkoutPath: order.checkoutPath,
      checkoutBody: order.checkoutBody,
      paymentRequired: order.paymentRequired,
      merchantReference: taskId,
    });
    walletPayment = await readPaymentArtifact(artifactFile, expected);
    paymentSignature = walletPayment.paymentSignature;
    await store.saveWalletPaymentAttempt(taskId, walletPayment);
  } else {
    paymentSignature = await readHeaderValueFile(
      signatureFile,
      "The payment signature file",
    );
  }
  const token = await requireTaskToken(store, taskId, options, context.env);
  const wait = booleanOption(options, "wait");
  const deadline = timeoutDeadline(
    integerOption(options, "timeout-seconds", 900),
  );

  while (true) {
    const response = await client.checkout(order.checkoutPath, {
      bodyText: order.checkoutBody,
      token,
      paymentSignature,
    });
    const safe = await attachPaymentWorkflow(
      client,
      store,
      taskId,
      order,
      challengeResult(taskId, order.checkoutBody, response),
    );
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
      ...(walletPayment
        ? {
            walletPayment: {
              attemptId: walletPayment.attemptId,
              requestDigest: walletPayment.requestDigest,
              buyerPaymentIdentifier: walletPayment.buyerPaymentIdentifier,
              wallet: walletPayment.wallet,
              payerAddress: walletPayment.payerAddress,
              artifactPath: walletPayment.path,
              expiresAt: walletPayment.expiresAt,
            },
          }
        : {}),
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

async function loginServer(client, store, serverId, identity) {
  const challenge = (await client.issueSshChallenge(serverId)).data;
  const signature = await signSshChallenge(challenge.payload, identity);
  const token = (
    await client.exchangeSshChallenge(
      serverId,
      challenge.challengeId,
      signature,
    )
  ).data;
  await store.saveAccessToken(serverId, token.accessToken, token.expiresAt);
  return { challenge, token };
}

async function handleServerLogin(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const identity = stringOption(options, "identity", { required: true });
  const { challenge, token } = await loginServer(
    client,
    store,
    serverId,
    identity,
  );
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
    throw new CliError("--action must be boot, reboot, or shutdown.", {
      exitCode: 2,
    });
  }
  if (confirmation !== action) {
    throw new CliError(`Confirm this operation with --confirm ${action}.`, {
      exitCode: 2,
    });
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const key =
    stringOption(options, "idempotency-key") ||
    idempotencyKey(`power-${action}`);
  let result = await client.powerServer(serverId, action, token, key);
  const operationId = result.data?.operation?.id;
  if (!operationId)
    throw new CliError("WarpMetal did not return an operation ID.");
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

async function applyReloadResult(store, serverId, operation) {
  if (operation?.state !== "succeeded") return;
  await store.invalidateServerAccess(serverId);
  if (operation.result?.reloadImpact?.agentRuntimeAffected) {
    await store.saveRuntime(serverId, {
      state: "needs_reinstall",
      desiredRevision: undefined,
      appliedRevision: 0,
      lastSeenAt: null,
    });
  }
}

async function handleServerReload(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  if (stringOption(options, "confirm", { required: true }) !== "ERASE") {
    throw new CliError("Confirm disk erasure with --confirm ERASE.", {
      exitCode: 2,
    });
  }
  if (!booleanOption(options, "power-off-first")) {
    throw new CliError(
      "Authorize the guarded shutdown with --power-off-first.",
      { exitCode: 2 },
    );
  }
  const acknowledgeRuntimeReset = booleanOption(
    options,
    "acknowledge-agent-runtime-reset",
  );
  const token = await requireReloadToken(store, serverId, options, context.env);
  const server = (await client.getServer(serverId, token)).data?.task;
  if (server?.agentRuntime && !acknowledgeRuntimeReset) {
    throw new CliError(
      "Agent Runtime is enabled. Reload permanently erases sandbox workspaces, revokes supervisor identity, and requires connection-profile refresh. Confirm with --acknowledge-agent-runtime-reset.",
      { exitCode: 2 },
    );
  }

  const body = {
    confirm: "ERASE",
    powerOffFirst: true,
  };
  if (acknowledgeRuntimeReset) body.acknowledgeAgentRuntimeReset = true;
  const hostname = stringOption(options, "hostname");
  const osName = stringOption(options, "os");
  const publicKeyFile = stringOption(options, "ssh-public-key-file");
  if (hostname) body.hostname = hostname;
  if (osName) body.osName = osName;
  if (publicKeyFile) body.sshPublicKey = await readSshPublicKey(publicKeyFile);

  const key =
    stringOption(options, "idempotency-key") || idempotencyKey("reload");
  let result = await client.reloadServer(serverId, body, token, key);
  const operationId = result.data?.operation?.id;
  if (!operationId) {
    throw new CliError("WarpMetal did not return a reload operation ID.");
  }
  await store.saveOperation(operationId, serverId, "reload");
  if (booleanOption(options, "wait")) {
    result = await pollOperation(
      client,
      operationId,
      token,
      integerOption(options, "timeout-seconds", 900),
    );
  }

  const operation = result.data?.operation;
  await applyReloadResult(store, serverId, operation);
  emit(
    context.stdout,
    result.data,
    context.json,
    `Reload operation ${operationId}: ${operation?.state}.` +
      (operation?.state === "succeeded" &&
      operation.result?.reloadImpact?.agentRuntimeAffected
        ? " Verify and refresh the owner SSH host key, reinstall Agent Runtime, then refresh every sandbox connection profile."
        : operation?.state === "succeeded"
          ? " Verify and refresh the owner SSH host key before reconnecting."
          : ""),
  );
  if (operation?.state === "manual_review") return 6;
  if (operation?.state === "failed") return 5;
  return operation?.state === "succeeded" ? 0 : 8;
}

async function handleOperationGet(client, store, options, context) {
  const operationId = stringOption(options, "operation", { required: true });
  const saved = await store.operation(operationId);
  const serverId = stringOption(options, "server") || saved?.serverId;
  if (!serverId) {
    throw new CliError(
      "--server is required when the operation is not present in local state.",
      {
        exitCode: 2,
      },
    );
  }
  const token =
    saved?.kind === "reload"
      ? await requireReloadToken(store, serverId, options, context.env)
      : await requireServerToken(store, serverId, options, context.env);
  const result = booleanOption(options, "wait")
    ? await pollOperation(
        client,
        operationId,
        token,
        integerOption(options, "timeout-seconds", 900),
      )
    : await client.getOperation(operationId, token);
  if (saved?.kind === "reload") {
    await applyReloadResult(store, serverId, result.data?.operation);
  }
  emit(
    context.stdout,
    result.data,
    context.json,
    `${operationId}: ${result.data.operation.state}`,
  );
  return result.data.operation.state === "manual_review" ? 6 : 0;
}

async function handleRuntimeEnable(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const key =
    stringOption(options, "idempotency-key") ||
    idempotencyKey("runtime-enable");
  const result = await client.enableRuntime(serverId, token, key);
  await store.saveRuntime(serverId, result.data.runtime);
  emit(
    context.stdout,
    result.data,
    context.json,
    `Runtime ${serverId}: ${result.data.runtime.state}. Next: ${result.data.runtime.nextAction || "reconcile"}.`,
  );
  return result.data.runtime.state === "ready" ? 0 : 8;
}

async function handleRuntimeGet(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = booleanOption(options, "wait")
    ? await pollRuntime(
        client,
        serverId,
        token,
        integerOption(options, "timeout-seconds", 900),
      )
    : await client.getRuntime(serverId, token);
  await store.saveRuntime(serverId, result.data.runtime);
  emit(
    context.stdout,
    result.data,
    context.json,
    `Runtime ${serverId}: ${result.data.runtime.state} (${result.data.runtime.appliedRevision}/${result.data.runtime.desiredRevision}).`,
  );
  return result.data.runtime.state === "degraded" ? 5 : 0;
}

async function handleRuntimeInstall(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const identity = stringOption(options, "identity", { required: true });
  const sshUser = stringOption(options, "ssh-user", { required: true });
  if (stringOption(options, "confirm", { required: true }) !== "INSTALL") {
    throw new CliError(
      "Confirm supervisor installation with --confirm INSTALL.",
      { exitCode: 2 },
    );
  }
  const { token: issued } = await loginServer(
    client,
    store,
    serverId,
    identity,
  );
  const key =
    stringOption(options, "idempotency-key") ||
    idempotencyKey("runtime-bootstrap");
  const bootstrap = await client.bootstrapRuntime(
    serverId,
    issued.accessToken,
    key,
  );
  const safe = await installRuntime({
    client,
    serverId,
    token: issued.accessToken,
    identity,
    sshUser,
    bootstrap: bootstrap.data,
    fetchImpl: context.fetchImpl,
    spawnImpl: context.spawnImpl,
  });
  let runtimeResult;
  if (booleanOption(options, "wait")) {
    runtimeResult = await pollRuntime(
      client,
      serverId,
      issued.accessToken,
      integerOption(options, "timeout-seconds", 900),
    );
    safe.runtime = runtimeResult.data.runtime;
    await store.saveRuntime(serverId, runtimeResult.data.runtime);
  }
  emit(
    context.stdout,
    safe,
    context.json,
    `Installed Agent Runtime ${safe.supervisorVersion} on ${serverId}${safe.runtime ? `: ${safe.runtime.state}` : "."}`,
  );
  return safe.runtime?.state === "degraded" ? 5 : 0;
}

async function resolveCreateSandboxes(options) {
  const file = stringOption(options, "file");
  const hasSingle = options.name !== undefined || options.size !== undefined;
  if (file && hasSingle) {
    throw new CliError("Use either --file or --name/--size, not both.", {
      exitCode: 2,
    });
  }
  if (file) return readSandboxFile(file);
  return sandboxFromOptions({
    name: stringOption(options, "name", { required: true }),
    size: stringOption(options, "size", { required: true }),
    lifetime: stringOption(options, "lifetime"),
    expiresInSeconds: integerOption(options, "expires-in-seconds", undefined),
  });
}

async function handleSandboxCreate(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxes = await resolveCreateSandboxes(options);
  requireTemporaryConfirmation(sandboxes, stringOption(options, "confirm"));
  const token = await requireServerToken(store, serverId, options, context.env);
  const server = (await client.getServer(serverId, token)).data?.task;
  const catalog = (await client.catalog()).data;
  const product = catalog.products.find(
    (candidate) => candidate.id === server?.planId,
  );
  validateRuntimeCatalog(product, server?.osName, sandboxes);
  const key =
    stringOption(options, "idempotency-key") ||
    idempotencyKey("sandbox-create");
  let result = await client.createSandboxes(serverId, sandboxes, token, key);
  await store.saveRuntime(serverId, result.data.runtime);
  await store.saveSandboxes(serverId, result.data.sandboxes);
  if (booleanOption(options, "wait")) {
    const timeout = integerOption(options, "timeout-seconds", 900);
    const settled = [];
    for (const sandbox of result.data.sandboxes) {
      const polled = await pollSandbox(
        client,
        serverId,
        sandbox.id,
        token,
        timeout,
      );
      settled.push(polled.data.sandbox);
    }
    result = { ...result, data: { ...result.data, sandboxes: settled } };
    await store.saveSandboxes(serverId, settled);
  }
  const pending = result.data.sandboxes.some(
    (sandbox) => !SANDBOX_TERMINAL_STATES.has(sandbox.observedState),
  );
  const failed = result.data.sandboxes.some(
    (sandbox) => sandbox.observedState === "failed",
  );
  emit(
    context.stdout,
    result.data,
    context.json,
    `Sandboxes accepted on ${serverId}: ${result.data.sandboxes.map((item) => `${item.name}=${item.observedState}`).join(", ")}`,
  );
  return failed ? 5 : pending ? 8 : 0;
}

async function handleSandboxList(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = await client.listSandboxes(serverId, token);
  await store.saveRuntime(serverId, result.data.runtime);
  await store.saveSandboxes(serverId, result.data.sandboxes);
  emit(
    context.stdout,
    result.data,
    context.json,
    result.data.sandboxes
      .map((item) => `${item.id} ${item.name} ${item.observedState}`)
      .join("\n"),
  );
  return 0;
}

async function handleSandboxGet(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = booleanOption(options, "wait")
    ? await pollSandbox(
        client,
        serverId,
        sandboxId,
        token,
        integerOption(options, "timeout-seconds", 900),
      )
    : await client.getSandbox(serverId, sandboxId, token);
  await store.saveSandboxes(serverId, [result.data.sandbox]);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${sandboxId}: ${result.data.sandbox.observedState}`,
  );
  return result.data.sandbox.observedState === "failed" ? 5 : 0;
}

async function handleSandboxAction(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const action = stringOption(options, "action", { required: true });
  if (!["start", "stop", "restart", "make_persistent"].includes(action)) {
    throw new CliError(
      "--action must be start, stop, restart, or make_persistent.",
      {
        exitCode: 2,
      },
    );
  }
  if (stringOption(options, "confirm", { required: true }) !== action) {
    throw new CliError(`Confirm this operation with --confirm ${action}.`, {
      exitCode: 2,
    });
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const key =
    stringOption(options, "idempotency-key") ||
    idempotencyKey(`sandbox-${action}`);
  let result = await client.sandboxAction(
    serverId,
    sandboxId,
    action,
    token,
    key,
  );
  if (booleanOption(options, "wait")) {
    const accepted = result.data.sandbox;
    const expectedState =
      accepted.desiredState === "stopped" ? "stopped" : "running";
    result = await pollSandbox(
      client,
      serverId,
      sandboxId,
      token,
      integerOption(options, "timeout-seconds", 900),
      (sandbox) =>
        sandbox.observedState === expectedState &&
        Number(sandbox.observedGeneration) >= Number(accepted.generation),
    );
  }
  await store.saveSandboxes(serverId, [result.data.sandbox]);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${sandboxId}: ${action} -> ${result.data.sandbox.observedState}`,
  );
  return SANDBOX_TERMINAL_STATES.has(result.data.sandbox.observedState) ? 0 : 8;
}

async function handleSandboxDelete(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  if (stringOption(options, "confirm", { required: true }) !== "DELETE") {
    throw new CliError(
      "Sandbox deletion permanently removes the workspace. Use --confirm DELETE.",
      {
        exitCode: 2,
      },
    );
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const key =
    stringOption(options, "idempotency-key") ||
    idempotencyKey("sandbox-delete");
  let result = await client.deleteSandbox(serverId, sandboxId, token, key);
  if (booleanOption(options, "wait")) {
    result = await pollSandbox(
      client,
      serverId,
      sandboxId,
      token,
      integerOption(options, "timeout-seconds", 900),
      (sandbox) => sandbox.observedState === "deleted",
    );
  }
  await store.saveSandboxes(serverId, [result.data.sandbox]);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${sandboxId}: deletion ${result.data.sandbox.observedState}`,
  );
  return result.data.sandbox.observedState === "deleted" ? 0 : 8;
}

async function handleAccessKeygen(options, context) {
  if (stringOption(options, "confirm", { required: true }) !== "GENERATE") {
    throw new CliError("Confirm SSH key generation with --confirm GENERATE.", {
      exitCode: 2,
    });
  }
  const result = await generateSandboxKey(
    stringOption(options, "output", { required: true }),
    {
      spawn: context.spawnSyncImpl,
    },
  );
  emit(
    context.stdout,
    result,
    context.json,
    `Generated ${result.keyType} sandbox key at ${result.privateKeyPath}; fingerprint ${result.sshFingerprint}.`,
  );
  return 0;
}

async function handleAccessGrant(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const name = stringOption(options, "name", { required: true });
  const publicKey = await readSshPublicKey(
    stringOption(options, "ssh-public-key-file", { required: true }),
  );
  const connectionFile = stringOption(options, "connection-file");
  const wait = booleanOption(options, "wait");
  if (connectionFile && !wait) {
    throw new CliError(
      "--connection-file requires --wait for applied keys and pinned host keys.",
      {
        exitCode: 2,
      },
    );
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const key =
    stringOption(options, "idempotency-key") || idempotencyKey("access-grant");
  let result = await client.createAccessGrant(
    serverId,
    sandboxId,
    { name, sshPublicKey: publicKey },
    token,
    key,
  );
  const grantId = result.data?.accessGrant?.id;
  if (wait) {
    result = await pollGrant(
      client,
      serverId,
      sandboxId,
      grantId,
      token,
      integerOption(options, "timeout-seconds", 900),
      (accessGrant) => accessGrant.observedState === "applied",
    );
  }
  let writtenConnectionFile;
  if (connectionFile) {
    if (result.data.accessGrant.observedState !== "applied") {
      throw new CliError("The access grant did not become applied.", {
        exitCode: 8,
      });
    }
    const profile = connectionProfile(
      serverId,
      sandboxId,
      grantId,
      result.data.connection,
    );
    writtenConnectionFile = await writeConnectionProfile(
      connectionFile,
      profile,
    );
  }
  await store.saveAccessGrant(
    serverId,
    result.data.accessGrant,
    writtenConnectionFile,
  );
  const safe = {
    accessGrant: result.data.accessGrant,
    connection: writtenConnectionFile
      ? { available: true, profileWritten: true, printed: false }
      : result.data.connection,
    connectionFile: writtenConnectionFile,
  };
  emit(
    context.stdout,
    safe,
    context.json,
    `Access grant ${grantId}: ${result.data.accessGrant.observedState}${writtenConnectionFile ? `; profile saved to ${writtenConnectionFile}` : ""}.`,
  );
  return result.data.accessGrant.observedState === "applied" ? 0 : 8;
}

async function handleAccessList(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = await client.listAccessGrants(serverId, sandboxId, token);
  for (const item of result.data.accessGrants) {
    await store.saveAccessGrant(serverId, item.accessGrant);
  }
  emit(
    context.stdout,
    result.data,
    context.json,
    result.data.accessGrants
      .map(
        (item) =>
          `${item.accessGrant.id} ${item.accessGrant.name} ${item.accessGrant.observedState}`,
      )
      .join("\n"),
  );
  return 0;
}

async function handleAccessGet(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const grantId = stringOption(options, "grant", { required: true });
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = booleanOption(options, "wait")
    ? await pollGrant(
        client,
        serverId,
        sandboxId,
        grantId,
        token,
        integerOption(options, "timeout-seconds", 900),
      )
    : await client.getAccessGrant(serverId, sandboxId, grantId, token);
  await store.saveAccessGrant(serverId, result.data.accessGrant);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${grantId}: ${result.data.accessGrant.observedState}`,
  );
  return result.data.accessGrant.observedState === "failed" ? 5 : 0;
}

async function handleAccessRefresh(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const grantId = stringOption(options, "grant", { required: true });
  const profilePath = stringOption(options, "connection-file", {
    required: true,
  });
  if (stringOption(options, "confirm", { required: true }) !== "REFRESH") {
    throw new CliError(
      "Confirm replacement of the pinned connection profile with --confirm REFRESH.",
      { exitCode: 2 },
    );
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const result = booleanOption(options, "wait")
    ? await pollGrant(
        client,
        serverId,
        sandboxId,
        grantId,
        token,
        integerOption(options, "timeout-seconds", 900),
        (accessGrant) => accessGrant.observedState === "applied",
      )
    : await client.getAccessGrant(serverId, sandboxId, grantId, token);
  if (result.data?.accessGrant?.observedState !== "applied") {
    emit(
      context.stdout,
      { accessGrant: result.data?.accessGrant, connectionFile: null },
      context.json,
      `Access grant ${grantId} is not applied; no profile was changed.`,
    );
    return result.data?.accessGrant?.observedState === "failed" ? 5 : 8;
  }
  const profile = connectionProfile(
    serverId,
    sandboxId,
    grantId,
    result.data.connection,
  );
  const writtenConnectionFile = await writeConnectionProfile(
    profilePath,
    profile,
  );
  await store.saveAccessGrant(
    serverId,
    result.data.accessGrant,
    writtenConnectionFile,
  );
  const safe = {
    accessGrant: result.data.accessGrant,
    connection: { available: true, profileWritten: true, printed: false },
    connectionFile: writtenConnectionFile,
  };
  emit(
    context.stdout,
    safe,
    context.json,
    `Refreshed pinned connection profile for ${grantId} at ${writtenConnectionFile}.`,
  );
  return 0;
}

async function handleAccessRevoke(client, store, options, context) {
  const serverId = stringOption(options, "server", { required: true });
  const sandboxId = stringOption(options, "sandbox", { required: true });
  const grantId = stringOption(options, "grant", { required: true });
  if (stringOption(options, "confirm", { required: true }) !== "REVOKE") {
    throw new CliError("Confirm access revocation with --confirm REVOKE.", {
      exitCode: 2,
    });
  }
  const token = await requireServerToken(store, serverId, options, context.env);
  const key =
    stringOption(options, "idempotency-key") || idempotencyKey("access-revoke");
  let result = await client.revokeAccessGrant(
    serverId,
    sandboxId,
    grantId,
    token,
    key,
  );
  if (booleanOption(options, "wait")) {
    result = await pollGrant(
      client,
      serverId,
      sandboxId,
      grantId,
      token,
      integerOption(options, "timeout-seconds", 900),
      (accessGrant) => accessGrant.observedState === "revoked",
    );
  }
  await store.saveAccessGrant(serverId, result.data.accessGrant);
  emit(
    context.stdout,
    result.data,
    context.json,
    `${grantId}: revocation ${result.data.accessGrant.observedState}`,
  );
  return result.data.accessGrant.observedState === "revoked" ? 0 : 8;
}

async function handleSandboxConnect(options, passthrough, context) {
  if (context.json) {
    throw new CliError(
      "sandbox connect is a direct SSH transport and does not use --json.",
      {
        exitCode: 2,
      },
    );
  }
  return connectSandbox(
    stringOption(options, "connection-file", { required: true }),
    stringOption(options, "identity", { required: true }),
    passthrough,
    { spawn: context.spawnSyncImpl },
  );
}

async function dispatch(positionals, options, passthrough, context) {
  const command = positionals.join(" ");
  if (passthrough.length > 0 && command !== "sandbox connect") {
    throw new CliError(
      "Tokens after -- are supported only by sandbox connect.",
      { exitCode: 2 },
    );
  }
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
    rejectUnknownOptions(options, [
      ...COMMON_OPTIONS,
      "target",
      "scope",
      "force",
    ]);
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
      installed
        .map(
          (entry) =>
            `Installed WarpMetal skill for ${entry.target}: ${entry.path}`,
        )
        .join("\n"),
    );
    return 0;
  }

  const baseUrl = stringOption(options, "base-url");
  const stateDir =
    stringOption(options, "state-dir") ||
    resolveStateDirectory({ env: context.env });
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
        "runtime-file",
        "confirm",
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
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "task",
        "token-file",
        "request-envelope-out",
      ]);
      return handleCheckoutChallenge(client, store, options, context);
    case "checkout submit":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "task",
        "token-file",
        "payment-artifact",
        "payment-signature-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleCheckoutSubmit(client, store, options, context);
    case "server login":
      rejectUnknownOptions(options, [...COMMON_OPTIONS, "server", "identity"]);
      return handleServerLogin(client, store, options, context);
    case "server get":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
      ]);
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
    case "server reload":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
        "confirm",
        "power-off-first",
        "acknowledge-agent-runtime-reset",
        "hostname",
        "os",
        "ssh-public-key-file",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleServerReload(client, store, options, context);
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
    case "runtime enable":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
        "idempotency-key",
      ]);
      return handleRuntimeEnable(client, store, options, context);
    case "runtime get":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleRuntimeGet(client, store, options, context);
    case "runtime install":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "identity",
        "ssh-user",
        "confirm",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleRuntimeInstall(client, store, options, context);
    case "sandbox create":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
        "name",
        "size",
        "lifetime",
        "expires-in-seconds",
        "file",
        "confirm",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleSandboxCreate(client, store, options, context);
    case "sandbox list":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "token-file",
      ]);
      return handleSandboxList(client, store, options, context);
    case "sandbox get":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "token-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleSandboxGet(client, store, options, context);
    case "sandbox action":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "token-file",
        "action",
        "confirm",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleSandboxAction(client, store, options, context);
    case "sandbox delete":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "token-file",
        "confirm",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleSandboxDelete(client, store, options, context);
    case "sandbox access keygen":
      rejectUnknownOptions(options, [...COMMON_OPTIONS, "output", "confirm"]);
      return handleAccessKeygen(options, context);
    case "sandbox access grant":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "token-file",
        "name",
        "ssh-public-key-file",
        "connection-file",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleAccessGrant(client, store, options, context);
    case "sandbox access list":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "token-file",
      ]);
      return handleAccessList(client, store, options, context);
    case "sandbox access get":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "grant",
        "token-file",
        "wait",
        "timeout-seconds",
      ]);
      return handleAccessGet(client, store, options, context);
    case "sandbox access refresh":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "grant",
        "token-file",
        "connection-file",
        "confirm",
        "wait",
        "timeout-seconds",
      ]);
      return handleAccessRefresh(client, store, options, context);
    case "sandbox access revoke":
      rejectUnknownOptions(options, [
        ...COMMON_OPTIONS,
        "server",
        "sandbox",
        "grant",
        "token-file",
        "confirm",
        "idempotency-key",
        "wait",
        "timeout-seconds",
      ]);
      return handleAccessRevoke(client, store, options, context);
    case "sandbox connect":
      rejectUnknownOptions(options, ["connection-file", "identity", "help"]);
      return handleSandboxConnect(options, passthrough, context);
    case "state list": {
      rejectUnknownOptions(options, COMMON_OPTIONS);
      const summary = await store.summary();
      emit(
        context.stdout,
        summary,
        context.json,
        `State: ${summary.stateFile}\nOrders: ${summary.orders.length}\nServers: ${summary.servers.length}\nOperations: ${summary.operations.length}\nRuntimes: ${summary.runtimes.length}\nSandboxes: ${summary.sandboxes.length}\nAccess grants: ${summary.accessGrants.length}`,
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
    spawnImpl = undefined,
    spawnSyncImpl = undefined,
  } = {},
) {
  if (argv.length === 1 && argv[0] === "--version") {
    writeLine(stdout, VERSION);
    return 0;
  }
  const separator = argv.indexOf("--");
  const controlArguments = separator === -1 ? argv : argv.slice(0, separator);
  const json = controlArguments.includes("--json");
  try {
    const { positionals, options, passthrough } = parseArguments(argv);
    return await dispatch(positionals, options, passthrough, {
      stdout,
      stderr,
      env,
      cwd,
      fetchImpl,
      spawnImpl,
      spawnSyncImpl,
      json,
    });
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
            retryAfterSeconds: error?.retryAfter
              ? Number(error.retryAfter)
              : undefined,
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
