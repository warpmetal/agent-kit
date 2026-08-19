import { CliError } from "./errors.js";

export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  let passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    if (value.startsWith("--no-")) {
      options[value.slice(5)] = false;
      continue;
    }

    const equals = value.indexOf("=");
    if (equals !== -1) {
      options[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }

    const name = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }

  return { positionals, options, passthrough };
}

export function stringOption(options, name, { required = false } = {}) {
  const value = options[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`--${name} requires a value.`, { exitCode: 2 });
  }
  return value;
}

export function booleanOption(options, name) {
  const value = options[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new CliError(`--${name} does not take a value.`, { exitCode: 2 });
  }
  return value;
}

export function integerOption(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new CliError(`--${name} must be a positive integer.`, {
      exitCode: 2,
    });
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new CliError(`--${name} is too large.`, { exitCode: 2 });
  }
  return number;
}

export function rejectUnknownOptions(options, allowed) {
  const unknown = Object.keys(options).filter(
    (name) => !allowed.includes(name),
  );
  if (unknown.length > 0) {
    throw new CliError(`Unknown option: --${unknown[0]}`, { exitCode: 2 });
  }
}
