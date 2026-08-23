import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CliError } from "./errors.js";

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PAYMENT_IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const CAIP2_NETWORK = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MAX_CHALLENGE_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 512 * 1024;

export const AGENT_WALLET_PACKAGE = "@x402api/agent-wallet-cli";
export const AGENT_WALLET_VERSION = "0.2.1";
const AGENT_WALLET_SPEC = `${AGENT_WALLET_PACKAGE}@${AGENT_WALLET_VERSION}`;
const GAS_SPONSORSHIP_EXTENSION = "com.x402api.gas-sponsorship";
const BASE_NETWORK = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SPONSORED_PROFILE =
  "com.x402api.x402.base-usdc-eip3009-sponsored.v1";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOLANA_SPONSORED_PROFILE = "com.x402api.x402.solana-sponsored.v1";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_MEMO =
  /^k1h:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(message) {
  return new CliError(message, { exitCode: 2 });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactObject(value, keys, label) {
  if (!isObject(value)) throw invalid(`${label} must be a JSON object.`);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw invalid(`${label} contains an unsupported field.`);
  }
  return value;
}

function assertJsonValue(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw invalid("The x402 challenge contains a non-canonical JSON number.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertJsonValue);
    return;
  }
  if (isObject(value)) {
    Object.values(value).forEach(assertJsonValue);
    return;
  }
  throw invalid("The x402 challenge contains a non-JSON value.");
}

export function canonicalJson(value) {
  assertJsonValue(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestJson(value) {
  return digestBytes(canonicalJson(value));
}

function decodeBase64Json(value, label, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumBytes ||
    !BASE64.test(value)
  ) {
    throw invalid(`${label} is not canonical base64 JSON.`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("not canonical");
  } catch {
    throw invalid(`${label} is not valid base64.`);
  }
  if (bytes.length > maximumBytes) throw invalid(`${label} is too large.`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid(`${label} is not UTF-8.`);
  }
  try {
    const parsed = JSON.parse(text);
    assertJsonValue(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid(`${label} is not JSON.`);
  }
}

function normalizedHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`${label} is not a valid URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.toString() !== value
  ) {
    throw invalid(`${label} must be a normalized credential-free HTTPS URL.`);
  }
  return url.toString();
}

function optionalString(value) {
  return value === undefined || typeof value === "string";
}

function paymentResource(value, label) {
  const resource = exactObject(
    value,
    ["url", "description", "mimeType", "serviceName", "tags", "iconUrl"],
    label,
  );
  if (
    typeof resource.url !== "string" ||
    !optionalString(resource.description) ||
    !optionalString(resource.mimeType) ||
    !optionalString(resource.serviceName) ||
    (resource.serviceName !== undefined &&
      (resource.serviceName.length < 1 ||
        resource.serviceName.length > 32 ||
        !PRINTABLE_ASCII.test(resource.serviceName))) ||
    (resource.tags !== undefined &&
      (!Array.isArray(resource.tags) ||
        resource.tags.length > 5 ||
        resource.tags.some(
          (tag) =>
            typeof tag !== "string" ||
            tag.length < 1 ||
            tag.length > 32 ||
            !PRINTABLE_ASCII.test(tag),
        ))) ||
    !optionalString(resource.iconUrl)
  ) {
    throw invalid(`${label} is malformed.`);
  }
  return resource;
}

function validateGasSponsorship(declaration) {
  const info = declaration.info;
  const schema = declaration.schema;
  const infoKeys = [
    "billingParty",
    "buyerNativeFeeRequired",
    "expiresAt",
    "finalChargePolicy",
    "maximumReservationEvidenceDigest",
    "mode",
    "requirements",
    "version",
  ];
  if (
    !isObject(info) ||
    Object.keys(info).sort().join(",") !== infoKeys.slice().sort().join(",") ||
    info.version !== 1 ||
    info.mode !== "facilitator_pays" ||
    info.buyerNativeFeeRequired !== false ||
    info.billingParty !== "tenant_service_credit" ||
    info.finalChargePolicy !== "canonical_actual_gas_capped_by_reservation" ||
    typeof info.maximumReservationEvidenceDigest !== "string" ||
    !SHA256.test(info.maximumReservationEvidenceDigest) ||
    typeof info.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(info.expiresAt)) ||
    !Array.isArray(info.requirements) ||
    info.requirements.length < 1 ||
    info.requirements.length > 3
  ) {
    throw invalid("The x402 gas-sponsorship extension is malformed.");
  }
  const identities = new Set();
  for (const requirement of info.requirements) {
    if (
      !isObject(requirement) ||
      Object.keys(requirement).sort().join(",") !==
        "asset,network,payloadProfile" ||
      typeof requirement.network !== "string" ||
      !CAIP2_NETWORK.test(requirement.network) ||
      typeof requirement.asset !== "string" ||
      requirement.asset.length === 0 ||
      ![BASE_SPONSORED_PROFILE, SOLANA_SPONSORED_PROFILE].includes(
        requirement.payloadProfile,
      )
    ) {
      throw invalid("An x402 sponsored payment binding is malformed.");
    }
    const identity = `${requirement.network}|${requirement.asset.toLowerCase()}|${requirement.payloadProfile}`;
    if (identities.has(identity)) {
      throw invalid("The x402 gas-sponsorship extension contains a duplicate.");
    }
    identities.add(identity);
  }
  if (
    !isObject(schema) ||
    schema.$id !== "urn:com:x402api:gas-sponsorship:v1" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !Array.isArray(schema.required) ||
    schema.required.length !== infoKeys.length ||
    [...schema.required].sort().join(",") !== infoKeys.slice().sort().join(",")
  ) {
    throw invalid("The x402 gas-sponsorship schema is malformed.");
  }
  return info;
}

function paymentExtensions(value, label) {
  if (value === undefined) return {};
  if (!isObject(value)) throw invalid(`${label} must be a JSON object.`);
  for (const [name, candidate] of Object.entries(value)) {
    const declaration = exactObject(
      candidate,
      ["info", "schema"],
      `${label} ${name}`,
    );
    if (
      !isObject(declaration.info) ||
      (declaration.schema !== undefined && !isObject(declaration.schema))
    ) {
      throw invalid(`${label} ${name} is malformed.`);
    }
    assertJsonValue(declaration.info);
    if (declaration.schema !== undefined) assertJsonValue(declaration.schema);
    if (name === GAS_SPONSORSHIP_EXTENSION) {
      validateGasSponsorship(declaration);
    }
  }
  return value;
}

function paymentRequirement(value) {
  const requirement = exactObject(
    value,
    [
      "scheme",
      "network",
      "amount",
      "asset",
      "payTo",
      "maxTimeoutSeconds",
      "extra",
    ],
    "An x402 payment requirement",
  );
  if (
    typeof requirement.scheme !== "string" ||
    typeof requirement.network !== "string" ||
    !CAIP2_NETWORK.test(requirement.network) ||
    typeof requirement.amount !== "string" ||
    !/^(?:0|[1-9][0-9]{0,77})$/.test(requirement.amount) ||
    requirement.amount === "0" ||
    typeof requirement.asset !== "string" ||
    typeof requirement.payTo !== "string" ||
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds < 1 ||
    !isObject(requirement.extra)
  ) {
    throw invalid("An x402 payment requirement is malformed.");
  }
  assertJsonValue(requirement.extra);
  return requirement;
}

function externalRecipientBinds(requirement, extensions) {
  if (extensions["com.k1hub.wallet-manifest"] !== undefined) return false;
  const info = extensions["com.k1hub.external-recipient"]?.info;
  if (info?.version !== 1 || !Array.isArray(info.recipients)) return false;
  const matches = info.recipients.filter((candidate) => {
    if (
      !isObject(candidate) ||
      candidate.network !== requirement.network ||
      candidate.asset !== requirement.asset ||
      candidate.payTo !== requirement.payTo ||
      typeof candidate.recipientDescriptorDigest !== "string" ||
      !SHA256.test(candidate.recipientDescriptorDigest) ||
      !isObject(candidate.recipientDescriptor)
    ) {
      return false;
    }
    return (
      digestJson(candidate.recipientDescriptor) ===
      candidate.recipientDescriptorDigest
    );
  });
  return matches.length === 1;
}

function agentWalletSupports(requirement, sponsorship, extensions) {
  const profile = requirement.extra.payloadProfile;
  const baseExtra = Object.keys(requirement.extra).sort().join(",");
  const supportedRail =
    requirement.scheme === "exact" &&
    ((requirement.network === BASE_NETWORK &&
      requirement.asset.toLowerCase() === BASE_USDC.toLowerCase() &&
      EVM_ADDRESS.test(requirement.asset) &&
      EVM_ADDRESS.test(requirement.payTo) &&
      baseExtra === "assetTransferMethod,name,payloadProfile,version" &&
      requirement.extra.assetTransferMethod === "eip3009" &&
      requirement.extra.name === "USD Coin" &&
      requirement.extra.version === "2" &&
      profile === BASE_SPONSORED_PROFILE) ||
      (requirement.network === SOLANA_NETWORK &&
        [SOLANA_USDC, SOLANA_USDT].includes(requirement.asset) &&
        SOLANA_ADDRESS.test(requirement.payTo) &&
        SOLANA_ADDRESS.test(requirement.extra.feePayer) &&
        SOLANA_MEMO.test(requirement.extra.memo) &&
        profile === SOLANA_SPONSORED_PROFILE));
  return Boolean(
    supportedRail &&
      extensions["payment-identifier"] !== undefined &&
      externalRecipientBinds(requirement, extensions) &&
      sponsorship?.requirements.some(
        (binding) =>
          binding.network === requirement.network &&
          binding.asset === requirement.asset &&
          binding.payloadProfile === profile,
      ),
  );
}

export function parsePaymentRequired(value, expectedUrl) {
  const parsed = exactObject(
    decodeBase64Json(value, "PAYMENT-REQUIRED", MAX_CHALLENGE_BYTES),
    ["x402Version", "error", "resource", "accepts", "extensions"],
    "PAYMENT-REQUIRED",
  );
  if (
    parsed.x402Version !== 2 ||
    (parsed.error !== undefined && typeof parsed.error !== "string") ||
    !Array.isArray(parsed.accepts) ||
    parsed.accepts.length === 0 ||
    (parsed.extensions !== undefined && !isObject(parsed.extensions))
  ) {
    throw invalid("PAYMENT-REQUIRED is malformed.");
  }
  const resource = paymentResource(parsed.resource, "The x402 resource");
  const resourceUrl = normalizedHttpsUrl(resource.url, "The x402 resource URL");
  if (resourceUrl !== normalizedHttpsUrl(expectedUrl, "The checkout URL")) {
    throw invalid("PAYMENT-REQUIRED is bound to a different checkout URL.");
  }
  const accepts = parsed.accepts.map(paymentRequirement);
  const extensions = paymentExtensions(
    parsed.extensions,
    "The x402 challenge extension",
  );
  const sponsorship = extensions[GAS_SPONSORSHIP_EXTENSION]?.info;
  return {
    challenge: parsed,
    challengeDigest: digestJson(parsed),
    accepts,
    sponsorshipExpiresAt: sponsorship?.expiresAt,
    terms: accepts.map((requirement) => {
      const supported = agentWalletSupports(
        requirement,
        sponsorship,
        extensions,
      );
      return {
        scheme: requirement.scheme,
        network: requirement.network,
        amountAtomic: requirement.amount,
        asset: requirement.asset,
        payTo: requirement.payTo,
        maxTimeoutSeconds: requirement.maxTimeoutSeconds,
        payloadProfile:
          typeof requirement.extra.payloadProfile === "string"
            ? requirement.extra.payloadProfile
            : undefined,
        agentWalletSupported: supported,
        sponsoredNetworkFee: supported,
        buyerNativeFeeRequired: supported ? false : undefined,
        sponsorshipExpiresAt: supported ? sponsorship.expiresAt : undefined,
        requirementDigest: digestJson(requirement),
      };
    }),
  };
}

export function createPaymentRequestEnvelope({
  baseUrl,
  checkoutPath,
  checkoutBody,
  paymentRequired,
  merchantReference,
}) {
  const url = new URL(
    checkoutPath,
    `${baseUrl.replace(/\/$/, "")}/`,
  ).toString();
  const parsed = parsePaymentRequired(paymentRequired, url);
  const supportedTerms = parsed.terms.filter(
    (term) => term.agentWalletSupported,
  );
  if (supportedTerms.length === 0) {
    throw invalid(
      `PAYMENT-REQUIRED has no option supported by ${AGENT_WALLET_SPEC}.`,
    );
  }
  if (Date.parse(parsed.sponsorshipExpiresAt) <= Date.now()) {
    throw invalid("The x402 gas-sponsorship reservation has expired.");
  }
  if (
    typeof merchantReference !== "string" ||
    merchantReference.length === 0 ||
    merchantReference.length > 256
  ) {
    throw invalid("The payment merchant reference is invalid.");
  }
  const envelope = {
    version: 1,
    method: "POST",
    url,
    contentType: "application/json",
    bodyBase64: Buffer.from(checkoutBody, "utf8").toString("base64"),
    paymentRequired,
    challengeDigest: parsed.challengeDigest,
    merchantReference,
  };
  return {
    envelope,
    requestDigest: digestJson(envelope),
    challengeDigest: parsed.challengeDigest,
    challenge: parsed.challenge,
    sponsorshipExpiresAt: parsed.sponsorshipExpiresAt,
    requirementDigests: new Set(
      supportedTerms.map((term) => term.requirementDigest),
    ),
    terms: parsed.terms,
  };
}

async function readSafeFile(path, label, maximumBytes, requirePrivate = false) {
  const absolute = resolve(path);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw invalid(`${label} was not found: ${absolute}`);
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > maximumBytes
  ) {
    throw invalid(`${label} is unsafe or too large.`);
  }
  if (
    requirePrivate &&
    process.platform !== "win32" &&
    (info.mode & 0o077) !== 0
  ) {
    throw invalid(`${label} must have owner-only permissions.`);
  }
  return { absolute, bytes: await readFile(absolute) };
}

export async function writePaymentRequestEnvelope(path, envelope) {
  const absolute = resolve(path);
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(absolute, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readSafeFile(
      absolute,
      "The payment request envelope",
      MAX_ARTIFACT_BYTES,
      true,
    );
    if (existing.bytes.toString("utf8") !== text) {
      throw invalid(
        `The payment request envelope already exists with different content: ${absolute}`,
      );
    }
  } finally {
    await handle?.close();
  }
  if (process.platform !== "win32") await chmod(absolute, 0o600);
  return absolute;
}

export function defaultPaymentPaths(stateDirectory, taskId, challengeDigest) {
  const taskDigest = createHash("sha256")
    .update(taskId)
    .digest("hex")
    .slice(0, 16);
  const challenge = challengeDigest.slice(
    "sha256:".length,
    "sha256:".length + 16,
  );
  const stem = `${taskDigest}-${challenge}`;
  const directory = join(stateDirectory, "payments");
  return {
    requestEnvelopePath: join(directory, `${stem}.request.json`),
    paymentArtifactPath: join(directory, `${stem}.payment.json`),
  };
}

function paymentSignatureRequirement(value, expected, buyerPaymentIdentifier) {
  const signature = exactObject(
    decodeBase64Json(
      value,
      "The payment artifact signature",
      MAX_SIGNATURE_BYTES,
    ),
    ["x402Version", "accepted", "payload", "extensions", "resource"],
    "The payment artifact signature",
  );
  if (
    signature.x402Version !== 2 ||
    !isObject(signature.accepted) ||
    !isObject(signature.payload) ||
    !isObject(signature.extensions)
  ) {
    throw invalid("The payment artifact signature is malformed.");
  }
  const resource = paymentResource(
    signature.resource,
    "The payment artifact signature resource",
  );
  if (
    normalizedHttpsUrl(
      resource.url,
      "The payment artifact signature resource URL",
    ) !== expected.envelope.url ||
    canonicalJson(resource) !== canonicalJson(expected.challenge.resource)
  ) {
    throw invalid(
      "The payment artifact signature is bound to a different checkout resource.",
    );
  }
  const signatureExtensions = paymentExtensions(
    signature.extensions,
    "The payment artifact signature extension",
  );
  const expectedExtensions = JSON.parse(
    canonicalJson(expected.challenge.extensions ?? {}),
  );
  if (expectedExtensions["payment-identifier"] !== undefined) {
    expectedExtensions["payment-identifier"].info.id = buyerPaymentIdentifier;
  }
  if (
    canonicalJson(signatureExtensions) !== canonicalJson(expectedExtensions)
  ) {
    throw invalid(
      "The payment artifact signature extensions do not match the saved challenge.",
    );
  }
  return paymentRequirement(signature.accepted);
}

export async function readPaymentArtifact(path, expected) {
  const { absolute, bytes } = await readSafeFile(
    path,
    "The payment artifact",
    MAX_ARTIFACT_BYTES,
    true,
  );
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("The payment artifact is not UTF-8 JSON.");
  }
  const artifact = exactObject(
    value,
    [
      "version",
      "attemptId",
      "requestDigest",
      "buyerPaymentIdentifier",
      "wallet",
      "payerAddress",
      "selectedRequirementDigest",
      "paymentSignature",
      "createdAt",
      "expiresAt",
    ],
    "The payment artifact",
  );
  const createdAt = Date.parse(artifact.createdAt);
  const expiresAt = Date.parse(artifact.expiresAt);
  if (
    artifact.version !== 1 ||
    typeof artifact.attemptId !== "string" ||
    artifact.attemptId.length === 0 ||
    typeof artifact.requestDigest !== "string" ||
    !SHA256.test(artifact.requestDigest) ||
    typeof artifact.buyerPaymentIdentifier !== "string" ||
    !PAYMENT_IDENTIFIER.test(artifact.buyerPaymentIdentifier) ||
    typeof artifact.wallet !== "string" ||
    artifact.wallet.length === 0 ||
    typeof artifact.payerAddress !== "string" ||
    artifact.payerAddress.length === 0 ||
    typeof artifact.selectedRequirementDigest !== "string" ||
    !SHA256.test(artifact.selectedRequirementDigest) ||
    typeof artifact.paymentSignature !== "string" ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > expiresAt
  ) {
    throw invalid("The payment artifact is malformed.");
  }
  if (artifact.requestDigest !== expected.requestDigest) {
    throw invalid(
      "The payment artifact is bound to a different checkout request.",
    );
  }
  if (!expected.requirementDigests.has(artifact.selectedRequirementDigest)) {
    throw invalid(
      "The payment artifact selected an unsupported payment requirement.",
    );
  }
  if (expiresAt <= Date.now())
    throw invalid("The payment artifact has expired.");
  if (expiresAt > Date.parse(expected.sponsorshipExpiresAt)) {
    throw invalid(
      "The payment artifact outlives the saved gas-sponsorship reservation.",
    );
  }
  const accepted = paymentSignatureRequirement(
    artifact.paymentSignature,
    expected,
    artifact.buyerPaymentIdentifier,
  );
  if (digestJson(accepted) !== artifact.selectedRequirementDigest) {
    throw invalid(
      "The payment artifact signature does not match its selected requirement.",
    );
  }
  return {
    path: absolute,
    attemptId: artifact.attemptId,
    requestDigest: artifact.requestDigest,
    buyerPaymentIdentifier: artifact.buyerPaymentIdentifier,
    wallet: artifact.wallet,
    payerAddress: artifact.payerAddress,
    selectedRequirementDigest: artifact.selectedRequirementDigest,
    paymentSignature: artifact.paymentSignature,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
  };
}

export function paymentWorkflow({
  taskId,
  serverId,
  kind = "checkout",
  requestEnvelopePath,
  paymentArtifactPath,
}) {
  return {
    signer: "x402api Agent Wallet",
    signerExecutable: "x402api",
    signerNodeRequirement: ">=22",
    signerPackage: {
      name: AGENT_WALLET_PACKAGE,
      version: AGENT_WALLET_VERSION,
      spec: AGENT_WALLET_SPEC,
      registryUrl: `https://www.npmjs.com/package/${AGENT_WALLET_PACKAGE}`,
      install: {
        argv: ["npm", "install", "--global", AGENT_WALLET_SPEC],
      },
    },
    signerContract: {
      version: 1,
      probe: { argv: ["x402api", "help", "--json"] },
    },
    signerReleaseStatus:
      "published launch payer; sponsored Base USDC and Solana USDC/USDT only",
    walletSkill: {
      name: "x402api-pay",
      install: {
        argv: [
          "x402api",
          "skill",
          "install",
          "--output",
          "<agent-skill-directory>/x402api-pay",
          "--json",
        ],
      },
    },
    requestEnvelopePath,
    paymentArtifactPath,
    authorize: {
      argv: [
        "x402api",
        "payment",
        "authorize",
        "--wallet",
        "<wallet-name>",
        "--request-envelope",
        requestEnvelopePath,
        "--artifact-out",
        paymentArtifactPath,
        "--json",
      ],
    },
    submit: {
      argv:
        kind === "renewal"
          ? [
              "warpmetal",
              "renewal",
              "submit",
              "--server",
              serverId,
              "--payment-artifact",
              paymentArtifactPath,
              "--wait",
              "--json",
            ]
          : [
              "warpmetal",
              "checkout",
              "submit",
              "--task",
              taskId,
              "--payment-artifact",
              paymentArtifactPath,
              "--wait",
              "--json",
            ],
    },
    compatibility: {
      alternativeInput: "--payment-signature-file <path>",
      walletKeysHandledByWarpMetal: false,
      walletDirectSubmissionUsed: false,
      reason:
        "WarpMetal checkout requires the private owner token, so x402api authorizes and WarpMetal submits.",
    },
  };
}
