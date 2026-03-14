import type { AuthConfig } from "./config.js";

export function applyAuth(
  url: string,
  auth: AuthConfig | null
): { url: string; headers: Record<string, string> } {
  if (!auth) {
    return { url, headers: {} };
  }

  const apiKey = process.env[auth.key_env];
  if (!apiKey) {
    throw new Error(
      `Environment variable ${auth.key_env} is not set (required for authentication)`
    );
  }

  if (auth.type === "query_param") {
    const paramName = auth.param_name ?? "key";
    const separator = url.includes("?") ? "&" : "?";
    return {
      url: `${url}${separator}${encodeURIComponent(paramName)}=${encodeURIComponent(apiKey)}`,
      headers: {},
    };
  }

  if (auth.type === "header") {
    const headerName = auth.header_name ?? "Authorization";
    return {
      url,
      headers: { [headerName]: apiKey },
    };
  }

  return { url, headers: {} };
}
