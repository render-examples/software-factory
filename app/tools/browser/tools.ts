import { randomBytes } from "node:crypto";
import { z } from "zod";
import { checkBrowserNavigation } from "../../policy/browser.js";
import { shellEscape } from "../../shell/index.js";
import { putArtifact } from "../../store/index.js";
import type { Tool, ToolResult } from "../types.js";
import {
	browserDriverScript,
	BROWSER_DIR,
	DRIVER_PATH,
	DRIVER_PORT,
	DRIVER_LOG,
} from "./driver.js";

export interface BrowserToolOptions {
	allowedOrigins: readonly string[];
	runId: string;
}

/** Build all browser tools bound to the given allowed origins. */
export function createBrowserTools(opts: BrowserToolOptions): Tool[] {
	return [
		browserOpen(opts),
		browserClick(opts),
		browserFill(opts),
		browserPress(opts),
		browserSnapshot(opts),
		browserScreenshot(opts),
		browserConsole(opts),
	];
}

const HEALTH_URL = `http://127.0.0.1:${DRIVER_PORT}/health`;
const COMMAND_URL = `http://127.0.0.1:${DRIVER_PORT}/`;

/**
 * Ensure the browser driver HTTP server is running inside the sandbox.
 * Starts it lazily on the first call; restarts if the health check fails.
 */
async function ensureDriver(
	ctx: {
		sandbox: import("../../sandbox/index.js").Sandbox;
		signal?: AbortSignal;
	},
	origins: readonly string[],
): Promise<void> {
	const health = await ctx.sandbox.run(
		`curl -sf ${shellEscape(HEALTH_URL)} 2>/dev/null && echo ok || echo fail`,
	);
	if (health.output.trim() === "ok") return;

	const script = browserDriverScript(origins);
	await ctx.sandbox.mustRun(
		`mkdir -p ${shellEscape(BROWSER_DIR)}`,
		"Create browser directory",
	);
	await ctx.sandbox.writeFile(DRIVER_PATH, script);
	await ctx.sandbox.mustRun(
		`chmod +x ${shellEscape(DRIVER_PATH)}`,
		"Make driver executable",
	);
	await ctx.sandbox.run(
		`nohup node ${shellEscape(DRIVER_PATH)} > ${shellEscape(DRIVER_LOG)} 2>&1 &`,
	);

	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
		const check = await ctx.sandbox.run(
			`curl -sf ${shellEscape(HEALTH_URL)} 2>/dev/null && echo ok || echo fail`,
		);
		if (check.output.trim() === "ok") return;
	}
	throw new Error("Browser driver did not start within 30 seconds");
}

/** Send a JSON command to the driver HTTP server. */
async function driverCommand(
	ctx: {
		sandbox: import("../../sandbox/index.js").Sandbox;
		signal?: AbortSignal;
	},
	origins: readonly string[],
	command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	await ensureDriver(ctx, origins);
	const json = JSON.stringify(command);
	const tmpFile = `/tmp/browser-cmd-${randomBytes(4).toString("hex")}.json`;
	await ctx.sandbox.writeFile(tmpFile, json);
	const { output, exitCode } = await ctx.sandbox.run(
		`curl -sf --data-binary @${shellEscape(tmpFile)} ${shellEscape(COMMAND_URL)} && rm -f ${shellEscape(tmpFile)}`,
		{ signal: ctx.signal },
	);
	if (exitCode !== 0) {
		throw new Error(
			`Browser driver error (exit ${exitCode}): ${output.slice(0, 500)}`,
		);
	}
	try {
		return JSON.parse(output.trim()) as Record<string, unknown>;
	} catch {
		throw new Error(
			`Browser driver returned invalid JSON: ${output.slice(0, 200)}`,
		);
	}
}

function browserOpen(opts: BrowserToolOptions): Tool {
	const schema = {
		url: z.string().describe("URL to navigate to."),
	};
	return {
		name: "browser_open",
		description:
			"Navigate the browser to a URL. Navigation is restricted to allowed origins.",
		inputSchema: schema,
		async invoke(input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const url = String(input.url ?? "");
			const violation = checkBrowserNavigation(url, opts.allowedOrigins);
			if (violation) return { content: violation, isError: true };
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "open",
				url,
			});
			if (result.error) return { content: String(result.error), isError: true };
			return { content: `Navigated to ${result.url} — "${result.title}"` };
		},
	};
}

function browserClick(opts: BrowserToolOptions): Tool {
	const schema = {
		selector: z.string().describe("CSS selector or text selector to click."),
	};
	return {
		name: "browser_click",
		description: "Click an element on the page.",
		inputSchema: schema,
		async invoke(input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "click",
				selector: String(input.selector ?? ""),
			});
			if (result.error) return { content: String(result.error), isError: true };
			return { content: "Clicked." };
		},
	};
}

function browserFill(opts: BrowserToolOptions): Tool {
	const schema = {
		selector: z.string().describe("CSS selector for the input field."),
		value: z.string().describe("Value to fill."),
	};
	return {
		name: "browser_fill",
		description: "Fill a text field with a value.",
		inputSchema: schema,
		async invoke(input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "fill",
				selector: String(input.selector ?? ""),
				value: String(input.value ?? ""),
			});
			if (result.error) return { content: String(result.error), isError: true };
			return { content: "Filled." };
		},
	};
}

function browserPress(opts: BrowserToolOptions): Tool {
	const schema = {
		key: z.string().describe("Key to press (e.g. 'Enter', 'Tab')."),
	};
	return {
		name: "browser_press",
		description: "Press a keyboard key.",
		inputSchema: schema,
		async invoke(input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "press",
				key: String(input.key ?? ""),
			});
			if (result.error) return { content: String(result.error), isError: true };
			return { content: "Key pressed." };
		},
	};
}

function browserSnapshot(opts: BrowserToolOptions): Tool {
	return {
		name: "browser_snapshot",
		description: "Get the accessibility tree of the current page.",
		inputSchema: {},
		async invoke(_input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "snapshot",
			});
			if (result.error) return { content: String(result.error), isError: true };
			const snap =
				typeof result.snapshot === "string"
					? result.snapshot
					: JSON.stringify(result.snapshot, null, 2);
			return { content: snap.slice(0, 40_000) };
		},
	};
}

function browserScreenshot(opts: BrowserToolOptions): Tool {
	const schema = {
		fullPage: z.boolean().optional().describe("Capture the full page."),
	};
	return {
		name: "browser_screenshot",
		description:
			"Take a screenshot of the current page. Returns the artifact ID and a link URL.",
		inputSchema: schema,
		async invoke(input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "screenshot",
				fullPage: Boolean(input.fullPage),
			});
			if (result.error) return { content: String(result.error), isError: true };

			const pngBytes = Buffer.from(String(result.base64), "base64");
			const linkToken = randomBytes(32).toString("hex");
			const artifact = await putArtifact({
				runId: opts.runId,
				kind: "screenshot",
				contentType: "image/png",
				bytes: pngBytes,
				linkToken,
			});
			const publicUrl = process.env.FACTORY_PUBLIC_URL?.trim();
			const linkUrl = publicUrl ? `${publicUrl}/a/${linkToken}` : undefined;

			return {
				content: JSON.stringify({
					artifactId: artifact.id,
					linkUrl,
					note: "Screenshot captured",
				}),
				images: [{ png: pngBytes }],
			};
		},
	};
}

function browserConsole(opts: BrowserToolOptions): Tool {
	return {
		name: "browser_console",
		description: "Read buffered browser console messages.",
		inputSchema: {},
		async invoke(_input: Record<string, unknown>, ctx): Promise<ToolResult> {
			const result = await driverCommand(ctx, opts.allowedOrigins, {
				action: "console",
			});
			if (result.error) return { content: String(result.error), isError: true };
			const messages = result.messages as string[];
			return {
				content:
					messages.length > 0 ? messages.join("\n") : "(no console messages)",
			};
		},
	};
}
