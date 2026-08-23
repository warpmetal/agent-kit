import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CliError } from "./errors.js";

const STATE_VERSION = 3;

function emptyState() {
  return {
    version: STATE_VERSION,
    orders: {},
    servers: {},
    operations: {},
    runtimes: {},
    sandboxes: {},
    accessGrants: {},
    identities: {},
    renewals: {},
  };
}

export function resolveStateDirectory({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env.WARPMETAL_HOME) return resolve(env.WARPMETAL_HOME);
  if (platform === "win32" && env.APPDATA)
    return join(env.APPDATA, "WarpMetal");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "warpmetal");
  return join(homedir(), ".config", "warpmetal");
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function atomicWriteJson(path, value) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function migrateState(value) {
  if (
    value?.version === 1 &&
    value.orders &&
    value.servers &&
    value.operations
  ) {
    return {
      ...value,
      version: STATE_VERSION,
      runtimes: {},
      sandboxes: {},
      accessGrants: {},
      identities: {},
      renewals: {},
    };
  }
  if (
    value?.version === 2 &&
    value.orders &&
    value.servers &&
    value.operations &&
    value.runtimes &&
    value.sandboxes &&
    value.accessGrants
  ) {
    return {
      ...value,
      version: STATE_VERSION,
      identities: {},
      renewals: {},
    };
  }
  return value;
}

function validateState(input) {
  const value = migrateState(input);
  if (!value || value.version !== STATE_VERSION) {
    throw new CliError("Unsupported or corrupt WarpMetal state file.", {
      exitCode: 2,
    });
  }
  if (
    !value.orders ||
    !value.servers ||
    !value.operations ||
    !value.runtimes ||
    !value.sandboxes ||
    !value.accessGrants ||
    !value.identities ||
    !value.renewals
  ) {
    throw new CliError("Incomplete WarpMetal state file.", { exitCode: 2 });
  }
  return value;
}

export class StateStore {
  constructor(directory = resolveStateDirectory()) {
    this.directory = isAbsolute(directory) ? directory : resolve(directory);
    this.path = join(this.directory, "state.json");
  }

  async read() {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      const state = validateState(raw);
      if (raw.version !== STATE_VERSION) await this.write(state);
      return state;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      if (error instanceof SyntaxError) {
        throw new CliError(`WarpMetal state is not valid JSON: ${this.path}`, {
          exitCode: 2,
        });
      }
      throw error;
    }
  }

  async write(state) {
    await atomicWriteJson(this.path, validateState(state));
  }

  async update(mutator) {
    const state = await this.read();
    const result = await mutator(state);
    await this.write(state);
    return result;
  }

  async savePreparedOrder(response, checkoutBody, identityId) {
    const { task, ownerToken } = response;
    if (!task?.id || !task?.serverId || !ownerToken) {
      throw new CliError("WarpMetal returned an incomplete prepared order.");
    }
    await this.update((state) => {
      state.orders[task.id] = {
        taskId: task.id,
        serverId: task.serverId,
        planId: task.planId,
        checkoutPath: task.checkoutPath,
        checkoutBody,
        ownerToken,
        identityId,
        createdAt: new Date().toISOString(),
      };
      state.servers[task.serverId] = {
        ...(state.servers[task.serverId] || {}),
        serverId: task.serverId,
        taskId: task.id,
        ownerToken,
        identityId,
      };
      if (identityId && state.identities[identityId]) {
        state.identities[identityId].taskId = task.id;
        state.identities[identityId].serverId = task.serverId;
        state.identities[identityId].boundAt = new Date().toISOString();
      }
    });
  }

  async saveIdentity(identity) {
    if (!identity?.identityId || !identity?.keyName || !identity?.publicKeyPath) {
      throw new CliError("The SSH identity record is incomplete.", { exitCode: 2 });
    }
    await this.update((state) => {
      state.identities[identity.identityId] = {
        ...identity,
        createdAt: identity.createdAt || new Date().toISOString(),
      };
    });
    return identity;
  }

  async bindIdentity(identityId, taskId, serverId) {
    await this.update((state) => {
      const identity = state.identities[identityId];
      if (!identity) {
        throw new CliError(`No local SSH identity exists for ${identityId}.`, {
          exitCode: 2,
        });
      }
      if (taskId) identity.taskId = taskId;
      identity.serverId = serverId;
      identity.boundAt = new Date().toISOString();
      const server = state.servers[serverId] || { serverId };
      server.identityId = identityId;
      state.servers[serverId] = server;
    });
  }

  async identity(identityId) {
    return (await this.read()).identities[identityId];
  }

  async identityForServer(serverId) {
    const state = await this.read();
    const identityId = state.servers[serverId]?.identityId;
    if (identityId && state.identities[identityId]) {
      return state.identities[identityId];
    }
    return Object.values(state.identities).find(
      (identity) => identity.serverId === serverId,
    );
  }

  async saveRenewalPolicy(serverId, policy, wallet, refillTargetAtomic) {
    await this.update((state) => {
      state.renewals[serverId] = {
        ...(state.renewals[serverId] || {}),
        serverId,
        policy,
        wallet,
        refillTargetAtomic,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async saveRenewalChallenge(serverId, challenge) {
    await this.update((state) => {
      const renewal = state.renewals[serverId] || { serverId };
      Object.assign(renewal, challenge, {
        challengeSavedAt: new Date().toISOString(),
      });
      state.renewals[serverId] = renewal;
    });
  }

  async saveRenewalPaymentAttempt(serverId, payment) {
    await this.update((state) => {
      const renewal = state.renewals[serverId];
      if (!renewal) {
        throw new CliError(`No local renewal state exists for ${serverId}.`, {
          exitCode: 2,
        });
      }
      if (
        renewal.paymentRequestDigest &&
        renewal.paymentRequestDigest !== payment.requestDigest
      ) {
        throw new CliError(
          `The wallet payment attempt does not match the saved renewal for ${serverId}.`,
          { exitCode: 2 },
        );
      }
      Object.assign(renewal, {
        walletPaymentAttemptId: payment.attemptId,
        walletBuyerPaymentIdentifier: payment.buyerPaymentIdentifier,
        walletName: payment.wallet,
        walletPayerAddress: payment.payerAddress,
        paymentArtifactPath: payment.path,
        paymentArtifactExpiresAt: payment.expiresAt,
        paymentArtifactSavedAt: new Date().toISOString(),
      });
    });
  }

  async renewal(serverId) {
    return (await this.read()).renewals[serverId];
  }

  async savePaymentChallenge(
    taskId,
    {
      paymentRequired,
      paymentAttemptId,
      paymentRequestDigest,
      paymentChallengeDigest,
      paymentWorkflow,
    },
  ) {
    await this.update((state) => {
      const order = state.orders[taskId];
      if (!order)
        throw new CliError(`No local order state exists for ${taskId}.`, {
          exitCode: 2,
        });
      order.paymentRequired = paymentRequired;
      order.paymentAttemptId = paymentAttemptId;
      order.paymentRequestDigest = paymentRequestDigest;
      order.paymentChallengeDigest = paymentChallengeDigest;
      order.paymentRequestEnvelopePath = paymentWorkflow?.requestEnvelopePath;
      order.paymentArtifactPath = paymentWorkflow?.paymentArtifactPath;
      order.paymentChallengeSavedAt = new Date().toISOString();
    });
  }

  async saveWalletPaymentAttempt(
    taskId,
    {
      attemptId,
      requestDigest,
      buyerPaymentIdentifier,
      wallet,
      payerAddress,
      path,
      expiresAt,
    },
  ) {
    await this.update((state) => {
      const order = state.orders[taskId];
      if (!order)
        throw new CliError(`No local order state exists for ${taskId}.`, {
          exitCode: 2,
        });
      if (
        order.paymentRequestDigest &&
        order.paymentRequestDigest !== requestDigest
      ) {
        throw new CliError(
          `The wallet payment attempt does not match the saved challenge for ${taskId}.`,
          { exitCode: 2 },
        );
      }
      order.walletPaymentAttemptId = attemptId;
      order.walletBuyerPaymentIdentifier = buyerPaymentIdentifier;
      order.walletName = wallet;
      order.walletPayerAddress = payerAddress;
      order.paymentArtifactPath = path;
      order.paymentArtifactExpiresAt = expiresAt;
      order.paymentArtifactSavedAt = new Date().toISOString();
    });
  }

  async saveAccessToken(serverId, accessToken, expiresAt) {
    await this.update((state) => {
      const server = state.servers[serverId] || { serverId };
      server.accessToken = accessToken;
      server.accessTokenExpiresAt = expiresAt;
      state.servers[serverId] = server;
    });
  }

  async saveOperation(operationId, serverId, kind, metadata = {}) {
    await this.update((state) => {
      state.operations[operationId] = {
        operationId,
        serverId,
        kind,
        ...metadata,
        createdAt: new Date().toISOString(),
      };
    });
  }

  async saveRuntime(serverId, runtime) {
    if (!runtime?.state) return;
    await this.update((state) => {
      state.runtimes[serverId] = {
        serverId,
        state: runtime.state,
        desiredRevision: runtime.desiredRevision,
        appliedRevision: runtime.appliedRevision,
        lastSeenAt: runtime.lastSeenAt,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async saveSandboxes(serverId, sandboxes) {
    if (!Array.isArray(sandboxes)) return;
    await this.update((state) => {
      for (const sandbox of sandboxes) {
        if (!sandbox?.id) continue;
        state.sandboxes[sandbox.id] = {
          serverId,
          sandboxId: sandbox.id,
          name: sandbox.name,
          size: sandbox.size,
          lifetime: sandbox.lifetime,
          expiresAt: sandbox.expiresAt,
          desiredState: sandbox.desiredState,
          observedState: sandbox.observedState,
          updatedAt: new Date().toISOString(),
        };
      }
    });
  }

  async saveAccessGrant(serverId, accessGrant, connectionFile) {
    if (!accessGrant?.id) return;
    await this.update((state) => {
      state.accessGrants[accessGrant.id] = {
        serverId,
        sandboxId: accessGrant.sandboxId,
        grantId: accessGrant.id,
        name: accessGrant.name,
        sshFingerprint: accessGrant.sshFingerprint,
        desiredState: accessGrant.desiredState,
        observedState: accessGrant.observedState,
        connectionFile,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async order(taskId) {
    return (await this.read()).orders[taskId];
  }

  async server(serverId) {
    return (await this.read()).servers[serverId];
  }

  async operation(operationId) {
    return (await this.read()).operations[operationId];
  }

  async taskToken(taskId, env = process.env) {
    if (env.WARPMETAL_OWNER_TOKEN) return env.WARPMETAL_OWNER_TOKEN;
    return (await this.order(taskId))?.ownerToken;
  }

  async serverToken(serverId, env = process.env) {
    if (env.WARPMETAL_ACCESS_TOKEN) return env.WARPMETAL_ACCESS_TOKEN;
    if (env.WARPMETAL_OWNER_TOKEN) return env.WARPMETAL_OWNER_TOKEN;
    const server = await this.server(serverId);
    if (!server) return undefined;
    if (
      server.accessToken &&
      server.accessTokenExpiresAt &&
      Date.parse(server.accessTokenExpiresAt) > Date.now() + 5_000
    ) {
      return server.accessToken;
    }
    return server.ownerToken;
  }

  async serverOwnerToken(serverId, env = process.env) {
    if (env.WARPMETAL_OWNER_TOKEN) return env.WARPMETAL_OWNER_TOKEN;
    return (await this.server(serverId))?.ownerToken;
  }

  async invalidateServerAccess(serverId) {
    await this.update((state) => {
      const server = state.servers[serverId];
      if (!server) return;
      delete server.accessToken;
      delete server.accessTokenExpiresAt;
    });
  }

  async summary() {
    const state = await this.read();
    return {
      stateFile: this.path,
      orders: Object.values(state.orders).map((order) => ({
        taskId: order.taskId,
        serverId: order.serverId,
        planId: order.planId,
        paymentAttemptId: order.paymentAttemptId,
        walletPaymentAttemptId: order.walletPaymentAttemptId,
        walletName: order.walletName,
        payerAddress: order.walletPayerAddress,
        paymentArtifactExpiresAt: order.paymentArtifactExpiresAt,
        credentialStored: Boolean(order.ownerToken),
      })),
      servers: Object.values(state.servers).map((server) => ({
        serverId: server.serverId,
        taskId: server.taskId,
        recoveryCredentialStored: Boolean(server.ownerToken),
        accessTokenExpiresAt: server.accessTokenExpiresAt,
      })),
      operations: Object.values(state.operations),
      runtimes: Object.values(state.runtimes),
      sandboxes: Object.values(state.sandboxes),
      accessGrants: Object.values(state.accessGrants),
      identities: Object.values(state.identities).map((identity) => ({
        identityId: identity.identityId,
        keyName: identity.keyName,
        hostnameAtCreation: identity.hostnameAtCreation,
        publicKeyPath: identity.publicKeyPath,
        privateKeyPath: identity.privateKeyPath,
        sshFingerprint: identity.sshFingerprint,
        serverId: identity.serverId,
        taskId: identity.taskId,
        createdAt: identity.createdAt,
        boundAt: identity.boundAt,
      })),
      renewals: Object.values(state.renewals).map((renewal) => ({
        serverId: renewal.serverId,
        wallet: renewal.wallet,
        refillTargetAtomic: renewal.refillTargetAtomic,
        policy: renewal.policy,
        paymentAttemptId: renewal.paymentAttemptId,
        paymentArtifactExpiresAt: renewal.paymentArtifactExpiresAt,
      })),
    };
  }

  async permissions() {
    try {
      const info = await stat(this.path);
      return info.mode & 0o777;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }
}
