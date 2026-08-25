/**
 * Slack speaks mrkdwn, not Markdown. The agent writes ordinary Markdown, so
 * without conversion every reply shows literal `**` and raw link syntax.
 * Fenced code blocks pass through untouched (Slack renders them natively).
 */

export const MAX_SECTION_TEXT = 2900;

export function toMrkdwn(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment) => (segment.startsWith("```") ? segment : convertProse(segment)))
    .join("")
    .trimEnd();
}

const CODE_MARK = "\u0000";
const BOLD_MARK = "\u0001";
const HEADING_MARK = "\u0002";

function convertProse(text: string): string {
  const inlineCode: string[] = [];
  let output = text.replace(/`[^`\n]+`/g, (match) => {
    inlineCode.push(match);
    return `${CODE_MARK}${inlineCode.length - 1}${CODE_MARK}`;
  });

  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");

  const bold: string[] = [];
  const stash = (_match: string, inner: string): string => {
    bold.push(inner);
    return `${BOLD_MARK}${bold.length - 1}${BOLD_MARK}`;
  };
  output = output.replace(/\*\*([^*\n]+)\*\*/g, stash).replace(/__([^_\n]+)__/g, stash);

  output = output
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1_$2_")
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, `${HEADING_MARK}$1${HEADING_MARK}`)
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "──────────");

  return output
    .replace(new RegExp(`${HEADING_MARK}(.+?)${HEADING_MARK}`, "g"), "*$1*")
    .replace(
      new RegExp(`${BOLD_MARK}(\\d+)${BOLD_MARK}`, "g"),
      (_match, index: string) => `*${bold[Number(index)] ?? ""}*`,
    )
    .replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"), (_match, index: string) => inlineCode[Number(index)] ?? "");
}

/**
 * Trim to Slack's block limit on a line boundary so truncation doesn't
 * end mid-word.
 */
export function clampForSlack(text: string, max = MAX_SECTION_TEXT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 20);
  const lastBreak = head.lastIndexOf("\n");
  const body = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return `${body}\n… _(truncated)_`;
}

export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
