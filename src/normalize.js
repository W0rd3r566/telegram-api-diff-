import { sortKeysDeep } from "./core.js";

export function normalizeText(input) {
  let output = String(input);
  output = output.replace(/<time\b[^>]*>[\s\S]*?<\/time\s*>/gi, "");
  output = output.replace(/<!--\s*page generated in \d+\s*ms\s*-->/gi, "");
  output = output.replace(/\b(?:\d{1,3}\.){3}\d{1,3}:8888\b/g, "<IP>:8888");
  output = output.replace(
    /([?&])((?:hash|token|passport_ssid|nonce))=([^&#"' \t\r\n]*)/gi,
    (_match, separator, key) => separator + key + "=<volatile>",
  );
  output = output.replace(/\b(sig|se)=([^&\s"'<>]+)/gi, (_match, key) => key + "=<volatile>");
  output = output.replace(/([?&])\d{4,}_\d{3,}(?=(&|#|$))/g, "");
  output = output.replace(/\?&/g, "?");
  output = output.replace(/[?&](?=#|$)/g, "");
  return output;
}

export function normalizeJsonResource(input, options = {}) {
  let data;
  try {
    data = JSON.parse(String(input).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new TypeError("Resource is not valid JSON.", { cause: error });
  }
  if (String(options.fileName ?? "").endsWith("help.getAppConfig.json") &&
      data && typeof data === "object" && !Array.isArray(data)) {
    delete data.hash;
    delete data.ton_usd_rate;
  }
  return JSON.stringify(sortKeysDeep(data), null, 2) + "\n";
}

export function normalizeResource(input, options = {}) {
  return options.json ? normalizeJsonResource(input, options) : normalizeText(input);
}
