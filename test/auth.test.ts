import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyAuth } from "../src/auth.js";
import type { AuthConfig } from "../src/config.js";

describe("applyAuth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns url unchanged when auth is null", () => {
    const result = applyAuth("https://example.com/feed", null);
    expect(result.url).toBe("https://example.com/feed");
    expect(result.headers).toEqual({});
  });

  it("appends query param from env var", () => {
    process.env.MY_API_KEY = "secret123";
    const auth: AuthConfig = {
      type: "query_param",
      param_name: "api_key",
      key_env: "MY_API_KEY",
    };
    const result = applyAuth("https://example.com/feed", auth);
    expect(result.url).toBe("https://example.com/feed?api_key=secret123");
    expect(result.headers).toEqual({});
  });

  it("appends query param with & when URL already has params", () => {
    process.env.MY_API_KEY = "secret123";
    const auth: AuthConfig = {
      type: "query_param",
      param_name: "api_key",
      key_env: "MY_API_KEY",
    };
    const result = applyAuth("https://example.com/feed?operator=BA", auth);
    expect(result.url).toBe(
      "https://example.com/feed?operator=BA&api_key=secret123"
    );
  });

  it("defaults param_name to 'key' when not specified", () => {
    process.env.MY_KEY = "abc";
    const auth: AuthConfig = {
      type: "query_param",
      key_env: "MY_KEY",
    };
    const result = applyAuth("https://example.com/feed", auth);
    expect(result.url).toBe("https://example.com/feed?key=abc");
  });

  it("adds header from env var", () => {
    process.env.MY_TOKEN = "bearer-token";
    const auth: AuthConfig = {
      type: "header",
      header_name: "X-Api-Key",
      key_env: "MY_TOKEN",
    };
    const result = applyAuth("https://example.com/feed", auth);
    expect(result.url).toBe("https://example.com/feed");
    expect(result.headers).toEqual({ "X-Api-Key": "bearer-token" });
  });

  it("defaults header_name to Authorization when not specified", () => {
    process.env.MY_TOKEN = "my-token";
    const auth: AuthConfig = {
      type: "header",
      key_env: "MY_TOKEN",
    };
    const result = applyAuth("https://example.com/feed", auth);
    expect(result.headers).toEqual({ Authorization: "my-token" });
  });

  it("throws when env var is not set", () => {
    delete process.env.MISSING_KEY;
    const auth: AuthConfig = {
      type: "query_param",
      param_name: "key",
      key_env: "MISSING_KEY",
    };
    expect(() => applyAuth("https://example.com/feed", auth)).toThrow(
      "MISSING_KEY is not set"
    );
  });

  it("URL-encodes special characters in param name and value", () => {
    process.env.SPECIAL_KEY = "val&ue=1";
    const auth: AuthConfig = {
      type: "query_param",
      param_name: "my key",
      key_env: "SPECIAL_KEY",
    };
    const result = applyAuth("https://example.com/feed", auth);
    expect(result.url).toBe(
      "https://example.com/feed?my%20key=val%26ue%3D1"
    );
  });
});
