import { Duration, Effect, Redacted, Result, Schema } from "effect";
import type { EpochSeconds } from "../domain/dates.ts";
import { sanitizeText } from "../domain/text.ts";
import type { AccountSet } from "./account-set.ts";
import { InvalidBridgeResponse, parseAccountSet } from "./account-set.ts";
import type { SimplefinCredentials } from "./credentials.ts";
import { InvalidAccessUrl, parseAccessUrl } from "./credentials.ts";

/** Cloudflare in front of the Bridge blocks requests without a descriptive user agent (error 1010). */
const USER_AGENT = "simplefin-worker/0.1 (+https://www.simplefin.org/protocol.html)";

/** Requests slower than this are abandoned and count as failed attempts. */
const REQUEST_TIMEOUT = Duration.seconds(120);

/** Largest response accepted; a 45-day window for a household is far smaller. */
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/** The Bridge limits each request to a 90-day window. */
const MAX_WINDOW_SECONDS = 90 * 86_400;

/** The ordinary fetch signature, injected so tests can stand in for the Bridge. */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/** SimpleFIN rejected the access credentials: revoked, disabled, or never valid. */
export class AccessRevoked extends Schema.TaggedError<AccessRevoked>()("AccessRevoked", {
  message: Schema.String,
}) {}

/** The SimpleFIN Bridge subscription needs payment before data is served. */
export class PaymentRequired extends Schema.TaggedError<PaymentRequired>()("PaymentRequired", {
  message: Schema.String,
}) {}

/** The Bridge's CDN blocked the request before SimpleFIN saw it. */
export class EdgeBlocked extends Schema.TaggedError<EdgeBlocked>()("EdgeBlocked", {
  message: Schema.String,
}) {}

/** The Bridge could not be reached, timed out, redirected, or answered with an unexpected status. */
export class BridgeUnavailable extends Schema.TaggedError<BridgeUnavailable>()(
  "BridgeUnavailable",
  { message: Schema.String },
) {}

/** The setup token does not exist or was already claimed. */
export class SetupTokenRejected extends Schema.TaggedError<SetupTokenRejected>()(
  "SetupTokenRejected",
  { message: Schema.String },
) {}

/** Every failure an /accounts request can produce. */
export type FetchAccountsError =
  | AccessRevoked
  | PaymentRequired
  | EdgeBlocked
  | BridgeUnavailable
  | InvalidBridgeResponse;

/** One /accounts request's time range, [start, end). */
export interface AccountsWindow {
  readonly start: EpochSeconds;
  readonly end: EpochSeconds;
}

const send = (fetch: FetchFunction, url: string, init: RequestInit) =>
  Effect.tryPromise({
    // Never follow redirects: a redirect must not carry credentials to another host or to HTTP.
    try: (signal) => fetch(url, { ...init, redirect: "manual", signal }),
    catch: () => new BridgeUnavailable({ message: "SimpleFIN Bridge could not be reached." }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new BridgeUnavailable({ message: "SimpleFIN Bridge timed out." })),
    }),
  );

/** Read a response body as text within the timeout, refusing bodies over the limit without buffering them. */
const readBoundedText = (response: Response) =>
  Effect.tryPromise({
    try: async () => {
      const declared = Number(response.headers.get("content-length") ?? "0");

      if (declared > MAX_RESPONSE_BYTES || response.body === null) {
        await response.body?.cancel();

        return declared > MAX_RESPONSE_BYTES ? undefined : "";
      }

      const reader = response.body.getReader();
      const chunks: Array<Uint8Array> = [];
      let total = 0;

      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        total += chunk.value.byteLength;

        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();

          return undefined;
        }

        chunks.push(chunk.value);
      }

      const body = new Uint8Array(total);
      let offset = 0;

      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
    },
    catch: () => new BridgeUnavailable({ message: "SimpleFIN Bridge response could not be read." }),
  }).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.fail(
            new InvalidBridgeResponse({ message: "SimpleFIN returned an oversized response." }),
          )
        : Effect.succeed(text),
    ),
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(new BridgeUnavailable({ message: "SimpleFIN Bridge response timed out." })),
    }),
  );

/** Distinguish the CDN's "error code: 1010" pages from SimpleFIN's own 403. */
const edgeBlockOr = <E>(response: Response, otherwise: E): Effect.Effect<never, E | EdgeBlocked> =>
  readBoundedText(response).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((body): Effect.Effect<never, E | EdgeBlocked> =>
      body.startsWith("error code:")
        ? Effect.fail(
            new EdgeBlocked({
              message: `Request blocked by the Bridge's CDN (${sanitizeText(body, 40)}), not by SimpleFIN auth.`,
            }),
          )
        : Effect.fail(otherwise),
    ),
  );

/** Exchange a one-time claim URL for an access URL. Only the local claim script calls this. */
export const claimAccessUrl = Effect.fn("SimpleFIN.claimAccessUrl")(function* (
  fetch: FetchFunction,
  claimUrl: URL,
) {
  const response = yield* send(fetch, claimUrl.href, {
    method: "POST",
    body: "",
    headers: { "content-length": "0", "user-agent": USER_AGENT },
  });

  if (response.status === 403) {
    return yield* edgeBlockOr(
      response,
      new SetupTokenRejected({
        message:
          "SimpleFIN rejected the setup token: it does not exist or was already claimed. If you did " +
          "not claim it yourself, your data may be compromised: disable the token at " +
          "https://bridge.simplefin.org and create a new one.",
      }),
    );
  }

  if (response.status !== 200) {
    yield* Effect.promise(async () => response.body?.cancel());

    return yield* new BridgeUnavailable({ message: `Claim failed with HTTP ${response.status}.` });
  }

  const accessUrl = Redacted.make((yield* readBoundedText(response)).trim(), {
    label: "SimpleFIN access URL",
  });

  const parsed = parseAccessUrl(accessUrl);

  if (Result.isFailure(parsed)) {
    return yield* new InvalidAccessUrl({ message: "SimpleFIN returned an unusable access URL." });
  }

  return accessUrl;
});

/** One GET /accounts request. Each call counts against the Bridge's ~24/day quota. */
export const fetchAccounts = Effect.fn("SimpleFIN.fetchAccounts")(function* (
  fetch: FetchFunction,
  credentials: SimplefinCredentials,
  window: AccountsWindow,
) {
  if (window.end - window.start > MAX_WINDOW_SECONDS) {
    return yield* new BridgeUnavailable({
      message: "SimpleFIN limits each request to a 90-day window.",
    });
  }

  const query = new URLSearchParams([
    ["version", "2"],
    ["start-date", String(Math.trunc(window.start))],
    ["end-date", String(Math.trunc(window.end))],
    ["pending", "1"],
  ]);

  const response = yield* send(fetch, `${credentials.baseUrl}/accounts?${query.toString()}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: Redacted.value(credentials.authorization),
      "user-agent": USER_AGENT,
    },
  });

  if (response.status === 403) {
    return yield* edgeBlockOr(
      response,
      new AccessRevoked({
        message:
          "SimpleFIN rejected the access credentials (revoked or invalid). Create a new setup " +
          "token and run the claim script again.",
      }),
    );
  }

  if (response.status === 402) {
    yield* Effect.promise(async () => response.body?.cancel());

    return yield* new PaymentRequired({
      message: "SimpleFIN Bridge subscription payment is required.",
    });
  }

  if (response.status !== 200) {
    yield* Effect.promise(async () => response.body?.cancel());

    return yield* new BridgeUnavailable({
      message: `GET /accounts failed with HTTP ${response.status}.`,
    });
  }

  const parsed = parseAccountSet(yield* readBoundedText(response));

  return Result.isFailure(parsed) ? yield* parsed.failure : (parsed.success satisfies AccountSet);
});
