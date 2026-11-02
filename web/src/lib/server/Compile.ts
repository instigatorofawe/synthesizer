import createCompiler, { type CompilerModule } from '#lib/wasm/ModsynthCompiler.js';
import type { CatalogEntry } from '#lib/GraphEdit.ts';
import { buildRequest, type CompileReport, type RequestOptions } from '#lib/Request.ts';
import type { Snapshot } from '#lib/server/Repository.ts';

let compiler: Promise<CompilerModule> | undefined;

// What the graph editor offers, from the table the compiler reads.
export async function nodeCatalog(): Promise<CatalogEntry[]> {
	compiler ??= createCompiler();
	return JSON.parse((await compiler).catalog());
}

// A request as it stands, such as a recipe, which is already one.
export async function compileRequest(request: string) {
	compiler ??= createCompiler();
	const { report, image } = (await compiler).compile(request);
	return { report: JSON.parse(report) as CompileReport, image };
}

// The same wasm module the browser worker runs, so an export matches what was previewed.
export async function compileSnapshot(snapshot: Snapshot, options: RequestOptions = {}) {
	compiler ??= createCompiler();
	const module = await compiler;
	const { report, image } = module.compile(buildRequest(snapshot.patches, snapshot.assets, snapshot.programs, options));
	return { report: JSON.parse(report) as CompileReport, image };
}
