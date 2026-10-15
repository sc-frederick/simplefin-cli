/** A JSON value, for building request bodies in tests. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;

/** A JSON object, for building request bodies in tests. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
