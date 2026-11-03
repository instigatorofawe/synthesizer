import { describe, expect, it } from 'vitest';
import { isMod } from '#lib/Modifier.ts';

describe('the Mod key', () => {
	it('is ⌘ on a Mac, where Ctrl-click is a right-click', () => {
		expect(isMod({ metaKey: true, ctrlKey: false }, true)).toBe(true);
		expect(isMod({ metaKey: false, ctrlKey: true }, true)).toBe(false);
	});

	it('is Ctrl everywhere else', () => {
		expect(isMod({ metaKey: false, ctrlKey: true }, false)).toBe(true);
		expect(isMod({ metaKey: true, ctrlKey: false }, false)).toBe(false);
	});
});
