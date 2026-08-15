import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGrepToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, { cleanupStaleArtifacts, compactGrepOutput } from "./index.ts";

const tools = new Map<string, any>();
const hooks = new Map<string, any>();
let activeTools = ["read", "grep", "ast_read_tree", "ast_read_symbol", "babysit_check"];
extension({
	registerTool(tool: { name: string }) {
		tools.set(tool.name, tool);
	},
	on(name: string, handler: unknown) {
		hooks.set(name, handler);
	},
	getActiveTools() {
		return [...activeTools];
	},
	setActiveTools(names: string[]) {
		activeTools = [...names];
	},
} as any);

function tempDir(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-skim-test-"));
}

function ctx(cwd: string) {
	return { cwd, model: undefined } as any;
}

async function executeRead(cwd: string, input: Record<string, unknown>) {
	return tools.get("read").execute("test-call", input, undefined, undefined, ctx(cwd));
}

async function executeBuiltInRead(cwd: string, input: Record<string, unknown>) {
	return createReadToolDefinition(cwd).execute(
		"builtin-call",
		input as any,
		undefined,
		undefined,
		ctx(cwd),
	);
}

async function executeGrep(cwd: string, input: Record<string, unknown>) {
	return tools.get("grep").execute("grep-call", input, undefined, undefined, ctx(cwd));
}

async function executeBuiltInGrep(cwd: string, input: Record<string, unknown>) {
	return createGrepToolDefinition(cwd).execute(
		"builtin-grep-call",
		input as any,
		undefined,
		undefined,
		ctx(cwd),
	);
}

test("takes over read and grep without touching babysit or old AST tools", () => {
	expect([...tools.keys()]).toEqual(["read", "grep"]);
	expect(hooks.has("session_start")).toBe(true);
	expect(hooks.has("tool_call")).toBe(true);
	expect(activeTools).toContain("ast_read_tree");
	expect(activeTools).toContain("ast_read_symbol");
	expect(tools.get("read").promptGuidelines.join(" ")).toContain("action=outline");
	expect(tools.get("grep").promptGuidelines.join(" ")).not.toContain("babysit");
	expect(tools.get("grep").promptGuidelines.join(" ")).toContain("never select it preemptively");
});

test("default and action=exact output are byte-for-byte built-in read behavior", async () => {
	const dir = tempDir();
	try {
		writeFileSync(path.join(dir, "sample.txt"), "alpha\nbeta\ngamma\ndelta\n");
		for (const input of [
			{ path: "sample.txt" },
			{ path: "sample.txt", offset: 2, limit: 2 },
			{ path: "sample.txt", action: "exact", offset: 2, limit: 2 },
		]) {
			const extensionInput = { ...input };
			const builtInInput = {
				path: input.path,
				offset: "offset" in input ? input.offset : undefined,
				limit: "limit" in input ? input.limit : undefined,
			};
			expect(await executeRead(dir, extensionInput)).toEqual(
				await executeBuiltInRead(dir, builtInInput),
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exact read preserves built-in truncation metadata and errors", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "huge.txt"),
			Array.from({ length: 3_000 }, (_, index) => `${index} ${"x".repeat(40)}`).join("\n"),
		);
		expect(await executeRead(dir, { path: "huge.txt" })).toEqual(
			await executeBuiltInRead(dir, { path: "huge.txt" }),
		);
		let extensionError = "";
		let builtInError = "";
		try {
			await executeRead(dir, { path: "missing.txt" });
		} catch (error) {
			extensionError = error instanceof Error ? error.message : String(error);
		}
		try {
			await executeBuiltInRead(dir, { path: "missing.txt" });
		} catch (error) {
			builtInError = error instanceof Error ? error.message : String(error);
		}
		expect(extensionError).toBe(builtInError);
		expect(extensionError.length).toBeGreaterThan(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exact image read remains built-in behavior", async () => {
	const dir = tempDir();
	try {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(path.join(dir, "pixel.png"), png);
		expect(await executeRead(dir, { path: "pixel.png" })).toEqual(
			await executeBuiltInRead(dir, { path: "pixel.png" }),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outline and qualified symbol preserve structural navigation", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "sample.ts"),
			[
				"export class Worker {",
				"  run() {",
				"    return 1;",
				"  }",
				"}",
				"export function helper() {",
				"  return 2;",
				"}",
			].join("\n"),
		);
		const outline = await executeRead(dir, { path: "sample.ts", action: "outline" });
		expect(outline.content[0].text).toContain("class Worker");
		expect(outline.content[0].text).toContain("run()");
		expect(outline.content[0].text).toContain("[1-5]");

		const symbol = await executeRead(dir, {
			path: "sample.ts",
			action: "symbol",
			symbol: "Worker.run",
		});
		expect(symbol.content[0].text).toContain("return 1");
		expect(symbol.content[0].text).not.toContain("return 2");
		expect(symbol.details).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("JavaScript and JSX outlines use grammar-valid symbol kinds", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "sample.js"),
			[
				"export class Worker {",
				"  run() { return 1; }",
				"}",
				"export function helper() { return 2; }",
			].join("\n"),
		);
		writeFileSync(
			path.join(dir, "view.jsx"),
			"export function View() { return <div>ok</div>; }\n",
		);

		const javascript = await executeRead(dir, { path: "sample.js", action: "outline" });
		expect(javascript.content[0].text).toContain("class Worker");
		expect(javascript.content[0].text).toContain("function helper");
		const symbol = await executeRead(dir, {
			path: "sample.js",
			action: "symbol",
			symbol: "Worker.run",
		});
		expect(symbol.content[0].text).toContain("return 1");

		const jsx = await executeRead(dir, { path: "view.jsx", action: "outline" });
		expect(jsx.content[0].text).toContain("function View");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Swift outline and qualified symbols preserve structural navigation", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "AppDelegate.swift"),
			[
				"@MainActor",
				"final class AppDelegate: NSObject {",
				"  @Published",
				"  private var enabled = false",
				"  @objc",
				"  private func",
				"    requestPermission() -> Bool { true }",
				"  static func == (lhs: AppDelegate, rhs: AppDelegate) -> Bool { true }",
				"}",
				"struct Worker {",
				"  func run() { class Local {} }",
				"}",
				"func outer() { class Nested {} }",
				"func main() { print(\"ok\") }",
			].join("\n"),
		);
		const outline = await executeRead(dir, { path: "AppDelegate.swift", action: "outline" });
		expect(outline.content[0].text).toContain("AppDelegate");
		expect(outline.content[0].text).toContain("requestPermission");
		expect(outline.content[0].text).toContain("enabled");
		expect(outline.content[0].text).toContain("static func ==");
		expect(outline.content[0].text).not.toContain("class final");

		const symbol = await executeRead(dir, {
			path: "AppDelegate.swift",
			action: "symbol",
			symbol: "AppDelegate.requestPermission",
		});
		expect(symbol.content[0].text).toContain("requestPermission() -> Bool");
		expect(symbol.content[0].text).not.toContain("func main");

		const operator = await executeRead(dir, {
			path: "AppDelegate.swift",
			action: "symbol",
			symbol: "AppDelegate.==",
		});
		expect(operator.content[0].text).toContain("static func ==");

		const worker = await executeRead(dir, {
			path: "AppDelegate.swift",
			action: "symbol",
			symbol: "Worker.run",
		});
		expect(worker.content[0].text).toContain("func run");

		const outer = await executeRead(dir, {
			path: "AppDelegate.swift",
			action: "symbol",
			symbol: "outer",
		});
		expect(outer.content[0].text).toContain("func outer");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("oversized outline keeps every symbol name and links detailed signatures", async () => {
	const dir = tempDir();
	let detailedPath: string | undefined;
	try {
		writeFileSync(
			path.join(dir, "many.ts"),
			Array.from(
				{ length: 35 },
				(_, index) =>
					`function symbol_${String(index).padStart(2, "0")}(${Array.from({ length: 12 }, (_, arg) => `argument_${arg}: string`).join(", ")}) { return ${index}; }`,
			).join("\n"),
		);
		const result = await executeRead(dir, {
			path: "many.ts",
			action: "outline",
			maxBytes: 2_000,
		});
		expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(2_000);
		expect(result.content[0].text).toContain("symbol_00");
		expect(result.content[0].text).toContain("symbol_34");
		detailedPath = result.content[0].text.match(/\[Detailed signatures: (.+)\]/)?.[1];
		expect(detailedPath).toBeTruthy();
		expect(await Bun.file(detailedPath!).text()).toContain("argument_5");
		expect(result.details?.truncation?.truncated).toBe(true);
	} finally {
		if (detailedPath) rmSync(path.dirname(detailedPath), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outline stays bounded when even the complete symbol index exceeds the budget", async () => {
	const dir = tempDir();
	let symbolIndexPath: string | undefined;
	let detailedPath: string | undefined;
	try {
		const fileName = `${"巨大な索引".repeat(8)}.ts`;
		writeFileSync(
			path.join(dir, fileName),
			Array.from(
				{ length: 500 },
				(_, index) =>
					`function very_long_symbol_name_${String(index).padStart(3, "0")}(${"argument: string, ".repeat(8)}last: string) { return ${index}; }`,
			).join("\n"),
		);
		const result = await executeRead(dir, {
			path: fileName,
			action: "outline",
			maxBytes: 1_000,
		});
		const output = result.content[0].text;
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(1_000);
		expect(output).not.toContain("�");
		expect(output).toContain("very_long_symbol_name_000");
		expect(output).not.toContain("very_long_symbol_name_499");
		symbolIndexPath = output.match(/\[Full symbol index: (.+)\]/)?.[1];
		detailedPath = output.match(/\[Detailed signatures: (.+)\]/)?.[1];
		expect(symbolIndexPath).toBeTruthy();
		expect(detailedPath).toBeTruthy();
		expect(await Bun.file(symbolIndexPath!).text()).toContain("very_long_symbol_name_499");
		expect(await Bun.file(detailedPath!).text()).toContain("argument: string");
		expect(result.details?.truncation?.truncated).toBe(true);
	} finally {
		const artifactPath = symbolIndexPath ?? detailedPath;
		if (artifactPath) rmSync(path.dirname(artifactPath), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing symbol reports available names without selecting unrelated source", async () => {
	const dir = tempDir();
	try {
		writeFileSync(path.join(dir, "missing.ts"), "function available() { return 1; }\n");
		const result = await executeRead(dir, {
			path: "missing.ts",
			action: "symbol",
			symbol: "absent",
		});
		expect(result.content[0].text).toContain("not found");
		expect(result.content[0].text).toContain("available");
		expect(result.content[0].text).not.toContain("return 1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ambiguous symbols list candidates instead of silently choosing one", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "ambiguous.ts"),
			[
				"class A {",
				"  run() { return 1; }",
				"}",
				"class B {",
				"  run() { return 2; }",
				"}",
			].join("\n"),
		);
		const result = await executeRead(dir, {
			path: "ambiguous.ts",
			action: "symbol",
			symbol: "run",
		});
		expect(result.content[0].text).toContain("ambiguous");
		expect(result.content[0].text).toContain("A.run");
		expect(result.content[0].text).toContain("B.run");
		expect(result.content[0].text).not.toContain("return 1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Rust type declarations are preferred and exact signatures disambiguate impls", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "widget.rs"),
			[
				"pub struct Widget {",
				"    value: i32,",
				"}",
				"impl Widget {",
				"    pub fn run(&self) -> i32 { self.value }",
				"}",
			].join("\n"),
		);

		const declaration = await executeRead(dir, {
			path: "widget.rs",
			action: "symbol",
			symbol: "Widget",
		});
		expect(declaration.content[0].text).toContain("pub struct Widget");
		expect(declaration.content[0].text).not.toContain("pub fn run");

		const implementation = await executeRead(dir, {
			path: "widget.rs",
			action: "symbol",
			symbol: "impl Widget",
		});
		expect(implementation.content[0].text).toContain("pub fn run");

		const method = await executeRead(dir, {
			path: "widget.rs",
			action: "symbol",
			symbol: "Widget::run",
		});
		expect(method.content[0].text).toContain("self.value");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("oversized single-line symbol gives an exact continuation instead of silent loss", async () => {
	const dir = tempDir();
	try {
		writeFileSync(path.join(dir, "long.ts"), `function huge() { return "${"x".repeat(10_000)}"; }\n`);
		const result = await executeRead(dir, {
			path: "long.ts",
			action: "symbol",
			symbol: "huge",
			maxBytes: 1_000,
		});
		expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(1_000);
		expect(result.content[0].text).toContain("Symbol continues to line 1");
		expect(result.content[0].text).toContain("offset=1");
		expect(result.details?.truncation?.truncated).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("focus is bounded but exact fallback still returns omitted content", async () => {
	const dir = tempDir();
	try {
		const source = Array.from({ length: 400 }, (_, index) =>
			index % 5 === 0 ? `needle ${index + 1} ${"x".repeat(80)}` : `line ${index + 1}`,
		).join("\n");
		writeFileSync(path.join(dir, "large.txt"), source);
		const focused = await executeRead(dir, {
			path: "large.txt",
			action: "focus",
			pattern: "needle",
			context: 100,
			maxMatches: 30,
			maxBytes: 2_000,
		});
		expect(Buffer.byteLength(focused.content[0].text)).toBeLessThanOrEqual(2_000);
		expect(focused.content[0].text).toContain("Focused output bounded");

		const exact = await executeRead(dir, { path: "large.txt", action: "exact" });
		expect(exact.content[0].text).toContain("needle 396");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unsupported AST action fails clearly while exact read remains unchanged", async () => {
	const dir = tempDir();
	try {
		writeFileSync(path.join(dir, "data.json"), '{"ok":true}\n');
		await expect(
			executeRead(dir, { path: "data.json", action: "outline" }),
		).rejects.toThrow("Unsupported source");
		expect(await executeRead(dir, { path: "data.json" })).toEqual(
			await executeBuiltInRead(dir, { path: "data.json" }),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("large whole-source read is nudged once, then exact call passes unchanged", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "large.ts"),
			`export function large() {\n${"  const value = 1;\n".repeat(1_500)}}\n`,
		);
		const event = { toolName: "read", input: { path: "large.ts" } };
		const first = await hooks.get("tool_call")(event, ctx(dir));
		expect(first.block).toBe(true);
		expect(first.reason).toContain("action=outline");
		expect(event.input).toEqual({ path: "large.ts" });
		expect(await hooks.get("tool_call")(event, ctx(dir))).toBeUndefined();
		expect(await executeRead(dir, event.input)).toEqual(
			await executeBuiltInRead(dir, event.input),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parallel identical whole-file reads receive at most one nudge", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "parallel.ts"),
			`export function large() {\n${"  const value = 1;\n".repeat(1_500)}}\n`,
		);
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				hooks.get("tool_call")(
					{ toolName: "read", input: { path: "parallel.ts" } },
					ctx(dir),
				),
			),
		);
		expect(results.filter((result) => result?.block).length).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("small, ranged, and unsupported reads are never nudged", async () => {
	const dir = tempDir();
	try {
		writeFileSync(path.join(dir, "small.ts"), "export const x = 1;\n");
		writeFileSync(path.join(dir, "large.json"), `{"x":"${"x".repeat(30_000)}"}\n`);
		for (const input of [
			{ path: "small.ts" },
			{ path: "small.ts", offset: 1, limit: 1 },
			{ path: "large.json" },
		]) {
			expect(
				await hooks.get("tool_call")({ toolName: "read", input }, ctx(dir)),
			).toBeUndefined();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("even a very large explicit source range remains exact and is never nudged", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "range.ts"),
			`export function large() {\n${"  const value = 1;\n".repeat(1_500)}}\n`,
		);
		const event = {
			toolName: "read",
			input: { path: "range.ts", offset: 200, limit: 800 },
		};
		expect(await hooks.get("tool_call")(event, ctx(dir))).toBeUndefined();
		expect(await executeRead(dir, event.input)).toEqual(
			await executeBuiltInRead(dir, event.input),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("small grep and mode=exact preserve built-in output", async () => {
	const dir = tempDir();
	try {
		writeFileSync(path.join(dir, "small.txt"), "alpha\nneedle\nomega\n");
		const input = { pattern: "needle", path: "small.txt", context: 1, limit: 10 };
		expect(await executeGrep(dir, input)).toEqual(await executeBuiltInGrep(dir, input));
		expect(await executeGrep(dir, { ...input, mode: "exact" })).toEqual(
			await executeBuiltInGrep(dir, input),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exact grep preserves built-in errors", async () => {
	const dir = tempDir();
	try {
		let extensionError = "";
		let builtInError = "";
		const input = { pattern: "needle", path: "missing-directory", mode: "exact" };
		try {
			await executeGrep(dir, input);
		} catch (error) {
			extensionError = error instanceof Error ? error.message : String(error);
		}
		try {
			await executeBuiltInGrep(dir, { pattern: input.pattern, path: input.path });
		} catch (error) {
			builtInError = error instanceof Error ? error.message : String(error);
		}
		expect(extensionError).toBe(builtInError);
		expect(extensionError).toContain("Path not found");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("maxBytes config does not index a built-in grep result below the 8KB activation threshold", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "medium.txt"),
			Array.from({ length: 20 }, (_, index) => `needle ${index} ${"x".repeat(100)}`).join("\n"),
		);
		const input = { pattern: "needle", path: "medium.txt", limit: 100 };
		const exact = await executeBuiltInGrep(dir, input);
		const exactContent = exact.content[0];
		if (exactContent?.type !== "text") throw new Error("Expected text grep output");
		expect(Buffer.byteLength(exactContent.text)).toBeGreaterThan(1_000);
		expect(Buffer.byteLength(exactContent.text)).toBeLessThan(8_000);
		expect(await executeGrep(dir, { ...input, maxBytes: 1_000 })).toEqual(exact);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mode=exact preserves built-in large-output truncation metadata", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			path.join(dir, "huge-grep.txt"),
			Array.from({ length: 120 }, (_, index) => `needle ${index} ${"x".repeat(600)}`).join("\n"),
		);
		const input = { pattern: "needle", path: "huge-grep.txt", context: 1, limit: 100 };
		expect(await executeGrep(dir, { ...input, mode: "exact" })).toEqual(
			await executeBuiltInGrep(dir, input),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("oversized grep becomes a bounded cross-file index with exact output preserved", async () => {
	const dir = tempDir();
	let exactPath: string | undefined;
	try {
		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			writeFileSync(
				path.join(dir, name),
				Array.from({ length: 40 }, (_, index) =>
					index % 2 === 0 ? `needle ${name} ${index} ${"x".repeat(80)}` : `context ${index}`,
				).join("\n"),
			);
		}
		const input = { pattern: "needle", path: ".", context: 1, limit: 100 };
		const exact = await executeBuiltInGrep(dir, input);
		const exactContent = exact.content[0];
		if (exactContent?.type !== "text") throw new Error("Expected text grep output");
		expect(Buffer.byteLength(exactContent.text)).toBeGreaterThan(2_000);
		const smart = await executeGrep(dir, { ...input, maxBytes: 2_000, maxPerFile: 2 });
		expect(Buffer.byteLength(smart.content[0].text)).toBeLessThanOrEqual(2_000);
		expect(smart.content[0].text).toContain("a.ts");
		expect(smart.content[0].text).toContain("b.ts");
		expect(smart.content[0].text).toContain("c.ts");
		expect(smart.content[0].text).toContain("Full exact grep result");
		expect(smart.details).toEqual(exact.details);
		exactPath = smart.content[0].text.match(/\[Full exact grep result: (.+)\]/)?.[1];
		expect(exactPath).toBeTruthy();
		const savedExact = await Bun.file(exactPath!).text();
		expect(Buffer.byteLength(savedExact)).toBeGreaterThan(2_000);
		expect(savedExact).toContain("a.ts:1: needle");
		expect(savedExact.split("\n").filter((line) => /:\d+:/.test(line)).length).toBe(
			exactContent.text.split("\n").filter((line) => /:\d+:/.test(line)).length,
		);
		const exactMode = await executeGrep(dir, { ...input, mode: "exact" });
		const exactModeContent = exactMode.content[0];
		if (exactModeContent?.type !== "text") throw new Error("Expected exact text grep output");
		expect(exactModeContent.text).not.toContain("Smart grep index");
		expect(Buffer.byteLength(exactModeContent.text)).toBeGreaterThan(2_000);
	} finally {
		if (exactPath) rmSync(path.dirname(exactPath), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("smart grep does not mistake context content containing path:line: for a file", () => {
	const exact = [
		'actual.ts-8- expect(saved).toContain("fake.ts:1: needle")',
		"actual.ts:9: needle actual",
		'other.ts-2- const sample = "phantom.rs:44: hit"',
		"other.ts:3: needle other",
	].join("\n");
	const indexed = compactGrepOutput(exact, "/tmp/exact.txt");
	expect(indexed.fileCount).toBe(2);
	expect(indexed.matchCount).toBe(2);
	expect(indexed.text).toContain("actual.ts (1)");
	expect(indexed.text).toContain("other.ts (1)");
	expect(indexed.text).not.toContain("fake.ts (1)");
	expect(indexed.text).not.toContain("phantom.rs (1)");
});

test("smart grep indexes match paths containing hyphen-number segments", () => {
	const exact = [
		"BAC-6118-trace-summary.json-140- before",
		"BAC-6118-trace-summary.json:141: Needle actual",
		"BAC-6118-trace-summary.json-142- after",
		"plain.ts:3: needle plain",
	].join("\n");
	const indexed = compactGrepOutput(exact, "/tmp/exact.txt", 8_000, 3, {
		pattern: "needle",
		ignoreCase: true,
	});
	expect(indexed.fileCount).toBe(2);
	expect(indexed.matchCount).toBe(2);
	expect(indexed.text).toContain("BAC-6118-trace-summary.json (1)");
	expect(indexed.text).toContain("plain.ts (1)");
});

test("smart grep stays bounded and links exact output when every matched file cannot fit", async () => {
	const dir = tempDir();
	let exactPath: string | undefined;
	try {
		for (let index = 0; index < 30; index++) {
			writeFileSync(
				path.join(dir, `very-long-matched-file-name-${String(index).padStart(3, "0")}-${"x".repeat(40)}.ts`),
				`needle ${index} ${"y".repeat(300)}\n`,
			);
		}
		const result = await executeGrep(dir, {
			pattern: "needle",
			path: ".",
			limit: 100,
			maxBytes: 1_000,
		});
		expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(1_000);
		expect(result.content[0].text).toContain("Smart grep index omitted");
		expect(result.content[0].text).toContain("Full exact grep result");
		exactPath = result.content[0].text.match(/\[Full exact grep result: (.+)\]/)?.[1];
		expect(exactPath).toBeTruthy();
		expect(await Bun.file(exactPath!).text()).toContain("very-long-matched-file-name-029");
	} finally {
		if (exactPath) rmSync(path.dirname(exactPath), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("manifest overflow remains bounded when the exact-result path is too long", () => {
	const exact = Array.from(
		{ length: 30 },
		(_, index) => `very-long-${index}.ts:${index + 1}: needle ${"x".repeat(300)}`,
	).join("\n");
	const result = compactGrepOutput(exact, `/tmp/${"nested/".repeat(200)}exact-output.txt`, 1_000);
	expect(result.allFilesIndexed).toBe(false);
	expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1_000);
	expect(result.text).toContain("exact-result path exceeds");
});

test("stale artifacts are removed without touching fresh or unrelated directories", async () => {
	const root = tempDir();
	try {
		const stale = path.join(root, "pi-skim-grep-stale");
		const fresh = path.join(root, "pi-skim-outline-fresh");
		const unrelated = path.join(root, "other-tool-stale");
		for (const dir of [stale, fresh, unrelated]) mkdirSync(dir);
		const now = Date.now();
		utimesSync(stale, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
		utimesSync(unrelated, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
		await cleanupStaleArtifacts(root, now, 10_000);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-skim does not hook or alter pi-babysit log inspection", async () => {
	const event = { toolName: "babysit_check", input: { id: "test", lines: 200 } };
	expect(await hooks.get("tool_call")(event, ctx(process.cwd()))).toBeUndefined();
	expect(event.input).toEqual({ id: "test", lines: 200 });
});
