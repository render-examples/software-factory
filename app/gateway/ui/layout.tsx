import type { Child } from "hono/jsx";

const CSS = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #1a1a1a; line-height: 1.5; }
	a { color: #0066cc; text-decoration: none; }
	a:hover { text-decoration: underline; }
	.container { max-width: 1100px; margin: 0 auto; padding: 1rem; }
	nav { background: #1a1a2e; color: #fff; padding: 0.75rem 1rem; display: flex; gap: 1.5rem; align-items: center; }
	nav a { color: #93c5fd; }
	nav .brand { font-weight: 600; color: #fff; }
	table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.875rem; }
	th { background: #f1f5f9; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
	.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
	.badge-queued { background: #fef3c7; color: #92400e; }
	.badge-dispatched { background: #e0e7ff; color: #3730a3; }
	.badge-running { background: #dbeafe; color: #1e40af; }
	.badge-completed { background: #d1fae5; color: #065f46; }
	.badge-failed { background: #fee2e2; color: #991b1b; }
	.badge-cancelled { background: #f3f4f6; color: #374151; }
	.card { background: #fff; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	h1, h2, h3 { margin-bottom: 0.75rem; }
	h1 { font-size: 1.5rem; }
	h2 { font-size: 1.25rem; }
	h3 { font-size: 1rem; }
	.meta { color: #64748b; font-size: 0.8rem; }
	.mono { font-family: ui-monospace, monospace; font-size: 0.8rem; }
	form.filter { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
	form.filter select, form.filter input, form.filter button { padding: 0.35rem 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.875rem; }
	form.filter button { background: #0066cc; color: #fff; border: none; cursor: pointer; }
	.span-tree { padding-left: 1.25rem; border-left: 2px solid #e2e8f0; }
	.span-item { margin: 0.35rem 0; }
	.span-label { font-weight: 500; }
	.span-dur { color: #64748b; font-size: 0.8rem; margin-left: 0.5rem; }
	.span-point { color: #8b5cf6; }
	.conversation { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
	.conversation a { padding: 0.25rem 0.5rem; border-radius: 4px; background: #f1f5f9; font-size: 0.8rem; }
	.conversation a.current { background: #0066cc; color: #fff; }
	.cost { font-family: ui-monospace, monospace; }
	.login-box { max-width: 360px; margin: 4rem auto; }
	.login-box input[type=password], .login-box button { display: block; width: 100%; padding: 0.5rem; margin-bottom: 0.75rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 1rem; }
	.login-box button { background: #0066cc; color: #fff; border: none; cursor: pointer; }
	.error-msg { color: #dc2626; font-size: 0.875rem; margin-bottom: 0.5rem; }
	.screenshot { max-width: 100%; border: 1px solid #e2e8f0; border-radius: 4px; margin: 0.5rem 0; }
	pre.transcript { background: #f8f9fa; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
	.empty { color: #94a3b8; text-align: center; padding: 2rem; }
`;

export function Layout(props: { title: string; children: Child }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{props.title} — render-factory</title>
				<style>{CSS}</style>
			</head>
			<body>
				<nav>
					<span class="brand">render-factory</span>
					<a href="/ui">Runs</a>
					<a href="/ui/deliveries">Deliveries</a>
					<form method="post" action="/ui/logout" style="margin-left:auto">
						<button
							type="submit"
							style="background:none;border:none;color:#93c5fd;cursor:pointer;font-size:0.875rem"
						>
							Logout
						</button>
					</form>
				</nav>
				<div class="container">{props.children}</div>
			</body>
		</html>
	);
}
