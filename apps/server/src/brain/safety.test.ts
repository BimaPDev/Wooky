import { describe, expect, it } from "vitest";
import { assertBodySize, assertNoSecret, findSecret } from "./safety.ts";

// Assembled at runtime so no scanner mistakes these fixtures for real credentials.
const cat = (...parts: string[]) => parts.join("");
const fake = {
  aws: cat("AKIA", "IOSFODNN7EXAMPLE"),
  github: cat("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  githubOauth: cat("gho_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  githubPat: cat(
    "github_pat_",
    "11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrs",
  ),
  anthropic: cat("sk-ant-", "api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk"),
  openai: cat("sk-", "proj-9aB8cD7eF6gH5iJ4kL3mN2oP1qR0sT"),
  slack: cat("xoxb-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
  key: cat("-----BEGIN RSA ", "PRIVATE KEY-----"),
  jwt: cat(
    "eyJhbGciOiJIUzI1NiJ9",
    ".",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
  ),
};

describe("secret scan", () => {
  it.each(Object.entries(fake))("flags a %s", (_name, value) => {
    expect(findSecret(`Remember this: ${value} for later`)).not.toBeNull();
  });

  it.each([
    "password = Zq8vK3mP7xL2nR9tW4yB",
    'api_key: "k9X2mQ7vL4pZ8wR3tY6u"',
    "GITHUB_TOKEN=Xh4Lp9Qz2Vm7Rt5Wc8Yb1N",
    "client_secret: 'A1b2C3d4E5f6G7h8I9j0'",
  ])("flags the assignment %s", (text) => {
    expect(findSecret(text)?.name).toBe("credential assignment");
  });

  it.each([
    "Prefer pnpm over npm in every project.",
    "task-based routing and risk-assessment-framework-notes are fine",
    "We use sk-learn style names, and desk-lamp-with-a-very-long-identifier-name is not a key",
    "The token budget is 2000 tokens per turn",
    "password: hunter2",
    "Rotate passwords every 90 days; never share a secret in chat.",
    "api_key = YOUR_API_KEY_HERE_PLEASE",
    "token: the-quick-brown-fox-jumps",
    "See https://github.com/org/repo/blob/main/src/app.ts for the layout.",
    "Commit abc123def4567890abc123def4567890abc123de touches the store.",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(findSecret(text)).toBeNull();
  });

  it("names the pattern and the line but never echoes the secret", () => {
    const text = `first line\nsecond ${fake.github} line`;
    let message = "";
    try {
      assertNoSecret(text, "body");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("GitHub token");
    expect(message).toContain("line 2");
    expect(message).not.toContain(fake.github);
    expect(message).not.toContain("a1B2c3D4");
  });

  it("caps the body at 16 KB of UTF-8", () => {
    expect(() => assertBodySize("a".repeat(16 * 1024))).not.toThrow();
    expect(() => assertBodySize("a".repeat(16 * 1024 + 1))).toThrow(/limit is 16384/);
    expect(() => assertBodySize("é".repeat(8 * 1024 + 1))).toThrow(/limit/);
  });
});
