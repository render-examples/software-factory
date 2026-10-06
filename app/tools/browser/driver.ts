/**
 * Browser driver script template. Uploaded to the sandbox and run as a
 * persistent process. Accepts JSON commands on stdin (one per line)
 * and writes JSON responses to stdout.
 *
 * The driver enforces an origin allowlist so even a prompt-injected
 * agent cannot navigate outside the permitted origins.
 */

/** Returns the Node.js script that runs Playwright inside the sandbox. */
export function browserDriverScript(allowedOrigins: readonly string[]): string {
	const origins = JSON.stringify(allowedOrigins);
	return `#!/usr/bin/env node
const { chromium } = require('playwright-core');
const readline = require('readline');

const ALLOWED_ORIGINS = ${origins};

function checkOrigin(url) {
  try {
    const origin = new URL(url).origin;
    return ALLOWED_ORIGINS.some(a => a === origin);
  } catch { return false; }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let page = await context.newPage();

  // Block cross-origin navigation
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      const url = frame.url();
      if (url !== 'about:blank' && !checkOrigin(url)) {
        await page.goBack().catch(() => {});
      }
    }
  });

  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    let cmd;
    try { cmd = JSON.parse(line); } catch (e) {
      console.log(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    try {
      const result = await handleCommand(page, cmd);
      console.log(JSON.stringify(result));
    } catch (e) {
      console.log(JSON.stringify({ error: e.message || String(e) }));
    }
  });

  async function handleCommand(pg, cmd) {
    switch (cmd.action) {
      case 'open': {
        if (!checkOrigin(cmd.url)) return { error: 'Navigation blocked: origin not allowed' };
        await pg.goto(cmd.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { url: pg.url(), title: await pg.title() };
      }
      case 'click': {
        await pg.click(cmd.selector, { timeout: 10000 });
        return { ok: true };
      }
      case 'fill': {
        await pg.fill(cmd.selector, cmd.value, { timeout: 10000 });
        return { ok: true };
      }
      case 'press': {
        await pg.keyboard.press(cmd.key);
        return { ok: true };
      }
      case 'snapshot': {
        const tree = await pg.accessibility.snapshot();
        return { snapshot: tree };
      }
      case 'screenshot': {
        const buf = await pg.screenshot({ fullPage: !!cmd.fullPage });
        return { base64: buf.toString('base64') };
      }
      case 'console': {
        // Return nothing — console messages are not buffered in this driver
        return { messages: [] };
      }
      default:
        return { error: 'Unknown action: ' + cmd.action };
    }
  }
})();
`;
}
