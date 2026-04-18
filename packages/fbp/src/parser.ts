// Thin wrapper around the `fbp` npm package's PEG parser so callers get a
// typed AST and we keep one import site for the (untyped) dependency.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — no types published for the `fbp` package
import fbp from "fbp";
import type { FbpAst } from "./types.js";

/**
 * Parse an FBP text graph into an AST. Throws the fbp package's
 * `SyntaxError` on invalid input.
 *
 * @example
 *   parseFbp("A(MyComp) OUT -> IN B(Other)");
 */
export function parseFbp(source: string): FbpAst {
  const parsed = fbp.parse(source) as unknown;
  // The fbp package's parser always returns an object matching FbpAst's
  // shape on success; the assertion is safe because malformed input throws.
  return parsed as FbpAst;
}

/**
 * Error class re-exported from the `fbp` package. Useful for callers that
 * want to `instanceof`-check syntax failures.
 */
export const FbpSyntaxError: new (...args: unknown[]) => Error =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fbp as any).SyntaxError;
