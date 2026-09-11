import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// bench/compare.mjs is a runnable script outside the tsc build, so it is
// loaded by runtime-resolved path (not a static import): importing it must
// not run the bench (entry guard), and must expose materializeBaseline.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compareUrl = pathToFileURL(resolve(repoRoot, "bench/compare.mjs")).href;
const { materializeBaseline, resolveSideFile } = (await import(compareUrl)) as {
	materializeBaseline: (ref: string) => {
		dir: string;
		file: string;
		sha: string;
		short: string;
	};
	resolveSideFile: (spec: string) => {
		file: string;
		base: null | { dir: string; file: string; sha: string; short: string };
	};
};

describe("arm resolution", () => {
	it("existing path passes through with null base", () => {
		const side = resolveSideFile(resolve(repoRoot, "package.json"));
		assert.equal(side.base, null);
		assert.match(side.file, /package\.json$/);
	});

	it("unknown spec throws", () => {
		assert.throws(
			() => resolveSideFile("definitely-not-a-ref-xyz"),
			/unknown git ref/,
		);
	});
});

describe("--upstream <ref> materialization", () => {
	it("unknown ref throws", () => {
		assert.throws(
			() => materializeBaseline("definitely-not-a-ref-xyz"),
			/unknown git ref/,
		);
	});

	it("HEAD builds an equivalent module", async () => {
		const base = materializeBaseline("HEAD");
		try {
			assert.match(base.sha, /^[0-9a-f]{40}$/);
			const mod = await import(pathToFileURL(base.file).href);
			assert.equal(typeof mod.BloomFilter, "function");
			const f = new mod.BloomFilter(1000, 4);
			f.add("hello");
			assert.equal(f.test("hello"), true);
			assert.equal(f.countBits() > 0, true);
		} finally {
			rmSync(base.dir, { recursive: true, force: true });
		}
	});
});
