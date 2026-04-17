export function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Redacts a Kolega token so only the prefix and the first 5 chars of the
 * random suffix remain: `kcp_live_…abc12`. Used in `kolega auth status` and
 * anywhere we want to confirm the token without leaking it.
 */
export function redactToken(token: string): string {
  const match = /^(kcp_[a-z]+_)(.{0,})$/.exec(token);
  if (!match) {
    return `${token.slice(0, 4)}…`;
  }
  const prefix = match[1] ?? "";
  const suffix = match[2] ?? "";
  return `${prefix}…${suffix.slice(0, 5)}`;
}

/**
 * Draws a simple unicode box around a block of text. Used for the device-flow
 * user_code display so the user can visually verify the code matches what the
 * browser shows them. Box width adjusts to the widest line.
 */
export function box(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const horizontal = "─".repeat(width + 2);
  const top = `┌${horizontal}┐`;
  const bottom = `└${horizontal}┘`;
  const middle = lines.map((l) => `│ ${l.padEnd(width, " ")} │`).join("\n");
  return `${top}\n${middle}\n${bottom}`;
}
