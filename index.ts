import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	createGrepToolDefinition,
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ExtensionAPI,
	type GrepToolDetails,
	type ReadToolDetails,
	isToolCallEventType,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const runFile = promisify(execFile);
const DEFAULT_OPTIMIZED_BYTES = 8_000;
const MAX_OPTIMIZED_BYTES = 32_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const READ_NUDGE_BYTES = Number(process.env.PI_SKIM_NUDGE_BYTES) || 20_000;
const DEFAULT_GREP_MAX_PER_FILE = 3;
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	action: Type.Optional(
		StringEnum(["exact", "outline", "symbol", "focus"] as const, {
			description: "exact/default=pi read; outline=symbol tree; symbol=one declaration; focus=regex windows",
		}),
	),
	symbol: Type.Optional(
		Type.String({ description: "Name for action=symbol; supports Parent.child" }),
	),
	pattern: Type.Optional(
		Type.String({ description: "Regex for action=focus" }),
	),
	context: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 20, description: "Focus context lines (default: 2)" }),
	),
	maxMatches: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 200, description: "Focus match cap (default: 30)" }),
	),
	maxBytes: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			maximum: MAX_OPTIMIZED_BYTES,
			description: "Outline/symbol/focus byte cap (default: 8000)",
		}),
	),
	literal: Type.Optional(Type.Boolean({ description: "Literal focus pattern" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive focus" })),
});

export type SmartReadInput = Static<typeof readSchema>;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex" })),
	context: Type.Optional(Type.Number({ description: "Context lines before and after each match (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches returned by exact grep (default: 100)" })),
	mode: Type.Optional(
		StringEnum(["smart", "exact"] as const, {
			description: "smart/default indexes >maxBytes; exact=pi grep",
		}),
	),
	maxBytes: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			maximum: MAX_OPTIMIZED_BYTES,
			description: "Smart byte cap (default: 8000)",
		}),
	),
	maxPerFile: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 20,
			description: "Index samples per file (default: 3)",
		}),
	),
});

export type SmartGrepInput = Static<typeof grepSchema>;

interface LanguageConfig {
	language: string;
	kinds: string[];
}

export interface SymbolInfo {
	name: string;
	signature: string;
	start: number;
	end: number;
	depth: number;
}

interface NumberedLine {
	lineNumber: number;
	text: string;
}

interface BoundedText {
	text: string;
	details: ReadToolDetails | undefined;
	truncated: boolean;
}

const TS_KINDS = [
	"class_declaration",
	"abstract_class_declaration",
	"function_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"method_definition",
	"lexical_declaration",
];
const RUST: LanguageConfig = {
	language: "rust",
	kinds: [
		"function_item",
		"struct_item",
		"enum_item",
		"impl_item",
		"trait_item",
		"mod_item",
		"const_item",
		"static_item",
		"type_item",
		"macro_definition",
	],
};
const TYPESCRIPT: LanguageConfig = { language: "typescript", kinds: TS_KINDS };
const JAVASCRIPT: LanguageConfig = { language: "javascript", kinds: TS_KINDS };
const PYTHON: LanguageConfig = {
	language: "python",
	kinds: ["class_definition", "function_definition"],
};
const SHELL: LanguageConfig = { language: "bash", kinds: ["function_definition"] };
const LANGUAGES: Record<string, LanguageConfig> = {
	rs: RUST,
	ts: TYPESCRIPT,
	tsx: { language: "tsx", kinds: TS_KINDS },
	js: JAVASCRIPT,
	jsx: JAVASCRIPT,
	mts: TYPESCRIPT,
	cts: TYPESCRIPT,
	mjs: JAVASCRIPT,
	cjs: JAVASCRIPT,
	py: PYTHON,
	pyi: PYTHON,
	sh: SHELL,
	bash: SHELL,
	zsh: SHELL,
	ksh: SHELL,
};
const RESERVED = new Set(
	"pub export default async unsafe const static abstract declare public private protected readonly fn function def class struct enum trait impl interface type mod let var get set".split(
		" ",
	),
);

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function normalizeLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

function extensionName(filePath: string): string {
	const base = path.basename(filePath);
	const index = base.lastIndexOf(".");
	return index >= 0 ? base.slice(index + 1).toLowerCase() : "";
}

function isMakefile(filePath: string): boolean {
	return (
		/^(GNUmakefile|makefile|Makefile)$/.test(path.basename(filePath)) ||
		["mk", "make", "mak"].includes(extensionName(filePath))
	);
}

function stripRustVisibility(text: string): string {
	return text.replace(/\bpub\s*\([^)]*\)/g, "pub");
}

function symbolName(firstLine: string): string {
	const normalized = stripRustVisibility(firstLine).replace(/<[^>]*>/g, " ");
	if (/^\s*(pub\s+)?(unsafe\s+)?impl\b/.test(normalized)) {
		const forMatch = normalized.match(/\bfor\s+([A-Za-z_][\w:]*)/)?.[1];
		if (forMatch) return forMatch.split("::").at(-1) ?? forMatch;
		const implMatch = normalized.match(/impl\s+([A-Za-z_][\w:]*)/)?.[1];
		if (implMatch) return implMatch.split("::").at(-1) ?? implMatch;
	}
	const tokens = normalized.match(/[A-Za-z_]\w*/g) ?? [];
	return tokens.find((token) => !RESERVED.has(token)) ?? tokens[0] ?? "?";
}

function symbolSignature(firstLine: string): string {
	const normalized = stripRustVisibility(firstLine);
	const brace = normalized.indexOf("{");
	return (brace >= 0 ? normalized.slice(0, brace) : normalized)
		.replace(/\s*;\s*$/, "")
		.trim()
		.slice(0, 140);
}

async function firstLine(filePath: string): Promise<string> {
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(256);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0] ?? "";
	} finally {
		await handle.close();
	}
}

type DetectedSource = { type: "ast-grep"; config: LanguageConfig } | { type: "makefile" };

export async function detectSource(filePath: string): Promise<DetectedSource | undefined> {
	if (isMakefile(filePath)) return { type: "makefile" };
	const config = LANGUAGES[extensionName(filePath)];
	if (config) return { type: "ast-grep", config };
	if (!extensionName(filePath)) {
		try {
			if (/^#!.*\b(bash|sh|zsh|ksh|dash)\b/.test(await firstLine(filePath))) {
				return { type: "ast-grep", config: SHELL };
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function astGrepSymbols(
	filePath: string,
	config: LanguageConfig,
	signal?: AbortSignal,
): Promise<SymbolInfo[]> {
	const rule =
		`id: pi-skim-outline\nlanguage: ${config.language}\nrule:\n  any:\n` +
		config.kinds.map((kind) => `    - kind: ${kind}`).join("\n");
	let stdout: string;
	try {
		const result = await runFile(
			"ast-grep",
			["scan", "--inline-rules", rule, "--json=compact", filePath],
			{ maxBuffer: 32 * 1024 * 1024, signal },
		);
		stdout = result.stdout;
	} catch (error) {
		const failure = error as { code?: string; stderr?: string; message?: string };
		if (failure.code === "ENOENT") {
			throw new Error("ast-grep is required for read action=outline/symbol (`brew install ast-grep`).");
		}
		throw new Error(`ast-grep failed: ${failure.stderr || failure.message || String(error)}`);
	}
	const symbols = (
		JSON.parse(stdout) as Array<{
			text: string;
			range: { start: { line: number }; end: { line: number } };
		}>
	).map((match) => {
		const declaration = match.text.split("\n", 1)[0] ?? "";
		return {
			name: symbolName(declaration),
			signature: symbolSignature(declaration),
			start: match.range.start.line + 1,
			end: match.range.end.line + 1,
			depth: 0,
		};
	});
	symbols.sort((left, right) => left.start - right.start || right.end - left.end);
	for (const symbol of symbols) {
		symbol.depth = symbols.filter(
			(parent) =>
				parent !== symbol &&
				parent.start <= symbol.start &&
				symbol.end <= parent.end &&
				(parent.start < symbol.start || symbol.end < parent.end),
		).length;
	}
	return symbols;
}

async function makefileSymbols(filePath: string): Promise<SymbolInfo[]> {
	const lines = normalizeLines(await readFile(filePath, "utf8"));
	const definitions: Array<SymbolInfo & { singleLine: boolean }> = [];
	for (const [index, line] of lines.entries()) {
		const variable = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:?+]?=/)?.[1];
		if (variable) {
			definitions.push({
				name: variable,
				signature: line.trim().slice(0, 140),
				start: index + 1,
				end: index + 1,
				depth: 0,
				singleLine: true,
			});
			continue;
		}
		const target = line.match(/^([^\t=:#][^:=]*):(?!=)/)?.[1]?.trim().split(/\s+/)[0];
		if (target) {
			definitions.push({
				name: target,
				signature: line.trim().slice(0, 140),
				start: index + 1,
				end: index + 1,
				depth: 0,
				singleLine: false,
			});
		}
	}
	for (const [index, definition] of definitions.entries()) {
		if (definition.singleLine) continue;
		definition.end = definitions[index + 1]?.start
			? definitions[index + 1]!.start - 1
			: lines.length;
	}
	return definitions.map(({ singleLine: _singleLine, ...symbol }) => symbol);
}

export async function symbolsFor(filePath: string, signal?: AbortSignal): Promise<SymbolInfo[]> {
	const detected = await detectSource(filePath);
	if (!detected) {
		throw new Error(
			"Unsupported source. read action=outline/symbol supports Rust, TypeScript/TSX, JavaScript/JSX, Python, Shell, and Makefiles. Use exact read otherwise.",
		);
	}
	return detected.type === "makefile"
		? makefileSymbols(filePath)
		: astGrepSymbols(filePath, detected.config, signal);
}

function boundedText(body: string, maxBytes: number, continuation: string): BoundedText {
	const reserve = Math.min(byteLength(continuation) + 2, Math.floor(maxBytes / 3));
	const truncation = truncateHead(body, {
		maxBytes: Math.max(1, maxBytes - reserve),
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return { text: body, details: undefined, truncated: false };
	return {
		text: `${truncation.content}\n\n${continuation}`,
		details: { truncation },
		truncated: true,
	};
}

function numberedLines(
	lines: string[],
	startLine: number,
	matchLines: Set<number> = new Set(),
): NumberedLine[] {
	const width = String(Math.max(startLine + lines.length - 1, 1)).length;
	return lines.map((line, index) => {
		const lineNumber = startLine + index;
		return {
			lineNumber,
			text: `${matchLines.has(lineNumber) ? ">" : " "}${String(lineNumber).padStart(width)}: ${line}`,
		};
	});
}

function fitNumberedLines(lines: NumberedLine[], maxBytes: number): {
	text: string;
	lastLine?: number;
	truncated: boolean;
} {
	const selected: string[] = [];
	let bytes = 0;
	let lastLine: number | undefined;
	for (const line of lines) {
		const nextBytes = byteLength(line.text) + (selected.length > 0 ? 1 : 0);
		if (bytes + nextBytes > maxBytes) break;
		selected.push(line.text);
		bytes += nextBytes;
		lastLine = line.lineNumber;
	}
	return { text: selected.join("\n"), lastLine, truncated: selected.length < lines.length };
}

function containingParent(symbol: SymbolInfo, symbols: SymbolInfo[]): SymbolInfo | undefined {
	return symbols
		.filter(
			(parent) =>
				parent !== symbol &&
				parent.start <= symbol.start &&
				symbol.end <= parent.end &&
				(parent.start < symbol.start || symbol.end < parent.end),
		)
		.sort((left, right) => left.end - left.start - (right.end - right.start))[0];
}

async function optimizedRead(
	params: SmartReadInput,
	absolutePath: string,
	signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ReadToolDetails | undefined }> {
	const maxBytes = params.maxBytes ?? DEFAULT_OPTIMIZED_BYTES;
	if (maxBytes > MAX_OPTIMIZED_BYTES) throw new Error(`maxBytes must be <= ${MAX_OPTIMIZED_BYTES}`);
	const action = params.action;

	if (action === "outline") {
		const symbols = await symbolsFor(absolutePath, signal);
		const detailed =
			`Symbol outline: ${params.path} (${symbols.length} symbols)\n` +
			(symbols.length > 0
				? symbols
						.map(
							(symbol) =>
								`${"  ".repeat(symbol.depth)}${symbol.signature}  [${symbol.start}-${symbol.end}]`,
						)
						.join("\n")
				: "No symbols found.");
		if (byteLength(detailed) <= maxBytes) {
			return { content: [{ type: "text", text: detailed }], details: undefined };
		}

		let outputDir: string | undefined;
		try {
			outputDir = await mkdtemp(path.join(tmpdir(), "pi-skim-outline-"));
			const fullOutputPath = path.join(outputDir, "detailed-outline.txt");
			const footer =
				`[Detailed signatures: ${fullOutputPath}]\n` +
				"[All symbol names and ranges are shown below; use read action=symbol or exact line ranges.]";
			const compact =
				`Symbol index: ${params.path} (${symbols.length} symbols)\n` +
				symbols
					.map(
						(symbol) =>
							`${"  ".repeat(symbol.depth)}${symbol.name}  [${symbol.start}-${symbol.end}]`,
					)
					.join("\n") +
				`\n${footer}`;
			if (byteLength(compact) > maxBytes) {
				await rm(outputDir, { recursive: true, force: true });
				// Never hide symbol names merely to satisfy an optimization budget.
				return { content: [{ type: "text", text: detailed }], details: undefined };
			}
			await writeFile(fullOutputPath, detailed, "utf8");
			return {
				content: [{ type: "text", text: compact }],
				details: {
					truncation: truncateHead(detailed, {
						maxBytes,
						maxLines: DEFAULT_MAX_LINES,
					}),
				},
			};
		} catch {
			if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
			return { content: [{ type: "text", text: detailed }], details: undefined };
		}
	}

	if (action === "symbol") {
		if (!params.symbol) throw new Error("`symbol` is required for read action=symbol");
		const symbols = await symbolsFor(absolutePath, signal);
		const parts = params.symbol.split(".");
		const target = parts.at(-1) ?? params.symbol;
		const parentName = parts.length > 1 ? parts.at(-2) : undefined;
		let hits = symbols.filter((symbol) => symbol.name === target);
		if (parentName) {
			const parents = symbols.filter((symbol) => symbol.name === parentName);
			hits = hits.filter((hit) =>
				parents.some(
					(parent) =>
						parent !== hit && parent.start <= hit.start && hit.end <= parent.end,
				),
			);
		}
		if (hits.length !== 1) {
			const candidates = hits.length > 1 ? hits : symbols;
			const title = hits.length > 1
				? `Symbol ${JSON.stringify(params.symbol)} is ambiguous in ${params.path}; candidates:`
				: `Symbol ${JSON.stringify(params.symbol)} not found in ${params.path}; available symbols:`;
			const body = `${title}\n${candidates
				.map((candidate) => {
					const parent = containingParent(candidate, symbols);
					return `${parent ? `${parent.name}.` : ""}${candidate.name}: ${candidate.signature}  [${candidate.start}-${candidate.end}]`;
				})
				.join("\n")}`;
			const bounded = boundedText(
				body,
				maxBytes,
				`[Candidate list bounded. Use read action=outline or exact read by line range.]`,
			);
			return { content: [{ type: "text", text: bounded.text }], details: bounded.details };
		}

		const hit = hits[0]!;
		const allLines = normalizeLines(await readFile(absolutePath, "utf8"));
		const source = numberedLines(allLines.slice(hit.start - 1, hit.end), hit.start);
		const header = `${params.path}:${hit.start}-${hit.end} ${hit.signature}`;
		const bodyBudget = Math.max(1, maxBytes - byteLength(header) - 300);
		const fitted = fitNumberedLines(source, bodyBudget);
		const nextOffset = fitted.lastLine === undefined
			? hit.start
			: fitted.lastLine < hit.end
				? fitted.lastLine + 1
				: undefined;
		const continuation = nextOffset
			? `\n\n[Symbol continues to line ${hit.end}. Use exact read with offset=${nextOffset}, limit=${hit.end - nextOffset + 1}.]`
			: "";
		return {
			content: [{ type: "text", text: `${header}\n${fitted.text}${continuation}` }],
			details: fitted.truncated
				? {
					truncation: truncateHead(source.map((line) => line.text).join("\n"), {
						maxBytes: bodyBudget,
						maxLines: DEFAULT_MAX_LINES,
					}),
				}
				: undefined,
		};
	}

	if (action === "focus") {
		if (!params.pattern) throw new Error("`pattern` is required for read action=focus");
		const fileStat = await stat(absolutePath);
		if (fileStat.size > MAX_SOURCE_BYTES) {
			throw new Error(`File is ${formatSize(fileStat.size)}; use grep or exact line ranges instead.`);
		}
		let regex: RegExp;
		try {
			const pattern = params.literal
				? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				: params.pattern;
			regex = new RegExp(pattern, params.ignoreCase ? "i" : "");
		} catch (error) {
			throw new Error(`Invalid focus pattern: ${error instanceof Error ? error.message : String(error)}`);
		}
		const allLines = normalizeLines(await readFile(absolutePath, "utf8"));
		const start = Math.max(0, (params.offset ?? 1) - 1);
		const end = Math.min(allLines.length, start + (params.limit ?? allLines.length));
		const matches: number[] = [];
		for (let index = start; index < end; index++) {
			regex.lastIndex = 0;
			if (regex.test(allLines[index] ?? "")) matches.push(index + 1);
		}
		const selectedMatches = matches.slice(0, params.maxMatches ?? 30);
		const context = params.context ?? 2;
		const included = new Set<number>();
		for (const line of selectedMatches) {
			for (
				let current = Math.max(start + 1, line - context);
				current <= Math.min(end, line + context);
				current++
			) {
				included.add(current);
			}
		}
		const matchSet = new Set(selectedMatches);
		const rendered: NumberedLine[] = [];
		let previous = 0;
		for (const line of [...included].sort((left, right) => left - right)) {
			if (previous > 0 && line > previous + 1) rendered.push({ lineNumber: previous, text: "  …" });
			rendered.push(numberedLines([allLines[line - 1] ?? ""], line, matchSet)[0]!);
			previous = line;
		}
		const header = `${params.path}: ${matches.length} matches, showing up to ${selectedMatches.length}`;
		const bodyBudget = Math.max(1, maxBytes - byteLength(header) - 250);
		const fitted = fitNumberedLines(rendered, bodyBudget);
		const omitted = fitted.truncated || selectedMatches.length < matches.length;
		const notice = omitted
			? `\n\n[Focused output bounded. Refine pattern/offset/limit, or use exact read for complete content.]`
			: "";
		return {
			content: [{ type: "text", text: `${header}\n${fitted.text || "No matches found"}${notice}` }],
			details: fitted.truncated
				? {
					truncation: truncateHead(rendered.map((line) => line.text).join("\n"), {
						maxBytes: bodyBudget,
						maxLines: DEFAULT_MAX_LINES,
					}),
				}
				: undefined,
		};
	}

	throw new Error(`Unsupported optimized read action: ${String(action)}`);
}

interface GrepGroup {
	path: string;
	matchCount: number;
	samples: Array<{ line: number; text: string }>;
}

export interface SmartGrepIndex {
	text: string;
	matchCount: number;
	fileCount: number;
	allFilesIndexed: boolean;
	indexTruncated: boolean;
}

function fitPlainLines(lines: string[], maxBytes: number): { text: string; shown: number } {
	const selected: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const addition = byteLength(line) + (selected.length > 0 ? 1 : 0);
		if (bytes + addition > maxBytes) break;
		selected.push(line);
		bytes += addition;
	}
	return { text: selected.join("\n"), shown: selected.length };
}

export function compactGrepOutput(
	exactOutput: string,
	fullOutputPath: string,
	maxBytes = DEFAULT_OPTIMIZED_BYTES,
	maxPerFile = DEFAULT_GREP_MAX_PER_FILE,
): SmartGrepIndex {
	const groups = new Map<string, GrepGroup>();
	const notices: string[] = [];
	for (const line of exactOutput.split("\n")) {
		const match = line.match(/^(.*):(\d+):\s?(.*)$/);
		if (match?.[1] && match[2] && match[3] !== undefined) {
			let group = groups.get(match[1]);
			if (!group) {
				group = { path: match[1], matchCount: 0, samples: [] };
				groups.set(match[1], group);
			}
			group.matchCount++;
			if (group.samples.length < maxPerFile) {
				group.samples.push({
					line: Number.parseInt(match[2], 10),
					text: match[3].slice(0, 320),
				});
			}
		} else if (line.startsWith("[") && line.endsWith("]")) {
			notices.push(line);
		}
	}
	const matchCount = [...groups.values()].reduce((sum, group) => sum + group.matchCount, 0);
	const requiredFooterLines = [
		`[Smart grep index: ${matchCount} returned matches across ${groups.size} files. Match context and additional lines are preserved in the exact result.]`,
		`[Full exact grep result: ${fullOutputPath}]`,
		`[Use read on that path, or re-run grep with mode=exact, when the complete original result is required.]`,
	];
	const footerLines = [...requiredFooterLines];
	for (const notice of notices) {
		const next = `[Original grep notice: ${notice.slice(1, -1)}]`;
		if (byteLength([...footerLines, next].join("\n")) + 2 >= maxBytes) break;
		footerLines.push(next);
	}
	const footer = footerLines.join("\n");
	const footerFits = byteLength(footer) + 2 < maxBytes;
	const bodyBudget = Math.max(1, maxBytes - byteLength(footer) - 2);
	const bodyLines: string[] = ["Matches by file:"];
	for (const group of groups.values()) bodyLines.push(`${group.path} (${group.matchCount})`);
	bodyLines.push("", "Representative matches:");
	for (const group of groups.values()) {
		bodyLines.push(`${group.path}:`);
		for (const sample of group.samples) bodyLines.push(`  ${sample.line}: ${sample.text}`);
	}
	if (groups.size === 0) bodyLines.push(exactOutput.slice(0, 1_000));
	const fitted = fitPlainLines(bodyLines, bodyBudget);
	const text = `${fitted.text}\n\n${footer}`;
	return {
		text,
		matchCount,
		fileCount: groups.size,
		allFilesIndexed: footerFits && groups.size > 0 && fitted.shown >= 1 + groups.size,
		indexTruncated: fitted.shown < bodyLines.length,
	};
}

function stableKey(toolName: string, input: unknown): string {
	return `${toolName}:${JSON.stringify(input, Object.keys((input as object) ?? {}).sort())}`;
}

export default function extension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			`Read files without sacrificing exact behavior. With action omitted or action=exact, this delegates unchanged to pi's built-in read (including images and ${DEFAULT_MAX_LINES}-line/${DEFAULT_MAX_BYTES / 1024}KB truncation). ` +
			"For large source files, action=outline returns signatures and line ranges; action=symbol returns one named symbol; action=focus returns bounded regex windows.",
		promptSnippet: "Read files exactly, or outline/focus large source files and read one symbol",
		promptGuidelines: [
			"Use read action=outline before exact-reading a large supported Rust/TypeScript/JavaScript/Python/Shell file or Makefile, then read action=symbol for the relevant declaration.",
			"Use read action=focus for bounded regex windows in one text file; use exact read when exhaustive verbatim content is required.",
		],
		parameters: readSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.action || params.action === "exact") {
				const builtIn = createReadToolDefinition(ctx.cwd);
				return builtIn.execute(
					toolCallId,
					{ path: params.path, offset: params.offset, limit: params.limit },
					signal,
					onUpdate,
					ctx,
				);
			}
			const absolutePath = path.resolve(ctx.cwd, params.path.replace(/^@/, ""));
			return optimizedRead(params, absolutePath, signal);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			`Search using pi's grep. Results up to ${formatSize(DEFAULT_OPTIMIZED_BYTES)} stay exact; larger output becomes a cross-file index linked to the exact result. mode=exact disables indexing.`,
		promptSnippet: "Search code; oversized results become a bounded index with full exact output preserved",
		promptGuidelines: [
			"Use grep with context=0 for initial discovery, then read action=symbol, action=focus, or exact offset/limit for relevant files.",
			"Use grep mode=exact, or read the full exact result path from a smart grep index, when every returned context line is required.",
		],
		parameters: grepSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtIn = createGrepToolDefinition(ctx.cwd);
			const exact = await builtIn.execute(
				toolCallId,
				{
					pattern: params.pattern,
					path: params.path,
					glob: params.glob,
					ignoreCase: params.ignoreCase,
					literal: params.literal,
					context: params.context,
					limit: params.limit,
				},
				signal,
				onUpdate,
				ctx,
			);
			if (params.mode === "exact") return exact;
			const content = exact.content[0];
			if (content?.type !== "text") return exact;
			const maxBytes = params.maxBytes ?? DEFAULT_OPTIMIZED_BYTES;
			if (byteLength(content.text) <= DEFAULT_OPTIMIZED_BYTES) return exact;
			let outputDir: string | undefined;
			try {
				outputDir = await mkdtemp(path.join(tmpdir(), "pi-skim-grep-"));
				const fullOutputPath = path.join(outputDir, "exact-output.txt");
				const indexed = compactGrepOutput(
					content.text,
					fullOutputPath,
					maxBytes,
					params.maxPerFile ?? DEFAULT_GREP_MAX_PER_FILE,
				);
				if (!indexed.allFilesIndexed) {
					await rm(outputDir, { recursive: true, force: true });
					return exact;
				}
				await writeFile(fullOutputPath, content.text, "utf8");
				return {
					content: [{ type: "text" as const, text: indexed.text }],
					details: exact.details as GrepToolDetails | undefined,
				};
			} catch {
				if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
				// Optimization failure must never make a successful exact grep fail.
				return exact;
			}
		},
	});

	if (process.env.PI_SKIM_NUDGE === "0") return;
	const readNudges = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType<"read", SmartReadInput>("read", event)) return;
		const input = event.input;
		if (
			input.action !== undefined ||
			input.offset !== undefined ||
			input.limit !== undefined
		) {
			return;
		}
		const absolutePath = path.resolve(ctx.cwd, input.path.replace(/^@/, ""));
		const key = stableKey("read", { path: absolutePath });
		if (readNudges.has(key)) return;
		// Reserve before async detection/stat so parallel identical reads cannot both be blocked.
		readNudges.add(key);
		if (!(await detectSource(absolutePath))) {
			readNudges.delete(key);
			return;
		}
		let bytes: number;
		try {
			bytes = (await stat(absolutePath)).size;
		} catch {
			readNudges.delete(key);
			return;
		}
		if (bytes < READ_NUDGE_BYTES) {
			readNudges.delete(key);
			return;
		}
		return {
			block: true,
			reason:
				`This is a whole-file read of ${formatSize(bytes)} for supported source ${input.path}. First use read action=outline/symbol, or an exact range. ` +
				"Re-issuing this exact read bypasses the one-time nudge and preserves full built-in behavior.",
		};
	});
}
