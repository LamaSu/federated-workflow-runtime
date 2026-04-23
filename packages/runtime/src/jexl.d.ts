/**
 * Minimal ambient module declaration for jexl (2.3.0). The package
 * doesn't ship TypeScript types. We declare the surface we actually
 * use in `when-eval.ts` — adding more members is fine, but keep them
 * consistent with the CJS runtime shape (`module.exports = new Jexl()`).
 */
declare module "jexl" {
  interface JexlTransform {
    (...args: unknown[]): unknown;
  }
  interface JexlInstance {
    eval(expr: string, context?: unknown): Promise<unknown>;
    addTransform(name: string, fn: JexlTransform): void;
    expr(strings: TemplateStringsArray, ...values: unknown[]): unknown;
  }
  const jexl: JexlInstance;
  export default jexl;
}
