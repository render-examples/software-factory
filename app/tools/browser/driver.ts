/**
 * Browser driver script template. Uploaded to the sandbox and run as a
 * persistent background HTTP server. Tools send JSON commands via curl.
 *
 * The driver enforces an origin allowlist using context.route() to abort
 * any navigation request targeting a disallowed origin (covers redirects).
 * Console messages are buffered and returned by the 'console' command.
 */

export const BROWSER_DIR = "/opt/factory-browser";
export const DRIVER_PATH = `${BROWSER_DIR}/driver.js`;
export const DRIVER_PORT = 9222;
export const DRIVER_LOG = "/tmp/factory-browser.log";

/** Returns the Node.js script that runs Playwright inside the sandbox. */
export function browserDriverScript(allowedOrigins: readonly string[]): string {
	const origins = JSON.stringify(allowedOrigins);
	return `#!/usr/bin/env node
const http = require('http');
const { chromium } = require(${JSON.stringify(`${BROWSER_DIR}/node_modules/playwright-core`)});

const ALLOWED_ORIGINS = ${origins};
const PORT = ${DRIVER_PORT};
const consoleBuffer = [];

function isOriginAllowed(url) {
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

  // Block navigation requests to disallowed origins (covers redirects).
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.isNavigationRequest()) {
      const url = req.url();
      if (url !== 'about:blank' && !isOriginAllowed(url)) {
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    consoleBuffer.push(msg.type() + ': ' + msg.text());
    if (consoleBuffer.length > 200) consoleBuffer.shift();
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    let cmd;
    try { cmd = JSON.parse(body); } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    try {
      const result = await handleCommand(page, cmd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('factory-browser listening on 127.0.0.1:' + PORT);
  });

  async function handleCommand(pg, cmd) {
    switch (cmd.action) {
      case 'open': {
        if (!isOriginAllowed(cmd.url)) return { error: 'Navigation blocked: origin not allowed' };
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
        const tree = await pg.locator('body').ariaSnapshot();
        return { snapshot: tree };
      }
      case 'screenshot': {
        const buf = await pg.screenshot({ fullPage: !!cmd.fullPage });
        return { base64: buf.toString('base64') };
      }
      case 'console': {
        const msgs = consoleBuffer.splice(0);
        return { messages: msgs };
      }
      default:
        return { error: 'Unknown action: ' + cmd.action };
    }
  }
})();
`;
}
