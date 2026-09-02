export interface Rule {
	pattern: RegExp;
	label: string;
}

/** Matched against serialized tool input, so quoting tricks still trip them. */
export const RULES: Rule[] = [
	{
		pattern:
			/\brm\b[^|;]*(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\b[^|;]*-f\b|-f\b[^|;]*-r\b|--recursive\b[^|;]*--force\b|--force\b[^|;]*--recursive\b)[^|;]*(?:\/(?:[\s";)|&]|$)|~)/,
		label: "recursive forced deletion of root or home",
	},
	{
		pattern: /\bgit\s+push\b.*(?:--force\b|-[^\s]*f\b)/,
		label: "git force push",
	},
	{
		pattern: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i,
		label: "destructive SQL statement",
	},
	{ pattern: /\bmkfs\b/, label: "filesystem format" },
	{ pattern: /\bdd\b.*\bif=/, label: "raw disk write (dd)" },
	{
		pattern: />\s*\/dev\/(?:sd|nvme|vd|xvd)/,
		label: "redirect to block device",
	},
	{
		pattern: /\bchmod\b.*(?:777|a\+rwx)\s+\//,
		label: "chmod world-writable on root path",
	},
	{
		pattern:
			/\bcurl\b.*(?:--data\b|-[^\s]*d\b|-X\s*(?:POST|PUT)\b).*(?:GITHUB_TOKEN|ANTHROPIC_API_KEY|RENDER_API_KEY|DATABASE_URL)/i,
		label: "potential secret exfiltration via curl",
	},
	{
		pattern: /\bwget\b.*--post/i,
		label: "potential exfiltration via wget POST",
	},
	{
		pattern: /\bbase64\b.*(?:-d|--decode)\b.*\|\s*(?:sh\b|bash\b|zsh\b)/,
		label: "base64-decoded shell execution",
	},
	{ pattern: /\beval\b.*\$\(/, label: "eval with command substitution" },
	{
		pattern: /\bcurl\b.*\|\s*(?:sh\b|bash\b|zsh\b|source\b)/,
		label: "piped remote shell execution",
	},
	{
		pattern: /\bwget\b.*-O\s*-.*\|\s*(?:sh\b|bash\b|zsh\b)/,
		label: "piped remote shell execution via wget",
	},
];
