/**
 * Resolve a selector with optional scoping and nth-match support.
 * Uses Playwright's native >> combinator and nth= pseudo-selector.
 */
export function resolveSelector(selector: string, nth?: number, withinSelector?: string): string {
  let s = selector;
  if (withinSelector) s = `${withinSelector} >> ${s}`;
  if (nth !== undefined) s = `${s} >> nth=${nth}`;
  return s;
}
