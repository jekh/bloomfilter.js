// bench/compare.mjs — fork-vs-upstream A/B benchmark.
//
// Method: equivalence prelude on the common API surface first (throws
// before any timing on disagreement), then interleaved best-of-N
// timing with warmup over a curated config matrix, with mask-path
// configs as controls that must read ~0. See BENCH.md.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORK_BUILT = join(ROOT, "bloomfilter.js");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
	const i = args.indexOf(f);
	if (i === -1 || i + 1 >= args.length) return null;
	return args[i + 1];
};
if (has("--help")) {
	console.log(`usage: node bench/compare.mjs [--full] [--xlarge]
       [--upstream <ref|path>] [--json <path>]
       [--report-only <path>] [--gate <pct>] [--rounds <n>]`);
	process.exit(0);
}
const OPTS = {
	full: has("--full"),
	xlarge: has("--xlarge"),
	upstream: val("--upstream"),
	json: val("--json"),
	reportOnly: val("--report-only"),
	gate: Number(val("--gate") ?? "6"),
	rounds: val("--rounds") === null ? null : Number(val("--rounds")),
};

function sh(cmd, argv) {
	try {
		return execFileSync(cmd, argv, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

// Resolve the upstream implementation to an importable file URL.
// An existing filesystem path is used as-is (null-test affordance:
// point both sides at the same file). Otherwise the spec is treated
// as a git ref and materialized via materializeBaseline (historical
// baseline: no worktree, no network). With no spec, the sha-pinned
// `bloomfilter-upstream` devDependency is imported by its bare
// specifier (its exports map serves the package root), so default
// bench time needs no network and no git remote.
async function loadSide(upstreamSpec, forkBuilt) {
	let upstreamUrl;
	let pin;
	let base = null;
	if (upstreamSpec) {
		let isFile = false;
		try {
			readFileSync(resolve(upstreamSpec));
			isFile = true;
		} catch {
			// Not a readable file; fall through to git-ref resolution.
		}
		if (isFile) {
			upstreamUrl = pathToFileURL(resolve(upstreamSpec)).href;
			pin = "n/a (path override)";
		} else {
			base = materializeBaseline(upstreamSpec);
			upstreamUrl = pathToFileURL(base.file).href;
			pin = `baseline@${base.sha}`;
		}
	} else {
		try {
			upstreamUrl = import.meta.resolve("bloomfilter-upstream");
		} catch {
			throw new Error(
				"cannot resolve devDependency 'bloomfilter-upstream'; run: pnpm install",
			);
		}
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		pin = pkg.devDependencies?.["bloomfilter-upstream"] ?? "unknown";
	}
	const forkMod = await import(pathToFileURL(forkBuilt).href);
	const upMod = await import(upstreamUrl);
	for (const [label, mod] of [
		["fork", forkMod],
		["upstream", upMod],
	]) {
		if (typeof mod.BloomFilter !== "function") {
			throw new Error(`${label} module does not export BloomFilter`);
		}
	}
	return {
		Fork: forkMod.BloomFilter,
		Up: upMod.BloomFilter,
		pin,
		nullMode: upstreamUrl === pathToFileURL(resolve(forkBuilt)).href,
		base,
	};
}

function hasMethod(cls, name) {
	return typeof cls.prototype[name] === "function";
}

// Materialize the fork implementation at a git ref as a runnable module
// for the baseline arm, without touching the working tree: `git show`
// the single-file lib into a temp dir, then compile .ts with this repo's
// own toolchain (a bare .js ref is used as-is). The temp dir is removed
// by the process-exit cleanup below on every exit path.
let baselineDir = null;
process.on("exit", () => {
	if (baselineDir !== null) {
		try {
			rmSync(baselineDir, { recursive: true, force: true });
		} catch {
			// best-effort temp cleanup at process exit
		}
	}
});

export function materializeBaseline(ref) {
	const sha = sh("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
	if (sha === null) {
		throw new Error(`--upstream: unknown git ref '${ref}'`);
	}
	let kind = null;
	for (const p of ["bloomfilter.ts", "bloomfilter.js"]) {
		if (sh("git", ["cat-file", "-e", `${sha}:${p}`]) !== null) {
			kind = p;
			break;
		}
	}
	if (kind === null) {
		throw new Error(
			`--upstream: neither bloomfilter.ts nor bloomfilter.js exists at '${ref}'`,
		);
	}
	const dir = mkdtempSync(join(tmpdir(), "bloom-baseline-"));
	baselineDir = dir;
	writeFileSync(
		join(dir, kind),
		execFileSync("git", ["show", `${sha}:${kind}`], { cwd: ROOT }),
	);
	writeFileSync(join(dir, "package.json"), '{"type": "module"}\n');
	let file;
	if (kind === "bloomfilter.ts") {
		const tsc = join(ROOT, "node_modules", "typescript", "lib", "tsc.js");
		if (!existsSync(tsc)) {
			throw new Error(
				"--upstream: building a .ts baseline needs the typescript devDependency (run pnpm install)",
			);
		}
		writeFileSync(
			join(dir, "tsconfig.json"),
			`${JSON.stringify(
				{
					extends: join(ROOT, "tsconfig.json"),
					compilerOptions: {
						typeRoots: [join(ROOT, "node_modules", "@types")],
						declaration: false,
					},
					include: ["bloomfilter.ts"],
				},
				null,
				2,
			)}\n`,
		);
		try {
			execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], {
				cwd: ROOT,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			const detail = e.stderr?.toString() ?? e.message ?? String(e);
			throw new Error(
				`--upstream: tsc failed on bloomfilter.ts at '${ref}':\n${detail}`,
			);
		}
		file = join(dir, "bloomfilter.js");
	} else {
		file = join(dir, kind);
	}
	if (!existsSync(file)) {
		throw new Error(`--upstream: build produced no module at '${ref}'`);
	}
	return { dir, file, sha, short: sha.slice(0, 12) };
}

// Item-count rounds pin explicit (m,k) at constant load (~19.2
// bits/item at p=1e-4: m = ceil(-n*ln(p)/(ln2)^2/32)*32, k = 13), so
// both sides build identical filters. Micro-op configs use tiny m at
// deliberately unrealistic load: they measure rates, not realism.
const ROUNDS = [
	{ tag: "small-10k", n: 10000, m: 191712, k: 13, queries: 10000, reps: 7 },
	{
		tag: "medium-100k",
		n: 100000,
		m: 1917024,
		k: 13,
		queries: 100000,
		reps: 5,
	},
	{
		tag: "large-1M",
		n: 1000000,
		m: 19170144,
		k: 13,
		queries: 100000,
		reps: 3,
		chunked: true,
		fullOnly: true,
	},
	{
		tag: "xlarge-10M",
		n: 10000000,
		m: 191701152,
		k: 13,
		queries: 100000,
		xlargeOnly: true,
		singlePass: true,
	},
];
const MICRO = [
	{ tag: "tight2400-k16", m: 2400, k: 16, n: 100000 },
	{ tag: "tight640-k4", m: 640, k: 4, n: 100000 },
	{ tag: "tight320-k4", m: 320, k: 4, n: 100000 },
	{ tag: "tight96-k7", m: 96, k: 7, n: 100000 },
	{ tag: "tight2400-k1", m: 2400, k: 1, n: 100000 },
	{ tag: "mask1024-k4", m: 1024, k: 4, n: 100000, control: true },
	{ tag: "mask4096-k16", m: 4096, k: 16, n: 100000, control: true },
	{ tag: "tight2400-k16-longkey", m: 2400, k: 16, n: 10000, longKey: true },
];
const keyOf = (cfg, i) =>
	cfg.longKey ? `long-key-${i}-${"x".repeat(200)}` : `k${i}`;
const missOf = (cfg, i) =>
	cfg.longKey ? `missing-long-${i}-${"x".repeat(200)}` : `missing-zz-${i}`;

function assertSameBuckets(a, b, ctx) {
	const x = Array.from(a.buckets);
	const y = Array.from(b.buckets);
	if (x.length !== y.length || x.some((v, i) => v !== y[i])) {
		throw new Error(`equivalence failure (buckets): ${ctx}`);
	}
}

// Equivalence prelude: identical key streams must produce identical
// observable behavior on the common surface. Runs on micro configs
// plus the small round only — same code paths as larger sizes.
function equivalence(Fork, Up) {
	let locationsNote = false;
	const edgeKeys = ["", "0", "-0", "x".repeat(5000)];
	for (const cfg of [...MICRO, ROUNDS[0]]) {
		const f = new Fork(cfg.m, cfg.k);
		const u = new Up(cfg.m, cfg.k);
		if (f.m !== u.m || f.k !== u.k || f.buckets.length !== u.buckets.length) {
			throw new Error(`equivalence failure (geometry m=${cfg.m} k=${cfg.k})`);
		}
		const N = Math.min(cfg.n ?? 10000, 2000);
		for (let i = 0; i < N; ++i) {
			const key = keyOf(cfg, i);
			f.add(key);
			u.add(key);
		}
		for (const key of edgeKeys) {
			f.add(key);
			u.add(key);
		}
		assertSameBuckets(f, u, `m=${cfg.m} k=${cfg.k}`);
		for (let i = 0; i < N; ++i) {
			const key = keyOf(cfg, i);
			if (f.test(key) !== u.test(key)) {
				throw new Error(`equivalence failure (test hit m=${cfg.m} k=${cfg.k})`);
			}
		}
		// locations() is compared only when both sides implement it, so
		// --upstream <ref> runs against commits that predate the API still work.
		if (hasMethod(Fork, "locations") && hasMethod(Up, "locations")) {
			for (let i = 0; i < N; ++i) {
				const key = keyOf(cfg, i);
				if (
					Array.from(f.locations(key)).join(",") !==
					Array.from(u.locations(key)).join(",")
				) {
					throw new Error(
						`equivalence failure (locations m=${cfg.m} k=${cfg.k})`,
					);
				}
			}
		} else if (!locationsNote) {
			locationsNote = true;
			console.error("note: locations() missing on one side; skipping");
		}
		if (f.test("definitely-missing-zzz") !== u.test("definitely-missing-zzz")) {
			throw new Error(`equivalence failure (test miss m=${cfg.m} k=${cfg.k})`);
		}
		// Per-side deser round-trip (formats may differ; property, not equality).
		for (const [Cls, side] of [
			[Fork, "fork"],
			[Up, "upstream"],
		]) {
			if (hasMethod(Cls, "toJSON") && hasMethod(Cls, "fromJSON")) {
				const g = new Cls(cfg.m, cfg.k);
				g.add("round-trip-key");
				const back = Cls.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
				assertSameBuckets(g, back, `${side} fromJSON round-trip`);
			}
		}
	}
	console.log("equivalence prelude: OK");
}

// Interleaved best-of-N. reps==1 supports the gate-trip check.
function race(fnFork, fnUp, reps) {
	fnFork();
	fnUp();
	let bestFork = Infinity;
	let bestUp = Infinity;
	for (let r = 0; r < reps; ++r) {
		let t0 = performance.now();
		fnFork();
		bestFork = Math.min(bestFork, performance.now() - t0);
		t0 = performance.now();
		fnUp();
		bestUp = Math.min(bestUp, performance.now() - t0);
	}
	return [bestFork, bestUp];
}

// Chunked variant for large adds: sides alternate every CHUNK keys
// within each pass so thermal/affinity drift cannot favor one side.
// Keys are materialized inline (`k${i}`) so no key array is ever held.
const CHUNK = 10000;
function raceChunked(addForkRange, addUpRange, n, passes) {
	const chunks = Math.ceil(n / CHUNK);
	let bestFork = Infinity;
	let bestUp = Infinity;
	for (let p = 0; p < passes; ++p) {
		let accFork = 0;
		let accUp = 0;
		for (let c = 0; c < chunks; ++c) {
			const lo = c * CHUNK;
			const hi = Math.min(lo + CHUNK, n);
			let t0 = performance.now();
			addForkRange(lo, hi);
			accFork += performance.now() - t0;
			t0 = performance.now();
			addUpRange(lo, hi);
			accUp += performance.now() - t0;
		}
		bestFork = Math.min(bestFork, accFork);
		bestUp = Math.min(bestUp, accUp);
	}
	return [bestFork, bestUp];
}

function pushRow(rows, config, phase, n, forkMs, upMs, note) {
	const row = {
		config,
		phase,
		n,
		forkMs,
		upMs,
		deltaPct: ((upMs - forkMs) / upMs) * 100,
		forkNs: (forkMs * 1e6) / n,
		upNs: (upMs * 1e6) / n,
	};
	if (note !== undefined) row.note = note;
	rows.push(row);
}

function timeRounds(Fork, Up, rows, foe) {
	const repsOf = (def) => OPTS.rounds ?? def;
	// A/A calibration: same side on both arms. Must read ~0 in any
	// mode; measures this run's own noise floor on this machine.
	for (const [Cls, side] of [
		[Fork, "fork"],
		[Up, "upstream"],
	]) {
		const g = new Cls(2400, 16);
		const N = 20000;
		const [a, b] = race(
			() => {
				for (let i = 0; i < N; ++i) g.add(`k${i}`);
			},
			() => {
				for (let i = 0; i < N; ++i) g.add(`k${i}`);
			},
			repsOf(7),
		);
		pushRow(rows, "selfcheck", `add-${side}-vs-self`, N, a, b);
	}
	for (const cfg of MICRO) {
		const f = new Fork(cfg.m, cfg.k);
		const u = new Up(cfg.m, cfg.k);
		const R = repsOf(7);
		let [a, b] = race(
			() => {
				for (let i = 0; i < cfg.n; ++i) f.add(keyOf(cfg, i));
			},
			() => {
				for (let i = 0; i < cfg.n; ++i) u.add(keyOf(cfg, i));
			},
			R,
		);
		pushRow(rows, cfg.tag, "add", cfg.n, a, b);
		// Pure-call rows fold their results into an opaque accumulator so
		// the timed loop is never legally dead (P1 protocol). add() rows
		// need no fold: bucket writes are observable side effects.
		let fold = 0;
		[a, b] = race(
			() => {
				for (let i = 0; i < cfg.n; ++i) fold += f.test(keyOf(cfg, i)) ? 1 : 0;
			},
			() => {
				for (let i = 0; i < cfg.n; ++i) fold += u.test(keyOf(cfg, i)) ? 1 : 0;
			},
			R,
		);
		pushRow(rows, cfg.tag, "test-hit", cfg.n, a, b);
		[a, b] = race(
			() => {
				for (let i = 0; i < cfg.n; ++i) fold += f.test(missOf(cfg, i)) ? 1 : 0;
			},
			() => {
				for (let i = 0; i < cfg.n; ++i) fold += u.test(missOf(cfg, i)) ? 1 : 0;
			},
			R,
		);
		pushRow(rows, cfg.tag, "test-miss", cfg.n, a, b);
		if (fold === -1) console.log("unreachable");
	}
	// Batch APIs exist only on the fork: compare against fork per-key
	// loops (the P1c precedent), never against upstream.
	if (hasMethod(Fork, "addAll") && hasMethod(Fork, "testAll")) {
		const cfg = MICRO[0];
		const N = 100000;
		const keys = [];
		for (let i = 0; i < N; ++i) keys.push(`k${i}`);
		const R = repsOf(7);
		let [a, b] = race(
			() => {
				new Fork(cfg.m, cfg.k).addAll(keys);
			},
			() => {
				const g = new Fork(cfg.m, cfg.k);
				for (const key of keys) g.add(key);
			},
			R,
		);
		pushRow(rows, "batch2400-k16", "addAll-vs-loop", N, a, b, "fork-only");
		[a, b] = race(
			() => {
				new Fork(cfg.m, cfg.k).testAll(keys);
			},
			() => {
				const g = new Fork(cfg.m, cfg.k);
				for (const key of keys) g.test(key);
			},
			R,
		);
		pushRow(rows, "batch2400-k16", "testAll-vs-loop", N, a, b, "fork-only");
	}
	for (const r of ROUNDS) {
		if (r.xlargeOnly && !OPTS.xlarge) continue;
		if (r.fullOnly && !(OPTS.full || OPTS.xlarge)) continue;
		const f = new Fork(r.m, r.k);
		const u = new Up(r.m, r.k);
		if (r.singlePass) {
			console.error(`note: ${r.tag} is a single timed pass (noisy)`);
		}
		const passes = OPTS.rounds ?? (r.singlePass ? 1 : (r.reps ?? 7));
		let a;
		let b;
		if (r.chunked || r.singlePass) {
			if (r.singlePass) {
				for (let c = 0; c < Math.ceil(r.n / CHUNK); ++c) {
					const lo = c * CHUNK;
					const hi = Math.min(lo + CHUNK, r.n);
					for (let i = lo; i < hi; ++i) f.add(`k${i}`);
					for (let i = lo; i < hi; ++i) u.add(`k${i}`);
				}
			}
			[a, b] = raceChunked(
				(lo, hi) => {
					for (let i = lo; i < hi; ++i) f.add(`k${i}`);
				},
				(lo, hi) => {
					for (let i = lo; i < hi; ++i) u.add(`k${i}`);
				},
				r.n,
				passes,
			);
		} else {
			[a, b] = race(
				() => {
					for (let i = 0; i < r.n; ++i) f.add(`k${i}`);
				},
				() => {
					for (let i = 0; i < r.n; ++i) u.add(`k${i}`);
				},
				OPTS.rounds ?? r.reps,
			);
		}
		pushRow(rows, r.tag, "add", r.n, a, b);
		const q = r.queries;
		const qr = OPTS.rounds ?? 5;
		let fold = 0;
		[a, b] = race(
			() => {
				for (let i = 0; i < q; ++i) fold += f.test(`k${i}`) ? 1 : 0;
			},
			() => {
				for (let i = 0; i < q; ++i) fold += u.test(`k${i}`) ? 1 : 0;
			},
			qr,
		);
		pushRow(rows, r.tag, "test-hit", q, a, b);
		[a, b] = race(
			() => {
				for (let i = 0; i < q; ++i) fold += f.test(`missing-zz-${i}`) ? 1 : 0;
			},
			() => {
				for (let i = 0; i < q; ++i) fold += u.test(`missing-zz-${i}`) ? 1 : 0;
			},
			qr,
		);
		pushRow(rows, r.tag, "test-miss", q, a, b);
		if (fold === -1) console.log("unreachable");
	}
	// countBits on small plus the largest running round (linear demo).
	const countCfgs = [{ tag: "count-small", m: ROUNDS[0].m, k: ROUNDS[0].k }];
	const big = [...ROUNDS]
		.reverse()
		.find(
			(r) =>
				(!r.fullOnly || OPTS.full || OPTS.xlarge) &&
				(!r.xlargeOnly || OPTS.xlarge),
		);
	if (big !== undefined && big.tag !== "small-10k") {
		countCfgs.push({ tag: `count-${big.tag}`, m: big.m, k: big.k });
	}
	for (const c of countCfgs) {
		const f = new Fork(c.m, c.k);
		const u = new Up(c.m, c.k);
		for (let i = 0; i < 1000; ++i) {
			f.add(`k${i}`);
			u.add(`k${i}`);
		}
		const iters = Math.max(
			10,
			Math.min(1000, Math.floor(3000000 / (c.m / 32))),
		);
		let fold = 0;
		const [a, b] = race(
			() => {
				for (let i = 0; i < iters; ++i) fold += f.countBits();
			},
			() => {
				for (let i = 0; i < iters; ++i) fold += u.countBits();
			},
			OPTS.rounds ?? 7,
		);
		pushRow(rows, c.tag, "countBits", iters, a, b);
		if (fold === -1) console.log("unreachable");
	}
	// Deser: each side parses its own payload (formats may differ).
	for (const [Cls, side] of [
		[Fork, "fork"],
		[Up, foe],
	]) {
		if (hasMethod(Cls, "toJSON") && hasMethod(Cls, "fromJSON")) {
			const g = new Cls(ROUNDS[0].m, ROUNDS[0].k);
			g.add("payload-key");
			const payload = JSON.stringify(g.toJSON());
			const N = 500;
			const t0 = performance.now();
			for (let i = 0; i < N; ++i) Cls.fromJSON(JSON.parse(payload));
			const ms = performance.now() - t0;
			rows.push({
				config: `deser-small-${side}`,
				phase: "fromJSON",
				n: N,
				forkMs: side === "fork" ? ms : null,
				upMs: side === "fork" ? null : ms,
				deltaPct: null,
				forkNs: null,
				upNs: null,
				note: "single-side",
			});
		}
	}
}

function printTable(report) {
	const foe = report.foe ?? "upstream";
	console.log(
		`fork-vs-${foe} bench | node ${report.runtime.node} ${report.runtime.platform}/${report.runtime.arch} | pin ${report.pin ?? "n/a"} fork ${report.forkRef ?? "n/a"}${report.forkDirty ? " (dirty)" : ""} | ${report.timestamp}`,
	);
	for (const r of report.rows) {
		if (r.deltaPct === null) {
			const ms = (r.forkMs ?? r.upMs).toFixed(2);
			console.log(
				`${r.config} ${r.phase} x${r.n}: ${ms}ms (${r.note ?? "single-side"})`,
			);
			continue;
		}
		const d = r.deltaPct;
		if (r.note === "fork-only") {
			console.log(
				`${r.config} ${r.phase} x${r.n}: batch ${r.forkMs.toFixed(2)}ms vs per-key loop ${r.upMs.toFixed(2)}ms (${d >= 0 ? "+" : ""}${d.toFixed(1)}%) [fork-only]`,
			);
			continue;
		}
		console.log(
			`${r.config} ${r.phase} x${r.n}: fork ${r.forkMs.toFixed(2)}ms vs ${foe} ${r.upMs.toFixed(2)}ms (${d >= 0 ? "+" : ""}${d.toFixed(1)}%)`,
		);
	}
	const c = report.gate;
	console.log(
		`controls gate [${c.basis}] (threshold ${c.threshold}%): ${c.tripped ? "INVALID" : "valid"}; max control |delta| ${c.maxControlAbs.toFixed(1)}%; noise floor ~${c.maxControlAbs.toFixed(1)}%`,
	);
}

function evaluateGate(rows, threshold, nullMode) {
	// Mask rows are controls only in null mode (same file both sides).
	// Fork-vs-upstream they measure the real bitmask win, so the gate
	// watches the A/A calibration rows instead.
	const controls = rows.filter((r) =>
		nullMode
			? r.config.startsWith("mask") && r.deltaPct !== null
			: r.config === "selfcheck",
	);
	const maxControlAbs = controls.reduce(
		(m, r) => Math.max(m, Math.abs(r.deltaPct)),
		0,
	);
	return {
		threshold,
		tripped: maxControlAbs > threshold,
		maxControlAbs,
		basis: nullMode ? "mask" : "selfcheck",
	};
}

async function main() {
	if (OPTS.reportOnly) {
		const report = JSON.parse(readFileSync(OPTS.reportOnly, "utf8"));
		printTable(report);
		process.exit(
			evaluateGate(report.rows, OPTS.gate, report.nullMode !== false).tripped
				? 1
				: 0,
		);
	}
	if (!existsSync(FORK_BUILT)) {
		throw new Error(
			`built fork not found at ${FORK_BUILT}; run pnpm build first`,
		);
	}
	const { Fork, Up, pin, nullMode, base } = await loadSide(
		OPTS.upstream,
		FORK_BUILT,
	);
	const foe = base ? `base@${base.short}` : "upstream";
	equivalence(Fork, Up);
	const rows = [];
	timeRounds(Fork, Up, rows, foe);
	const gate = evaluateGate(rows, OPTS.gate, nullMode);
	const dirtyOut = sh("git", ["status", "--porcelain", "--", "bloomfilter.ts"]);
	const report = {
		tool: "bench/compare.mjs",
		version: 1,
		timestamp: new Date().toISOString(),
		runtime: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		pin,
		baseline: base ? { ref: OPTS.upstream, sha: base.sha } : null,
		foe,
		forkRef: sh("git", ["rev-parse", "--short", "HEAD"]),
		forkDirty: dirtyOut === null ? null : dirtyOut !== "",
		nullMode,
		options: {
			full: OPTS.full,
			xlarge: OPTS.xlarge,
			rounds: OPTS.rounds,
			gate: OPTS.gate,
		},
		gate,
		rows,
	};
	printTable(report);
	if (OPTS.json) {
		writeFileSync(OPTS.json, `${JSON.stringify(report, null, 2)}\n`);
		console.error(`wrote ${OPTS.json}`);
	}
	if (gate.tripped) {
		console.error(
			`INVALID: a mask control exceeded the ${OPTS.gate}% gate; run is noise-dominated`,
		);
		process.exit(1);
	}
}

// Importable for tests (materializeBaseline) without running the bench;
// direct execution runs it.
if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
