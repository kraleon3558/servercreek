/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const ALLOWED_ORIGINS = [
	"https://www.supercreek.moe",
	"https://supercreek.moe",
];

// Matches localhost with any port
const LOCALHOST_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// naive rate limit
const MAX_INCREMENT_PER_REQUEST = 300;

export default {
	async fetch(request, env) {
		const origin = request.headers.get("Origin");

		// Origin gate
		// blocks *browsers* on other sites from using your API.
		// It does NOT stop curl/scripts (Origin is spoofable outside a
		// browser). For a public novelty counter that's an acceptable
		// tradeoff — just don't mistake this for real auth.
		if (!isOriginAllowed(origin, env)) {
			return new Response("Forbidden", { status: 403 });
		}

		const cors = buildCorsHeaders(origin);

		// CORS preflight 
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: cors });
		}

		// Routing
		const url = new URL(request.url);
		if (url.pathname === "/api/v1/mun" && request.method === "POST") {
			return handleMun(request, env, cors);
		}

		return new Response("Not Found", { status: 404, headers: cors });
	},
};

// --------------------------------------------------------------------

function isOriginAllowed(origin, env) {
	if (!origin) return false;
	if (ALLOWED_ORIGINS.includes(origin)) return true;

	// Only honour localhost when explicitly enabled (see .dev.vars)
	if (env.ALLOW_LOCALHOST === "true" && LOCALHOST_RE.test(origin)) {
		return true;
	}
	return false;
}

function buildCorsHeaders(origin) {
	return {
		// Echo the validated origin rather than '*' — required because
		// we vary the response by origin and may add credentials later.
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
		// Critical: tells caches the response differs per Origin,
		// otherwise a CDN could leak one origin's CORS header to another.
		"Vary": "Origin",
	};
}

async function handleMun(request, env, cors) {
	// --- Parse & validate input --------------------------------------
	let increment;
	try {
		// The forked frontend doesn't set Content-Type (so it arrives as
		// text/plain). request.json() ignores the header and just parses
		// the body, so this works — and conveniently avoids a preflight.
		const body = await request.json();
		const raw = Number(body?.muns);

		if (!Number.isFinite(raw) || raw < 0) {
			increment = 0;
		} else {
			increment = Math.min(Math.floor(raw), MAX_INCREMENT_PER_REQUEST);
		}
	} catch {
		return json({ error: "Invalid JSON body" }, 400, cors);
	}

	// --- Persist ------------------------------------------------------
	try {
		let total;

		if (increment > 0) {
			// Atomic upsert + read in one round-trip.
			// RETURNING gives us the post-increment value without a
			// separate SELECT (avoids a read-modify-write race).
			const row = await env.DB
				.prepare(
					`INSERT INTO counters (name, value) VALUES ('muns', ?1)
           ON CONFLICT(name) DO UPDATE SET value = value + ?1
           RETURNING value`
				)
				.bind(increment)
				.first();
			total = row.value;
		} else {
			// The frontend polls every 3s even with zero clicks. Taking a
			// read-only path here keeps us under D1's free write quota.
			const row = await env.DB
				.prepare(`SELECT value FROM counters WHERE name = 'muns'`)
				.first();
			total = row?.value ?? 0;
		}

		return json({ muns: total }, 200, cors);
	} catch (err) {
		console.error("D1 error:", err);
		return json({ error: "Internal server error" }, 500, cors);
	}
}

function json(body, status, cors) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...cors },
	});
}