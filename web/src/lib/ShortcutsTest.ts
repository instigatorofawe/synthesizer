import { describe, expect, it } from 'vitest';
import { PIANO_KEYS } from '#lib/KeyboardKeys.ts';
import {
	SCOPES,
	SHORTCUTS,
	label,
	matches,
	modHeld,
	modKey,
	sheet,
	typingIn,
	type Scope,
	type Shortcut
} from '#lib/Shortcuts.ts';

const table: readonly Shortcut[] = SHORTCUTS;

const key = (code: string, held: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
	code,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...held
});

// A scope and every scope it sits within, out to everywhere.
function around(scope: Scope): Scope[] {
	const out: Scope[] = [];
	for (let at: Scope | null = scope; at; at = SCOPES[at].within) out.push(at);
	return out;
}

describe('the table of shortcuts', () => {
	it('gives each binding an id of its own, a key and something to say', () => {
		expect(new Set(table.map((s) => s.id)).size).toBe(table.length);
		for (const shortcut of table) {
			expect(shortcut.code, shortcut.id).toMatch(/^[A-Z][A-Za-z0-9]+$/);
			expect(shortcut.description, shortcut.id).not.toBe('');
			expect(SCOPES[shortcut.scope], shortcut.id).toBeDefined();
		}
	});

	it('leaves the piano keys to the piano, bare or with Shift', () => {
		for (const shortcut of table) {
			if (shortcut.mod || shortcut.piano) continue;
			expect(PIANO_KEYS, `${shortcut.id} is on a piano key`).not.toContain(shortcut.code);
		}
		// The piano's own are its octave keys, bare, and nothing else.
		const own = table.filter((s) => s.piano);
		expect(own.map((s) => s.code).sort()).toEqual(['KeyX', 'KeyZ']);
		for (const shortcut of own) expect(shortcut.mod || shortcut.shift).toBeFalsy();
		for (const code of own.map((s) => s.code)) expect(PIANO_KEYS).toContain(code);
	});

	it('uses no Alt key', () => {
		const allowed = new Set(['id', 'code', 'mod', 'shift', 'scope', 'description', 'piano']);
		for (const shortcut of table) {
			for (const field of Object.keys(shortcut)) expect(allowed, `${shortcut.id} has ${field}`).toContain(field);
			expect(shortcut.code, shortcut.id).not.toMatch(/^Alt/);
		}
	});

	it('never has two bindings meet where both work', () => {
		for (const [index, a] of table.entries()) {
			for (const b of table.slice(index + 1)) {
				const same = a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift;
				const meet = around(a.scope).includes(b.scope) || around(b.scope).includes(a.scope);
				expect(same && meet, `${a.id} and ${b.id}`).toBe(false);
			}
		}
	});

	it('keeps the roll and step entry apart, so one can take over the other', () => {
		expect(around('step')).not.toContain('roll');
		expect(around('roll')).toEqual(['roll', 'song', 'everywhere']);
		expect(around('graph')).toEqual(['graph', 'patch', 'everywhere']);
	});

	it('gives step entry →, Backspace, ↑ and ↓, which the roll and the arrangement use when it is off', () => {
		const step = table.filter((s) => s.scope === 'step');
		expect(step.map((s) => [s.id, s.code])).toEqual([
			['step.rest', 'ArrowRight'],
			['step.back', 'Backspace'],
			['step.up', 'ArrowUp'],
			['step.down', 'ArrowDown'],
			['step.octave-up', 'ArrowUp'],
			['step.octave-down', 'ArrowDown']
		]);
		for (const id of ['roll.later', 'roll.backspace', 'arrangement.backspace', 'roll.up', 'roll.down'])
			expect(step.map((s) => s.code)).toContain(table.find((s) => s.id === id)?.code);
		expect(label('step.rest', 'Meta')).toBe('→');
		expect(label('step.back', 'Control')).toBe('Backspace');
	});

	it('lists every key the gestures name', () => {
		const ids = new Set(table.map((s) => s.id));
		for (const id of [
			'play',
			'start',
			'escape',
			'flip',
			'browser',
			'inspector',
			'node-search',
			'fit',
			'step-entry',
			'record',
			'draw-shorter',
			'draw-longer',
			'softer',
			'louder',
			'select-all',
			'copy',
			'paste',
			'duplicate',
			'undo',
			'redo',
			'octave-down',
			'octave-up'
		])
			expect(ids).toContain(id);
	});
});

describe('Mod', () => {
	it('is ⌘ on a Mac and an iPad, and Ctrl everywhere else', () => {
		expect(modKey('MacIntel')).toBe('Meta');
		expect(modKey('macOS')).toBe('Meta');
		expect(modKey('iPad')).toBe('Meta');
		expect(modKey('Win32')).toBe('Control');
		expect(modKey('Linux x86_64')).toBe('Control');
		expect(modKey('')).toBe('Control');
		expect(modHeld(key('KeyZ', { metaKey: true }), 'Meta')).toBe(true);
		expect(modHeld(key('KeyZ', { ctrlKey: true }), 'Meta')).toBe(false);
		expect(modHeld(key('KeyZ', { ctrlKey: true }), 'Control')).toBe(true);
	});
});

describe('matching a key', () => {
	it('takes the binding with exactly its modifiers', () => {
		expect(matches(key('KeyZ', { metaKey: true }), 'undo', 'Meta')).toBe(true);
		expect(matches(key('KeyZ', { ctrlKey: true }), 'undo', 'Control')).toBe(true);
		expect(matches(key('KeyZ', { ctrlKey: true }), 'undo', 'Meta')).toBe(false); // Ctrl isn't Mod on a Mac
		expect(matches(key('KeyZ', { metaKey: true }), 'undo', 'Control')).toBe(false);
		expect(matches(key('KeyZ', { metaKey: true, shiftKey: true }), 'undo', 'Meta')).toBe(false);
		expect(matches(key('KeyZ', { metaKey: true, shiftKey: true }), 'redo', 'Meta')).toBe(true);
		expect(matches(key('KeyZ'), 'undo', 'Meta')).toBe(false);
		expect(matches(key('KeyZ'), 'octave-down', 'Meta')).toBe(true);
		expect(matches(key('KeyY', { metaKey: true }), 'undo', 'Meta')).toBe(false);
	});

	it('goes by where the key is', () => {
		expect(matches(key('Space'), 'play')).toBe(true);
		expect(matches(key('Backquote'), 'flip')).toBe(true);
		expect(matches(key('ArrowUp', { shiftKey: true }), 'roll.octave-up')).toBe(true);
		expect(matches(key('ArrowUp', { shiftKey: true }), 'roll.up')).toBe(false);
	});

	it('takes nothing with Alt, or with a Ctrl that is not Mod', () => {
		expect(matches(key('Space', { altKey: true }), 'play', 'Control')).toBe(false);
		expect(matches(key('KeyZ', { metaKey: true, altKey: true }), 'undo', 'Meta')).toBe(false);
		expect(matches(key('Space', { ctrlKey: true }), 'play', 'Meta')).toBe(false);
		expect(matches(key('Space', { metaKey: true }), 'play', 'Control')).toBe(false);
	});
});

describe('naming a binding', () => {
	it('writes it as each platform does', () => {
		expect(label('redo', 'Meta')).toBe('⇧⌘Z');
		expect(label('redo', 'Control')).toBe('Ctrl+Shift+Z');
		expect(label('save', 'Control')).toBe('Ctrl+S');
		expect(label('flip', 'Meta')).toBe('`');
		expect(label('record', 'Control')).toBe('Shift+R');
		expect(label('play', 'Control')).toBe('Space');
		expect(label('roll.earlier', 'Meta')).toBe('←');
	});

	it('writes a shifted character as itself', () => {
		expect(label('shortcuts', 'Meta')).toBe('?');
		expect(label('shortcuts', 'Control')).toBe('?');
	});
});

describe('the sheet of shortcuts', () => {
	it('lists every binding but the piano’s once, under where it works', () => {
		const groups = sheet('Control');
		const listed = groups.flatMap((group) => group.rows.flatMap((row) => row.keys)).length;
		expect(listed).toBe(table.filter((binding) => !binding.piano).length);
		expect(new Set(groups.map((group) => group.scope)).size).toBe(groups.length);
		expect(groups[0].name).toBe('Everywhere');
	});

	it('puts keys that do one thing in one row', () => {
		const roll = sheet('Control').find((group) => group.scope === 'roll')!;
		expect(roll.rows.find((row) => row.description === 'Delete the chosen notes')!.keys).toEqual([
			'Delete',
			'Backspace'
		]);
	});
});

describe('where keys are typed', () => {
	// An element as `closest` finds it, enough to say what it is.
	const element = (tagName: string, type?: string) => {
		const found = { tagName, type };
		return { closest: (selector: string) => (selector.includes(tagName.toLowerCase()) ? found : null) };
	};

	it('leaves keys to text fields, textareas, selects, checkboxes and radio buttons', () => {
		expect(typingIn(element('INPUT', 'text') as never)).toBe(true);
		expect(typingIn(element('INPUT', 'number') as never)).toBe(true);
		expect(typingIn(element('INPUT', 'checkbox') as never)).toBe(true);
		expect(typingIn(element('INPUT', 'radio') as never)).toBe(true);
		expect(typingIn(element('TEXTAREA') as never)).toBe(true);
		expect(typingIn(element('SELECT') as never)).toBe(true);
	});

	it('takes them from buttons, sliders and the rest of the page', () => {
		expect(typingIn(element('INPUT', 'range') as never)).toBe(false);
		expect(typingIn(element('INPUT', 'button') as never)).toBe(false);
		expect(typingIn(element('BUTTON') as never)).toBe(false);
		expect(typingIn({ closest: () => null } as never)).toBe(false);
		expect(typingIn(null)).toBe(false);
	});
});
