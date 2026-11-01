import createCompiler, { type CompilerModule } from '#lib/wasm/ModsynthCompiler.js';
import { buildRequest, type CompileReport, type RequestOptions } from '#lib/Request.ts';
import type { Snapshot } from '#lib/server/Repository.ts';

let compiler: Promise<CompilerModule> | undefined;

// The same wasm module the browser worker runs, so an export matches what was previewed.
export async function compileSnapshot(snapshot: Snapshot, options: RequestOptions = {}) {
	compiler ??= createCompiler();
	const module = await compiler;
	const { report, image } = module.compile(
		buildRequest(snapshot.patches, snapshot.assets, snapshot.programs, options)
	);
	return { report: JSON.parse(report) as CompileReport, image };
}
