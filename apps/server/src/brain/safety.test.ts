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
  describe("more credential shapes", () => {
    const more = {
      "Stripe key (live)": cat("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
      "Stripe key (restricted)": cat("rk_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
      "Stripe key (test)": cat("sk_test_", "4eC39HqLyjWDarjtT1zdp7dc"),
      "Google API key": cat("AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"),
      "GitLab token": cat("glpat-", "xxXX1234yyYY5678zzZZ"),
      "npm token": cat("npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
      "Hugging Face token": cat("hf_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ12345678"),
      "SendGrid key": cat(
        "SG.",
        "aBcDeFgHiJkLmNoPqRsTuV",
        ".",
        "wXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012",
      ),
      "Slack token": cat("xoxe-", "1-abcdefghij1234567890"),
      "Slack webhook": cat(
        "https://hooks.slack.com/services/",
        "T00000000/B00000000/",
        "XXXXXXXXXXXXXXXXXXXXXXXX",
      ),
      "private key": cat("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"),
      "URL with credentials": cat(
        "postgres://admin:",
        "Sup3rS3cretPassw0rd",
        "@db.internal:5432/app",
      ),
      "bearer token": cat("Authorization: Bearer ", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
      "credential assignment": cat("api key: ", "a8f5f167f44f4964e6c998dee827110c"),
      "API key assignment": cat("api_key = ", "qwertyuiopasdfghjklzxcvbnmQWERTY"),
      "AWS secret key": cat(
        "The AWS secret access key is ",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      ),
    };

    it.each(Object.entries(more))("flags a %s", (name, value) => {
      expect(findSecret(`note\n${value}\n`)).toEqual({
        name: name.replace(/ \(.*\)$/, ""),
        line: 2,
      });
    });

    it.each([
      "sk_live_ is the prefix Stripe uses for live keys",
      "AIza is the prefix of a Google key; see the docs",
      "hf_hub_download is the function to call",
      "npm_config_registry is an environment variable",
      "SG.short.value",
      "postgres://localhost:5432/app and https://user@example.com/path",
      "https://example.com:8080/docs and ssh://git@github.com/org/repo.git",
      "postgres://user:${DB_PASSWORD}@host/db",
      "mysql://root:<password>@localhost/db",
      "Authorization: Bearer <token>",
      "Send an Authorization header with the Bearer scheme",
      "api_key = YOUR_API_KEY_HERE",
      "api key: see the settings page",
      "-----BEGIN CERTIFICATE-----",
      "aws secret access key: store it in the vault",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "the sha is 5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b5aa765d61d8327deb882cf99",
      "aws secret 5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b",
    ])("leaves ordinary text alone: %s", (text) => {
      expect(findSecret(text)).toBeNull();
    });
  });

  describe("time", () => {
    const keywords = [
      "password",
      "passwd",
      "secret",
      "token",
      "api_key",
      "api key",
      "api-key",
      "aws_secret",
      "Authorization: Bearer ",
      "-----BEGIN ",
      "ghp_",
      "github_pat_",
      "glpat-",
      "sk-ant-",
      "sk-",
      "sk_live_",
      "AIza",
      "npm_",
      "hf_",
      "SG.",
      "xoxb-",
      "eyJ",
      "hooks.slack.com/services/",
      "a://",
    ];
    const separators = ["-", "_", " ", ":", "=", "a", "1", ".", "/", '"', "\t"];

    it("finishes a worst-case 16 KB body well under 50 ms for every keyword and separator", () => {
      const slow: string[] = [];
      for (const keyword of keywords) {
        for (const separator of separators) {
          const unit = keyword + separator;
          const body = unit.repeat(Math.ceil(16384 / unit.length)).slice(0, 16384);
          for (const text of [body, body.replace(/(.{80})/g, "$1\n")]) {
            const started = performance.now();
            findSecret(text);
            const took = performance.now() - started;
            if (took > 50) slow.push(`${JSON.stringify(unit)} ${took.toFixed(0)} ms`);
          }
        }
      }
      expect(slow).toEqual([]);
    });

    it("no longer takes cubic time on repeated password words", () => {
      const started = performance.now();
      expect(findSecret("password-".repeat(1800))).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    });

    it("still finds a credential after a very long line", () => {
      const line = `${"x".repeat(9000)} ${cat("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")} ${"y".repeat(9000)}`;
      expect(findSecret(`first\n${line}`)).toEqual({ name: "GitHub token", line: 2 });
    });
  });
});
