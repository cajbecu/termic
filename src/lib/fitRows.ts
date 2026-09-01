/** Rows a multi-line textarea needs so its PLACEHOLDER is not cut off.
 *
 *  These fields use `field-sizing: content`, which sizes to the content and
 *  therefore treats an empty field as zero lines: the box collapses to its
 *  `rows` floor and a three- or five-line placeholder scrolls inside it. The
 *  fields only look right once you have typed something, which is backwards,
 *  because the placeholder is doing its most important work while the field is
 *  still empty. Several of these placeholders ARE the agent's live built-in
 *  patterns, so a clipped one hides the thing it exists to show.
 *
 *  Counting both sides keeps this correct if `field-sizing` is ever dropped,
 *  and the cap stops a long inherited pattern list from turning one field into
 *  the whole settings page. */
export function fitRows(value: string, placeholder: string | undefined, max = 8): number {
  const lines = (s: string) => (s ? s.split("\n").length : 0);
  return Math.min(max, Math.max(2, lines(value), lines(placeholder ?? "")));
}
