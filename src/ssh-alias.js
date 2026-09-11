import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  knownHosts,
  readConnectionProfile,
  validateConnectionProfile,
} from "./connection.js";
import { CliError } from "./errors.js";

const ALIAS_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UNSAFE_PATH = /[\0\r\n\t%"'`$!&;<>|*?()[\]{}\\#]/;
const MANAGED_HEADER = "# Managed by WarpMetal. Do not edit.";

function invalid(message) {
  throw new CliError(message, { exitCode: 2 });
}

export function validateSshAlias(value) {
  if (typeof value !== "string" || !ALIAS_PATTERN.test(value)) {
    invalid(
      "The SSH alias must be a lowercase concrete name of 1-63 letters, digits, or internal hyphens.",
    );
  }
  return value;
}

function validateAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parse(value).root ||
    UNSAFE_PATH.test(value)
  ) {
    invalid(`${label} must be an absolute path without unsafe interpolation characters.`);
  }
  return value;
}

function requireOwner(metadata, label) {
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    invalid(`${label} must be owned by the current user.`);
  }
}

async function metadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requireSafeDirectory(info, label) {
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    invalid(`${label} must be a regular directory and cannot be a symlink.`);
  }
  requireOwner(info, label);
}

function requireDirectoryWithoutSymlink(info, label) {
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    invalid(`${label} must be a directory and cannot be a symlink.`);
  }
}

function requireSafeFile(info, label) {
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    invalid(`${label} must be a regular, non-symlink, non-hard-linked file.`);
  }
  requireOwner(info, label);
}

async function readSafeFile(path, expected, label) {
  requireSafeFile(expected, label);
  const noFollow = constants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const current = await handle.stat();
    requireSafeFile(current, label);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      invalid(`${label} changed during validation.`);
    }
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function entrySnapshot(info) {
  return info
    ? { dev: info.dev, ino: info.ino, mode: info.mode, size: info.size }
    : null;
}

async function requireUnchanged(path, expected, label) {
  const current = await metadata(path);
  if (expected === null) {
    if (current !== null) invalid(`${label} appeared during the operation.`);
    return;
  }
  requireSafeFile(current, label);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mode !== expected.mode ||
    current.size !== expected.size
  ) {
    invalid(`${label} changed during the operation.`);
  }
}

function containsConcreteAlias(value, alias) {
  const normalized = alias.toLowerCase();
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^host\s+/i.test(line)) continue;
    const tokens = line
      .replace(/\s+#.*$/, "")
      .split(/\s+/)
      .slice(1);
    if (
      tokens.some(
        (token) =>
          !token.startsWith("!") && token.toLowerCase() === normalized,
      )
    ) {
      return true;
    }
  }
  return false;
}

function sshPaths(homeDirectory, alias) {
  const sshDirectory = join(homeDirectory, ".ssh");
  const managedDirectory = join(sshDirectory, "warpmetal.d");
  return {
    sshDirectory,
    managedDirectory,
    sshConfigPath: join(sshDirectory, "config"),
    configPath: join(managedDirectory, `${alias}.conf`),
    knownHostsPath: join(managedDirectory, `${alias}.known_hosts`),
  };
}

function openSshPath(path) {
  return path.includes(" ") ? `"${path}"` : path;
}

function includeLine(managedDirectory) {
  return `Include ${openSshPath(`${managedDirectory}/*.conf`)}\n`;
}

function isMarkedAliasConfig(bytes, alias) {
  if (!bytes) return false;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  return lines[0] === MANAGED_HEADER && lines[1] === `Host ${alias}`;
}

function includePatterns(value, homeDirectory, sshDirectory) {
  const result = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^include\s+/i.test(line)) continue;
    const argumentsText = line.replace(/^include\s+/i, "");
    const tokens = argumentsText.match(/"[^"]*"|[^\s#]+/g) || [];
    for (const rawToken of tokens) {
      const token = rawToken.startsWith('"')
        ? rawToken.slice(1, -1)
        : rawToken;
      if (!token) continue;
      if (/[%$\0\r\n]/.test(token) || token.startsWith("~") && !token.startsWith("~/")) {
        invalid("A user SSH Include uses an unsupported expansion.");
      }
      if (token.startsWith("~/")) {
        result.push(join(homeDirectory, token.slice(2)));
      } else if (isAbsolute(token)) {
        result.push(resolve(token));
      } else {
        result.push(resolve(sshDirectory, token));
      }
    }
  }
  return [...new Set(result)];
}

function globSegmentPattern(segment) {
  let source = "^";
  for (const character of segment) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else if (character === "[" || character === "]") {
      invalid("A user SSH Include uses an unsupported bracket pattern.");
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(source + "$");
}

async function expandIncludePattern(pattern, state) {
  const root = parse(pattern).root;
  const segments = pattern.slice(root.length).split(/[\\/]/).filter(Boolean);
  let candidates = [root];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const wildcard = /[*?\[\]]/.test(segment);
    const last = index === segments.length - 1;
    const next = [];
    for (const base of candidates) {
      if (!wildcard) {
        const candidate = join(base, segment);
        if (last) {
          next.push(candidate);
          continue;
        }
        next.push(candidate);
        continue;
      }
      const baseInfo = await metadata(base);
      if (!baseInfo) continue;
      requireDirectoryWithoutSymlink(
        baseInfo,
        "A user SSH Include directory",
      );
      const expression = globSegmentPattern(segment);
      const names = (await readdir(base)).sort();
      for (const name of names) {
        if (name.startsWith(".") && !segment.startsWith(".")) continue;
        if (!expression.test(name)) continue;
        const candidate = join(base, name);
        if (!last) {
          const info = await metadata(candidate);
          requireDirectoryWithoutSymlink(
            info,
            "A user SSH Include directory",
          );
        }
        next.push(candidate);
        state.matches += 1;
        if (state.matches > 256) {
          invalid("User SSH Includes exceed the bounded inspection limit.");
        }
      }
    }
    candidates = next;
  }
  return candidates;
}

async function scanIncludedCollisions(
  value,
  homeDirectory,
  sshDirectory,
  alias,
  excludedPath,
  state = { matches: 0, visited: new Set() },
  depth = 0,
) {
  if (depth > 8) {
    invalid("User SSH Includes exceed the bounded recursion limit.");
  }
  for (const pattern of includePatterns(value, homeDirectory, sshDirectory)) {
    for (const path of await expandIncludePattern(pattern, state)) {
      if (path === excludedPath) continue;
      const info = await metadata(path);
      if (!info) continue;
      const included = await preflightFile(
        path,
        "A directly included user SSH config",
      );
      const identity = `${included.info.dev}:${included.info.ino}`;
      if (state.visited.has(identity)) continue;
      state.visited.add(identity);
      const text = included.bytes.toString("utf8");
      if (containsConcreteAlias(text, alias)) {
        invalid(
          `The SSH alias ${alias} collides with an included unmanaged config.`,
        );
      }
      await scanIncludedCollisions(
        text,
        homeDirectory,
        sshDirectory,
        alias,
        excludedPath,
        state,
        depth + 1,
      );
    }
  }
}

function safeResult(operation, alias, paths, profile, identityPath) {
  return {
    operation,
    alias,
    serverId: profile.serverId,
    sandboxId: profile.sandboxId,
    grantId: profile.grantId,
    identityPath,
    sshConfigPath: paths.sshConfigPath,
    configPath: paths.configPath,
    knownHostsPath: paths.knownHostsPath,
  };
}

export function renderSshHostBlock({
  alias,
  profile,
  identityPath,
  knownHostsPath,
}) {
  const safeAlias = validateSshAlias(alias);
  const safeProfile = validateConnectionProfile(profile);
  const identity = validateAbsolutePath(identityPath, "The SSH identity path");
  const pins = validateAbsolutePath(
    knownHostsPath,
    "The managed known-hosts path",
  );
  if (!/^[A-Za-z0-9._:-]+$/.test(safeProfile.host)) {
    invalid("The connection host is unsafe for OpenSSH configuration.");
  }
  return [
    MANAGED_HEADER,
    `Host ${safeAlias}`,
    `  HostName ${safeProfile.host}`,
    `  Port ${safeProfile.port}`,
    `  User ${safeProfile.username}`,
    `  IdentityFile ${openSshPath(identity)}`,
    "  IdentitiesOnly yes",
    "  PubkeyAuthentication yes",
    "  PreferredAuthentications publickey",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ChallengeResponseAuthentication no",
    "  GSSAPIAuthentication no",
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile ${openSshPath(pins)}`,
    "  GlobalKnownHostsFile /dev/null",
    "  HashKnownHosts no",
    "  UpdateHostKeys no",
    "  VerifyHostKeyDNS no",
    "  ClearAllForwardings yes",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  PermitLocalCommand no",
    "  ProxyCommand none",
    "  ProxyJump none",
    "  ExitOnForwardFailure yes",
    "  ControlMaster no",
    "  ControlPath none",
    "",
  ].join("\n");
}

async function preflightDirectory(path, label) {
  const info = await metadata(path);
  if (info) requireSafeDirectory(info, label);
  return info;
}

async function preflightFile(path, label) {
  const info = await metadata(path);
  if (!info) return { info: null, bytes: null };
  requireSafeFile(info, label);
  return { info, bytes: await readSafeFile(path, info, label) };
}

async function ensurePrivateDirectory(path, label) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = await metadata(path);
  requireSafeDirectory(info, label);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700);
  }
}

async function stageFile(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    return temporary;
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function commitStaged(staged) {
  try {
    for (const item of staged) {
      await requireUnchanged(item.path, item.before, item.label);
    }
    for (const item of staged) {
      await rename(item.temporary, item.path);
      item.temporary = null;
      if (process.platform !== "win32") await chmod(item.path, 0o600);
      await syncDirectory(parse(item.path).dir);
    }
  } finally {
    await Promise.all(
      staged.map((item) =>
        item.temporary ? rm(item.temporary, { force: true }) : undefined,
      ),
    );
  }
}

async function scanManagedCollisions(managedDirectory, targetPath, alias) {
  const directory = await metadata(managedDirectory);
  if (!directory) return;
  const names = await readdir(managedDirectory);
  for (const name of names) {
    if (!name.endsWith(".conf")) continue;
    const path = join(managedDirectory, name);
    if (path === targetPath) continue;
    const item = await preflightFile(path, "A managed SSH config file");
    if (containsConcreteAlias(item.bytes.toString("utf8"), alias)) {
      invalid(`The SSH alias ${alias} collides with another managed Host entry.`);
    }
  }
}

export async function installSshAlias({
  alias,
  connectionFile,
  identity,
  homeDirectory,
  confirm,
}) {
  const safeAlias = validateSshAlias(alias);
  const home = validateAbsolutePath(homeDirectory, "The home directory");
  const identityPath = validateAbsolutePath(identity, "The SSH identity path");
  const connectionPath = resolve(connectionFile);
  const paths = sshPaths(home, safeAlias);
  for (const target of [
    paths.sshConfigPath,
    paths.configPath,
    paths.knownHostsPath,
  ]) {
    if (identityPath === target || connectionPath === target) {
      invalid("The identity and connection profile cannot overlap managed SSH paths.");
    }
  }

  const profile = await readConnectionProfile(connectionFile);
  const identityInfo = await metadata(identityPath);
  requireSafeFile(identityInfo, "The SSH identity");
  if (
    process.platform !== "win32" &&
    ((identityInfo.mode & 0o077) !== 0 || (identityInfo.mode & 0o400) === 0)
  ) {
    invalid("The SSH identity must be private and readable only by its owner.");
  }

  const homeInfo = await metadata(home);
  requireSafeDirectory(homeInfo, "The home directory");
  await preflightDirectory(paths.sshDirectory, "The .ssh path");
  await preflightDirectory(paths.managedDirectory, "The managed SSH path");

  const sshConfig = await preflightFile(
    paths.sshConfigPath,
    "The SSH config target",
  );
  const managedConfig = await preflightFile(
    paths.configPath,
    "The managed SSH config target",
  );
  const managedPins = await preflightFile(
    paths.knownHostsPath,
    "The managed known-hosts target",
  );
  const originalConfig = sshConfig.bytes?.toString("utf8") ?? "";
  if (containsConcreteAlias(originalConfig, safeAlias)) {
    invalid(`The SSH alias ${safeAlias} already has an unmanaged Host collision.`);
  }
  await scanIncludedCollisions(
    originalConfig,
    home,
    paths.sshDirectory,
    safeAlias,
    paths.configPath,
  );
  await scanManagedCollisions(paths.managedDirectory, paths.configPath, safeAlias);

  const hostBlock = Buffer.from(
    renderSshHostBlock({
      alias: safeAlias,
      profile,
      identityPath,
      knownHostsPath: paths.knownHostsPath,
    }),
  );
  const pins = Buffer.from(knownHosts(profile));
  const include = includeLine(paths.managedDirectory);
  const desiredSshConfig = Buffer.from(
    originalConfig.startsWith(include) ? originalConfig : include + originalConfig,
  );
  const existingInstall = managedConfig.info !== null || managedPins.info !== null;
  if (
    existingInstall &&
    (!managedConfig.info ||
      !managedPins.info ||
      !isMarkedAliasConfig(managedConfig.bytes, safeAlias))
  ) {
    invalid(
      "Refusing to replace unproven managed SSH ownership or orphan alias artifacts.",
    );
  }
  const directories = [
    await metadata(paths.sshDirectory),
    await metadata(paths.managedDirectory),
  ];
  const exact =
    managedConfig.bytes?.equals(hostBlock) === true &&
    managedPins.bytes?.equals(pins) === true &&
    sshConfig.bytes?.equals(desiredSshConfig) === true &&
    [managedConfig.info, managedPins.info, sshConfig.info].every(
      (item) => process.platform === "win32" || (item.mode & 0o777) === 0o600,
    ) &&
    directories.every(
      (item) => process.platform === "win32" || (item.mode & 0o777) === 0o700,
    );
  if (exact) {
    return safeResult(
      "unchanged",
      safeAlias,
      paths,
      profile,
      identityPath,
    );
  }
  if (existingInstall && confirm !== "REFRESH") {
    invalid(
      "The managed SSH alias changed. Confirm exact replacement with --confirm REFRESH.",
    );
  }

  await ensurePrivateDirectory(paths.sshDirectory, "The .ssh path");
  await ensurePrivateDirectory(paths.managedDirectory, "The managed SSH path");
  const writes = [
    {
      path: paths.knownHostsPath,
      bytes: pins,
      before: entrySnapshot(managedPins.info),
      label: "The managed known-hosts target",
    },
    {
      path: paths.configPath,
      bytes: hostBlock,
      before: entrySnapshot(managedConfig.info),
      label: "The managed SSH config target",
    },
    {
      path: paths.sshConfigPath,
      bytes: desiredSshConfig,
      before: entrySnapshot(sshConfig.info),
      label: "The SSH config target",
    },
  ].filter(
    (item) =>
      item.before === null ||
      (item.path === paths.configPath && !managedConfig.bytes.equals(item.bytes)) ||
      (item.path === paths.knownHostsPath && !managedPins.bytes.equals(item.bytes)) ||
      (item.path === paths.sshConfigPath && !sshConfig.bytes.equals(item.bytes)) ||
      process.platform !== "win32" && (item.before.mode & 0o777) !== 0o600,
  );
  const staged = [];
  try {
    for (const item of writes) {
      staged.push({ ...item, temporary: await stageFile(item.path, item.bytes) });
    }
    await commitStaged(staged);
  } catch (error) {
    await Promise.all(
      staged.map((item) =>
        item.temporary ? rm(item.temporary, { force: true }) : undefined,
      ),
    );
    throw error;
  }
  return safeResult(
    existingInstall ? "refreshed" : "installed",
    safeAlias,
    paths,
    profile,
    identityPath,
  );
}

export async function removeSshAlias({ alias, homeDirectory, confirm }) {
  const safeAlias = validateSshAlias(alias);
  if (confirm !== "REMOVE") {
    invalid("Confirm managed SSH alias removal with --confirm REMOVE.");
  }
  const home = validateAbsolutePath(homeDirectory, "The home directory");
  const paths = sshPaths(home, safeAlias);
  const homeInfo = await metadata(home);
  requireSafeDirectory(homeInfo, "The home directory");
  const sshDirectory = await preflightDirectory(paths.sshDirectory, "The .ssh path");
  if (!sshDirectory) {
    return { operation: "unchanged", alias: safeAlias };
  }
  const managedDirectory = await preflightDirectory(
    paths.managedDirectory,
    "The managed SSH path",
  );
  const sshConfig = await preflightFile(
    paths.sshConfigPath,
    "The SSH config target",
  );
  const managedConfig = await preflightFile(
    paths.configPath,
    "The managed SSH config target",
  );
  const managedPins = await preflightFile(
    paths.knownHostsPath,
    "The managed known-hosts target",
  );
  if (!managedConfig.info && !managedPins.info) {
    return { operation: "unchanged", alias: safeAlias };
  }
  if (
    !managedConfig.info ||
    !managedPins.info ||
    !isMarkedAliasConfig(managedConfig.bytes, safeAlias)
  ) {
    invalid(
      "Refusing to remove unproven managed SSH ownership or orphan alias artifacts.",
    );
  }

  const names = managedDirectory ? await readdir(paths.managedDirectory) : [];
  const otherConfigs = names.filter(
    (name) => name.endsWith(".conf") && name !== `${safeAlias}.conf`,
  );
  for (const name of otherConfigs) {
    await preflightFile(
      join(paths.managedDirectory, name),
      "A managed SSH config file",
    );
  }
  const include = includeLine(paths.managedDirectory);
  const originalConfig = sshConfig.bytes?.toString("utf8") ?? "";
  const desiredConfig =
    otherConfigs.length === 0 && originalConfig.startsWith(include)
      ? Buffer.from(originalConfig.slice(include.length))
      : sshConfig.bytes;
  const staged = [];
  if (sshConfig.info && !sshConfig.bytes.equals(desiredConfig)) {
    staged.push({
      path: paths.sshConfigPath,
      bytes: desiredConfig,
      before: entrySnapshot(sshConfig.info),
      label: "The SSH config target",
      temporary: await stageFile(paths.sshConfigPath, desiredConfig),
    });
  }
  await commitStaged(staged);
  await requireUnchanged(
    paths.configPath,
    entrySnapshot(managedConfig.info),
    "The managed SSH config target",
  );
  await requireUnchanged(
    paths.knownHostsPath,
    entrySnapshot(managedPins.info),
    "The managed known-hosts target",
  );
  if (managedConfig.info) await unlink(paths.configPath);
  if (managedPins.info) await unlink(paths.knownHostsPath);
  if (managedDirectory) {
    const remaining = await readdir(paths.managedDirectory);
    if (remaining.length === 0) await rmdir(paths.managedDirectory);
  }
  return {
    operation:
      managedConfig.info || managedPins.info || staged.length > 0
        ? "removed"
        : "unchanged",
    alias: safeAlias,
    sshConfigPath: paths.sshConfigPath,
    configPath: paths.configPath,
    knownHostsPath: paths.knownHostsPath,
  };
}
