import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageDocument = require("../package.json");

export const VERSION = packageDocument.version;
export const USER_AGENT = `warpmetal-cli/${VERSION}`;
