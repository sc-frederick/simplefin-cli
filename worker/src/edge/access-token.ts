import { Effect, Schema } from "effect";

/** The request did not carry a valid Cloudflare Access token for the expected client. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {
  reason: Schema.String,
}) {}

/** What a valid request must prove, fixed at deploy time. */
export interface AccessPolicy {
  /** https://<team>.cloudflareaccess.com */
  readonly teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  readonly audience: string;
  /** The only service token client ID allowed to call the bridge (the JWT's common_name). */
  readonly clientId: string;
}

/** Returns the verification key for a key id, or null when unknown. */
export type KeyResolver = (kid: string) => Promise<CryptoKey | null>;

const JwtHeader = Schema.Struct({
  alg: Schema.Literal("RS256"),
  kid: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

/** Claims Access puts in a service-token application token. */
const ServiceTokenClaims = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  iss: Schema.String,
  exp: Schema.Finite,
  iat: Schema.optional(Schema.Finite),
  nbf: Schema.optional(Schema.Finite),
  type: Schema.Literal("app"),
  common_name: Schema.String,
});

const Jwks = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kid: Schema.String,
      kty: Schema.Literal("RSA"),
      n: Schema.String,
      e: Schema.String,
    }),
  ),
});

const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(JwtHeader));
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceTokenClaims));
const decodeJwks = Schema.decodeUnknownEffect(Schema.fromJsonString(Jwks));

const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

const deny = (reason: string) => new AccessDenied({ reason });

/** Constant-time comparison, so response timing reveals nothing about the expected client ID. */
function sameText(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

/**
 * Verify a Cloudflare Access application token: RS256 signature from the team's current keys,
 * audience, issuer, expiry, not-before, and that it was issued to the one allowed service token.
 */
export const verifyAccessToken = Effect.fn("verifyAccessToken")(function* (
  token: string,
  policy: AccessPolicy,
  resolveKey: KeyResolver,
  nowSeconds: number,
) {
  const parts = token.length > MAX_TOKEN_LENGTH ? [] : token.split(".");
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;

  if (
    parts.length !== 3 ||
    ![headerPart, payloadPart, signaturePart].every((part) => BASE64URL_SEGMENT.test(part))
  ) {
    return yield* deny("malformed token");
  }

  const [headerText, payloadText, signature] = yield* Effect.try({
    try: () => {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

      return [
        decoder.decode(base64UrlBytes(headerPart)),
        decoder.decode(base64UrlBytes(payloadPart)),
        base64UrlBytes(signaturePart),
      ] as const;
    },
    catch: () => deny("malformed token encoding"),
  });

  const header = yield* decodeHeader(headerText).pipe(
    Effect.mapError(() => deny("unsupported token header")),
  );

  // Verify the signature before reading any claim, so unsigned input never steers the checks
  // below and timing reveals nothing about which claim would have matched.
  const key = yield* Effect.tryPromise({
    try: () => resolveKey(header.kid),
    catch: () => deny("signing keys unavailable"),
  });

  if (key === null) return yield* deny("unknown signing key");

  const valid = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(
        RSA,
        key,
        signature,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      ),
    catch: () => deny("signature check failed"),
  });

  if (!valid) return yield* deny("bad signature");

  const claims = yield* decodeClaims(payloadText).pipe(
    Effect.mapError(() => deny("not a service token")),
  );

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (!audiences.includes(policy.audience)) return yield* deny("wrong audience");

  if (claims.iss !== policy.teamDomain) return yield* deny("wrong issuer");

  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return yield* deny("expired");

  if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return yield* deny("not yet valid");
  }

  if (!sameText(claims.common_name, policy.clientId)) return yield* deny("unexpected client");

  return claims;
});

/** Import every RSA key from a JWKS document, keyed by kid. */
export const importJwks = Effect.fn("importJwks")(function* (json: string) {
  const jwks = yield* decodeJwks(json).pipe(Effect.mapError(() => deny("unreadable signing keys")));
  const keys = new Map<string, CryptoKey>();

  for (const jwk of jwks.keys) {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          RSA,
          false,
          ["verify"],
        ),
      catch: () => deny("invalid signing key"),
    });

    keys.set(jwk.kid, key);
  }

  return keys;
});

const KEY_CACHE_MS = 60 * 60 * 1000;

/** Earliest re-fetch after an unknown key id, so forged ids cannot flood the team's key endpoint. */
const UNKNOWN_KID_COOLDOWN_MS = 60 * 1000;

/**
 * Fetch the team's signing keys, caching them per isolate for an hour. An unknown key id (a
 * rotation) triggers at most one early refresh a minute. Concurrent requests share one fetch.
 */
export function cachedKeyResolver(
  teamDomain: string,
  fetchText: (url: string) => Promise<string>,
  now: () => number = Date.now,
): KeyResolver {
  let keys: Map<string, CryptoKey> | null = null;
  let loadedAt = 0;
  let failedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<Map<string, CryptoKey>> | null = null;

  const load = (): Promise<Map<string, CryptoKey>> => {
    // After a failed fetch, refuse for a minute instead of refetching on every request.
    if (now() - failedAt < UNKNOWN_KID_COOLDOWN_MS) {
      return Promise.reject(new Error("Signing keys recently unavailable"));
    }

    inFlight ??= fetchText(`${teamDomain}/cdn-cgi/access/certs`)
      .then((json) => Effect.runPromise(importJwks(json)))
      .then(
        (loaded) => {
          keys = loaded;
          loadedAt = now();

          return loaded;
        },
        (cause: unknown) => {
          failedAt = now();

          throw cause;
        },
      )
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return async (kid) => {
    const age = now() - loadedAt;
    const current = keys === null || age > KEY_CACHE_MS ? await load() : keys;
    const key = current.get(kid);

    if (key !== undefined) return key;

    if (now() - loadedAt < UNKNOWN_KID_COOLDOWN_MS) return null;

    return (await load()).get(kid) ?? null;
  };
}
