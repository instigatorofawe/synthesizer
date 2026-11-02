import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOAD_ERRORS } from './AudioEngine.ts';

describe('LOAD_ERRORS', () => {
	it('has every message the engine can report, at its own index', () => {
		const header = readFileSync(new URL('../../../include/modsynth/Loader.hpp', import.meta.url), 'utf8');
		const names = /enum class LoadError : u8 \{([^}]*)\}/.exec(header)![1].match(/\w+/g)!;
		const messages = names.map((name) => new RegExp(`case LoadError::${name}:\\s*return "([^"]*)"`).exec(header)![1]);
		expect(LOAD_ERRORS.slice(1)).toEqual(messages.slice(1));
		expect(LOAD_ERRORS[0]).toBe('');
	});
});
