// Copies the wasm build into the app. The engine goes to static/, because a worklet loads it by URL. The compiler goes to
// src/lib/wasm/, because both the browser worker and the server import it as a module.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(web, '..', 'build', 'wasm');

for (const [file, target] of [
	['Modsynth.js', join(web, 'static', 'wasm')],
	['ModsynthCompiler.js', join(web, 'src', 'lib', 'wasm')]
]) {
	const from = join(build, file);
	if (!existsSync(from)) {
		console.error(`${from} is missing. Run: emcmake cmake -B build/wasm && cmake --build build/wasm`);
		process.exit(1);
	}
	mkdirSync(target, { recursive: true });
	copyFileSync(from, join(target, file));
}
