import { Redacted, Result, Schema } from "effect";

/**
 * The only hosts that may receive a SimpleFIN setup token claim or access credentials. Pinning
 * them means a forged setup token cannot make the bridge send requests anywhere else.
 */
export const SIMPLEFIN_HOSTS: ReadonlySet<string> = new Set([
  "bridge.simplefin.org",
  "beta-bridge.simplefin.org",
]);

/** A setup token that is not a base64 HTTPS claim URL on a SimpleFIN Bridge host. */
export class InvalidSetupToken extends Schema.TaggedError<InvalidSetupToken>()(
  "InvalidSetupToken",
  { message: Schema.String },
) {}

/** A stored access URL that is not an HTTPS SimpleFIN Bridge URL with credentials. */
export class InvalidAccessUrl extends Schema.TaggedError<InvalidAccessUrl>()("InvalidAccessUrl", {
  message: Schema.String,
}) {}

/** Credentials for SimpleFIN's /accounts endpoint, split so the secret never appears in a URL. */
export interface SimplefinCredentials {
  /** HTTPS base URL without user info or a trailing slash, e.g. https://bridge.simplefin.org/simplefin. */
  readonly baseUrl: string;
  /** The complete `Authorization: Basic ...` header value. */
  readonly authorization: Redacted.Redacted<string>;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function parseUrl(text: string): URL | undefined {
  return URL.canParse(text) ? new URL(text) : undefined;
}

function decodeComponent(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function isPinnedHttpsUrl(url: URL): boolean {
  return url.protocol === "https:" && url.port === "" && SIMPLEFIN_HOSTS.has(url.hostname);
}

/** Decode a setup token into its one-time claim URL. */
export function decodeSetupToken(token: string): Result.Result<URL, InvalidSetupToken> {
  const cleaned = token.replace(/\s+/gu, "");
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);

  if (cleaned === "")
    return Result.fail(new InvalidSetupToken({ message: "Setup token is empty." }));

  if (!BASE64.test(padded)) {
    return Result.fail(new InvalidSetupToken({ message: "Setup token is not valid base64." }));
  }

  const claimUrl = parseUrl(atob(padded).trim());

  if (claimUrl === undefined || !isPinnedHttpsUrl(claimUrl) || claimUrl.username !== "") {
    return Result.fail(
      new InvalidSetupToken({
        message: `Setup tokens must decode to an HTTPS claim URL on ${[...SIMPLEFIN_HOSTS].join(" or ")}.`,
      }),
    );
  }

  return Result.succeed(claimUrl);
}

/**
 * Parse an access URL (https://user:pass@bridge.simplefin.org/simplefin) into a credential-free
 * base URL and a redacted Basic authorization header.
 */
export function parseAccessUrl(
  accessUrl: Redacted.Redacted<string>,
): Result.Result<SimplefinCredentials, InvalidAccessUrl> {
  const url = parseUrl(Redacted.value(accessUrl).trim());

  if (url === undefined || !isPinnedHttpsUrl(url)) {
    return Result.fail(
      new InvalidAccessUrl({
        message: `The access URL must be an HTTPS URL on ${[...SIMPLEFIN_HOSTS].join(" or ")}.`,
      }),
    );
  }

  if (url.username === "" || url.password === "" || url.search !== "" || url.hash !== "") {
    return Result.fail(
      new InvalidAccessUrl({ message: "The access URL must carry credentials and nothing else." }),
    );
  }

  const username = decodeComponent(url.username);
  const password = decodeComponent(url.password);

  if (username === undefined || password === undefined) {
    return Result.fail(
      new InvalidAccessUrl({ message: "The access URL credentials are malformed." }),
    );
  }

  const basic = btoa(String.fromCodePoint(...new TextEncoder().encode(`${username}:${password}`)));

  return Result.succeed({
    baseUrl: `https://${url.hostname}${url.pathname.replace(/\/+$/u, "")}`,
    authorization: Redacted.make(`Basic ${basic}`, { label: "SimpleFIN authorization" }),
  });
}

/**
 * A short, non-reversible identifier for the configured credential, used to notice a re-claim
 * and clear backoff. The access URL carries a long random password, so its hash reveals nothing.
 */
export async function credentialFingerprint(credentials: SimplefinCredentials): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${credentials.baseUrl}\n${Redacted.value(credentials.authorization)}`,
    ),
  );

  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
