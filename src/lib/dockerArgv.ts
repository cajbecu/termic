// Rendering a `docker run` argv for humans.
//
// The argv arrives one token per element, which is what `docker run` wants
// and what a reader does NOT: printed verbatim, one element per line, `-v`
// sits on its own line and the path it mounts on the next, so the two things
// a reader is actually checking (which host paths are exposed, which env the
// agent sees) end up split across pairs of lines. Every flag is joined to the
// value it belongs to instead, one mount or one variable per line.

/** Whether `tok` looks like a flag rather than a value. */
const isFlag = (tok: string) => tok.startsWith("-");

/**
 * Flags that take NO value. Needed because "the next token is not a flag"
 * is not enough on its own: the image name is not a flag either, so a
 * valueless flag sitting immediately before it (`docker run --rm img cmd`)
 * would swallow the image. We render this argv ourselves, so the set is
 * knowable rather than guessed; anything unlisted is assumed to take a value,
 * which is the safe direction (an unknown valueless flag merely borrows the
 * image onto its line, it never hides a mount).
 */
const VALUELESS = new Set([
  "--rm", "-i", "-t", "-d", "--detach", "--init", "--privileged",
  "--read-only", "--no-healthcheck", "--interactive", "--tty",
]);

/**
 * Group a `docker run` argv into readable lines: `docker run` first, then one
 * flag-with-its-value per line, then the image and the agent command together
 * on the last line (that pairing is the point: it shows what actually runs
 * inside the container).
 *
 * Valueless flags (`--rm`, `-i`, `-t`) keep a line each, since the next token
 * is another flag. A value that itself starts with `-` cannot be mistaken for
 * one, because flags only ever pair with the token immediately after them and
 * real values here are `KEY=…` or a path.
 */
export function dockerArgvLines(argv: string[]): string[] {
  const lines: string[] = [];
  let i = 0;
  // `docker run` opens the command; keep the subcommand with the binary.
  if (argv.length >= 2 && !isFlag(argv[0]) && !isFlag(argv[1])) {
    lines.push(`${argv[0]} ${argv[1]}`);
    i = 2;
  } else if (argv.length > 0) {
    lines.push(argv[0]);
    i = 1;
  }
  while (i < argv.length) {
    const tok = argv[i];
    if (!isFlag(tok)) {
      // First positional ends the flag block: everything left is the image
      // plus the command it runs, and belongs together.
      lines.push(argv.slice(i).join(" "));
      break;
    }
    const next = argv[i + 1];
    if (!VALUELESS.has(tok) && next !== undefined && !isFlag(next)) {
      lines.push(`${tok} ${next}`);
      i += 2;
    } else {
      lines.push(tok);
      i += 1;
    }
  }
  return lines;
}

/** `dockerArgvLines` as one shell-style block, continuations indented. */
export function formatDockerArgv(argv: string[]): string {
  return dockerArgvLines(argv)
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join(" \\\n");
}
