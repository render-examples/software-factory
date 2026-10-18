import type { Child } from "hono/jsx";

const CSS = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #1a1a1a; line-height: 1.5; }
	a { color: #0066cc; text-decoration: none; }
	a:hover { text-decoration: underline; }
	.container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
	nav { background: #1a1a2e; color: #fff; padding: 0.75rem 1rem; display: flex; gap: 1.5rem; align-items: center; }
	nav a { color: #93c5fd; }
	nav .brand { font-weight: 600; color: #fff; }
	nav form { margin-left: auto; }
	nav button { background: none; border: none; color: #93c5fd; cursor: pointer; font-size: 0.875rem; }
	table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 1rem; }
	th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.875rem; vertical-align: top; }
	th { background: #f1f5f9; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
	.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; background: #f3f4f6; color: #374151; }
	.badge-running, .badge-started { background: #dbeafe; color: #1e40af; }
	.badge-done, .badge-ok { background: #d1fae5; color: #065f46; }
	.badge-failed, .badge-rejected, .badge-invalid, .badge-error { background: #fee2e2; color: #991b1b; }
	.badge-ignored { background: #fef3c7; color: #92400e; }
	.card { background: #fff; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	.totals { display: flex; gap: 2rem; flex-wrap: wrap; }
	.totals div { display: flex; flex-direction: column; }
	.totals strong { font-size: 1.1rem; }
	h1, h2 { margin-bottom: 0.75rem; }
	h1 { font-size: 1.5rem; word-break: break-all; }
	h2 { font-size: 1.15rem; }
	.meta { color: #64748b; font-size: 0.8rem; }
	.mono, .cost { font-family: ui-monospace, monospace; font-size: 0.8rem; }
	.detail { color: #64748b; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; }
	form.filter { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
	form.filter input, form.filter button { padding: 0.35rem 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.875rem; }
	form.filter button { background: #0066cc; color: #fff; border: none; cursor: pointer; }
	.pager { margin: 0.5rem 0 1rem; }
	.login-box { max-width: 360px; margin: 4rem auto; }
	.login-box input[type=password], .login-box button { display: block; width: 100%; padding: 0.5rem; margin-bottom: 0.75rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 1rem; }
	.login-box button { background: #0066cc; color: #fff; border: none; cursor: pointer; }
	.error-msg { color: #dc2626; font-size: 0.875rem; margin-bottom: 0.5rem; }
	.empty { color: #94a3b8; text-align: center; padding: 2rem; }
`;

function Page(props: { title: string; children: Child }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex" />
				<title>{props.title} — software factory</title>
				<style>{CSS}</style>
			</head>
			<body>{props.children}</body>
		</html>
	);
}

export function Layout(props: { title: string; children: Child }) {
	return (
		<Page title={props.title}>
			<nav>
				<span class="brand">software factory</span>
				<a href="/ui">Traces</a>
				<a href="/ui/deliveries">Deliveries</a>
				<form method="post" action="/ui/logout">
					<button type="submit">Log out</button>
				</form>
			</nav>
			<div class="container">{props.children}</div>
		</Page>
	);
}

export function LoginPage(props: { next: string; error?: boolean }) {
	return (
		<Page title="Log in">
			<div class="container">
				<div class="card login-box">
					<h1>software factory</h1>
					{props.error && <p class="error-msg">Invalid token. Try again.</p>}
					<form method="post" action="/ui/login">
						<input type="hidden" name="next" value={props.next} />
						<input type="password" name="token" placeholder="FACTORY_ADMIN_TOKEN" autocomplete="current-password" required />
						<button type="submit">Log in</button>
					</form>
				</div>
			</div>
		</Page>
	);
}
