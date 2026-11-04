// Every key the editor binds, in one table, so that a sheet of them can be drawn from it and a test can hold them apart: none
// is a piano key, none needs Alt, and no two meet where both work. A key is matched by where it is, `KeyboardEvent.code`, as
// the piano keys are, so ` is the key left of 1 on any layout. Mod is ⌘ on a Mac and Ctrl elsewhere, which leaves Ctrl-click
// free to be a right-click on a Mac. There is no Alt: it is Option on a Mac, and browsers take Alt keys for their menus.
//
// An editor still handles its own keys where it is, and asks `matches` whether an event is one of them.

// Where a key works. Song holds the arrangement, the roll and step entry, and Patch holds the graph, so a key bound in one
// works in what it holds as well. Step entry is a mode of the roll that takes over some of its keys, so the two can share,
// and while it is on its keys come before the roll's and the arrangement's.
export type Scope = 'everywhere' | 'song' | 'patch' | 'roll' | 'arrangement' | 'graph' | 'step' | 'tempo' | 'head';

export const SCOPES: Record<Scope, { name: string; within: Scope | null }> = {
	everywhere: { name: 'Everywhere', within: null },
	song: { name: 'Song view', within: 'everywhere' },
	patch: { name: 'Patch view', within: 'everywhere' },
	roll: { name: 'Piano roll', within: 'song' },
	arrangement: { name: 'Arrangement', within: 'song' },
	step: { name: 'Step entry', within: 'song' },
	tempo: { name: 'Tempo lane', within: 'song' },
	head: { name: 'Track heads', within: 'song' },
	graph: { name: 'Graph', within: 'patch' }
};

export type Shortcut = {
	id: string;
	code: string; // `KeyboardEvent.code`
	mod?: true; // ⌘ on a Mac, and Ctrl elsewhere
	shift?: true;
	scope: Scope;
	description: string;
	piano?: true; // One of the piano's own keys, the only bindings a piano key may have
};

export const SHORTCUTS = [
	// The transport, and what acts on the whole page.
	{ id: 'play', code: 'Space', scope: 'everywhere', description: 'Play or stop the song' },
	{ id: 'start', code: 'Home', scope: 'everywhere', description: 'Go back to the start' },
	{ id: 'undo', code: 'KeyZ', mod: true, scope: 'everywhere', description: 'Undo' },
	{ id: 'redo', code: 'KeyZ', mod: true, shift: true, scope: 'everywhere', description: 'Redo' },
	{ id: 'save', code: 'KeyS', mod: true, scope: 'everywhere', description: 'Save every unsaved patch and song' },
	{
		id: 'escape',
		code: 'Escape',
		scope: 'everywhere',
		description: 'Close a menu, cancel a drag or leave a mode, and then deselect'
	},
	{ id: 'flip', code: 'Backquote', scope: 'everywhere', description: 'Switch between the Song and Patch views' },
	{ id: 'browser', code: 'KeyB', scope: 'everywhere', description: 'Fold or unfold the browser' },
	{ id: 'inspector', code: 'KeyI', scope: 'everywhere', description: 'Fold or unfold the inspector' },
	{ id: 'fit', code: 'Period', scope: 'everywhere', description: 'Fit the view to what is in it' },
	// Browsers open a menu for Shift+F10 on some systems and not on others, a Mac's among them, so the editor opens its own.
	{ id: 'menu', code: 'F10', shift: true, scope: 'everywhere', description: 'Open the menu of what has focus' },
	{ id: 'shortcuts', code: 'Slash', shift: true, scope: 'everywhere', description: 'Show these shortcuts' },
	{
		id: 'quick-open',
		code: 'KeyK',
		mod: true,
		scope: 'everywhere',
		description: 'Open a song, an example or a patch by name'
	},

	// What is chosen, in whichever editor is in use.
	{ id: 'select-all', code: 'KeyA', mod: true, scope: 'everywhere', description: 'Choose everything' },
	{ id: 'copy', code: 'KeyC', mod: true, scope: 'everywhere', description: 'Copy what is chosen' },
	{ id: 'paste', code: 'KeyV', mod: true, scope: 'everywhere', description: 'Paste' },
	{ id: 'duplicate', code: 'KeyD', mod: true, scope: 'everywhere', description: 'Duplicate what is chosen' },

	// The piano's own keys, and the velocity of the notes they and the mouse put down.
	{ id: 'octave-down', code: 'KeyZ', scope: 'everywhere', description: 'Keys down an octave', piano: true },
	{ id: 'octave-up', code: 'KeyX', scope: 'everywhere', description: 'Keys up an octave', piano: true },
	{ id: 'softer', code: 'KeyC', scope: 'everywhere', description: 'Lower the velocity of new notes' },
	{ id: 'louder', code: 'KeyV', scope: 'everywhere', description: 'Raise the velocity of new notes' },

	// Writing notes.
	{ id: 'step-entry', code: 'KeyR', scope: 'song', description: 'Turn step entry on or off' },
	{ id: 'record', code: 'KeyR', shift: true, scope: 'song', description: 'Record, snapped to the grid' },
	{ id: 'draw-shorter', code: 'BracketLeft', scope: 'song', description: 'Shorter Draw length' },
	{ id: 'draw-longer', code: 'BracketRight', scope: 'song', description: 'Longer Draw length' },

	{ id: 'node-search', code: 'KeyN', scope: 'patch', description: 'Find a node to add' },

	{ id: 'roll.delete', code: 'Delete', scope: 'roll', description: 'Delete the chosen notes' },
	{ id: 'roll.backspace', code: 'Backspace', scope: 'roll', description: 'Delete the chosen notes' },
	{ id: 'roll.up', code: 'ArrowUp', scope: 'roll', description: 'Chosen notes up a semitone' },
	{ id: 'roll.down', code: 'ArrowDown', scope: 'roll', description: 'Chosen notes down a semitone' },
	{ id: 'roll.octave-up', code: 'ArrowUp', shift: true, scope: 'roll', description: 'Chosen notes up an octave' },
	{ id: 'roll.octave-down', code: 'ArrowDown', shift: true, scope: 'roll', description: 'Chosen notes down an octave' },
	{ id: 'roll.earlier', code: 'ArrowLeft', scope: 'roll', description: 'Chosen notes a Snap step earlier' },
	{ id: 'roll.later', code: 'ArrowRight', scope: 'roll', description: 'Chosen notes a Snap step later' },

	// While step entry is on, it takes these from the roll and the arrangement. Esc, everywhere, leaves it.
	{
		id: 'step.rest',
		code: 'ArrowRight',
		scope: 'step',
		description: 'A rest as long as the Draw length, or with piano keys held, their notes a Snap step longer'
	},
	{ id: 'step.back', code: 'Backspace', scope: 'step', description: 'Take back the last step' },
	{ id: 'step.up', code: 'ArrowUp', scope: 'step', description: 'The last step’s notes up a semitone' },
	{ id: 'step.down', code: 'ArrowDown', scope: 'step', description: 'The last step’s notes down a semitone' },
	{
		id: 'step.octave-up',
		code: 'ArrowUp',
		shift: true,
		scope: 'step',
		description: 'The last step’s notes up an octave'
	},
	{
		id: 'step.octave-down',
		code: 'ArrowDown',
		shift: true,
		scope: 'step',
		description: 'The last step’s notes down an octave'
	},

	{ id: 'arrangement.delete', code: 'Delete', scope: 'arrangement', description: 'Take the chosen clip off its track' },
	{
		id: 'arrangement.split',
		code: 'KeyE',
		mod: true,
		scope: 'arrangement',
		description: 'Split the chosen clip at the playhead'
	},
	{
		id: 'arrangement.backspace',
		code: 'Backspace',
		scope: 'arrangement',
		description: 'Take the chosen clip off its track'
	},

	// A change chosen in the Tempo lane. Each is one step to undo.
	{ id: 'tempo.delete', code: 'Delete', scope: 'tempo', description: 'Delete the chosen tempo change' },
	{ id: 'tempo.backspace', code: 'Backspace', scope: 'tempo', description: 'Delete the chosen tempo change' },
	{ id: 'tempo.up', code: 'ArrowUp', scope: 'tempo', description: 'The chosen tempo change 1 BPM faster' },
	{ id: 'tempo.down', code: 'ArrowDown', scope: 'tempo', description: 'The chosen tempo change 1 BPM slower' },
	{
		id: 'tempo.up-ten',
		code: 'ArrowUp',
		shift: true,
		scope: 'tempo',
		description: 'The chosen tempo change 10 BPM faster'
	},
	{
		id: 'tempo.down-ten',
		code: 'ArrowDown',
		shift: true,
		scope: 'tempo',
		description: 'The chosen tempo change 10 BPM slower'
	},

	// A track head's fader or pan, with focus, as a slider takes them.
	{ id: 'head.up', code: 'ArrowUp', scope: 'head', description: 'The fader up a step, or the pan a step right' },
	{ id: 'head.right', code: 'ArrowRight', scope: 'head', description: 'The fader up a step, or the pan a step right' },
	{ id: 'head.down', code: 'ArrowDown', scope: 'head', description: 'The fader down a step, or the pan a step left' },
	{ id: 'head.left', code: 'ArrowLeft', scope: 'head', description: 'The fader down a step, or the pan a step left' },

	{ id: 'graph.delete', code: 'Delete', scope: 'graph', description: 'Delete the chosen nodes, or the chosen wire' },
	{
		id: 'graph.backspace',
		code: 'Backspace',
		scope: 'graph',
		description: 'Delete the chosen nodes, or the chosen wire'
	}
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

export function shortcut(id: ShortcutId): Shortcut {
	return BY_ID.get(id)!;
}

// Which key Mod is here: ⌘, which is Meta, on a Mac or an iPad, and Ctrl everywhere else. This is the one place that asks.
export function modKey(platform = currentPlatform()): 'Meta' | 'Control' {
	return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control';
}

function currentPlatform(): string {
	if (typeof navigator === 'undefined') return '';
	const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return hints?.platform || navigator.platform || '';
}

type Modifiers = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

// Whether Mod is held, for a key, a click, a drag or a wheel.
export function modHeld(event: Pick<Modifiers, 'metaKey' | 'ctrlKey'>, mod = modKey()): boolean {
	return mod === 'Meta' ? event.metaKey : event.ctrlKey;
}

// Whether a key is this binding, with exactly its modifiers. The Ctrl that isn't Mod on a Mac, and Alt anywhere, match nothing.
export function matches(event: Modifiers & Pick<KeyboardEvent, 'code'>, id: ShortcutId, mod = modKey()): boolean {
	const binding = shortcut(id);
	const other = mod === 'Meta' ? event.ctrlKey : event.metaKey;
	return (
		event.code === binding.code &&
		modHeld(event, mod) === !!binding.mod &&
		event.shiftKey === !!binding.shift &&
		!other &&
		!event.altKey
	);
}

const NAMES: Record<string, string> = {
	Backquote: '`',
	Period: '.',
	BracketLeft: '[',
	BracketRight: ']',
	Escape: 'Esc',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→'
};

// Keys whose Shift is a character of its own, written as that character: ? rather than Shift+/.
const SHIFTED: Record<string, string> = { Slash: '?' };

// How a binding is written, as a Mac writes it (⇧⌘Z) or as everywhere else does (Ctrl+Shift+Z).
export function label(id: ShortcutId, mod = modKey()): string {
	const binding = shortcut(id);
	const shifted = binding.shift && !binding.mod ? SHIFTED[binding.code] : undefined;
	const key = shifted ?? NAMES[binding.code] ?? binding.code.replace(/^(Key|Digit)/, '');
	const shift = binding.shift && !shifted;
	if (mod === 'Meta') return `${shift ? '⇧' : ''}${binding.mod ? '⌘' : ''}${key}`;
	return [binding.mod && 'Ctrl', shift && 'Shift', key].filter(Boolean).join('+');
}

// A binding as `aria-keyshortcuts` writes it, so a screen reader can say the key a menu item shares: Control+Shift+Z.
export function ariaKeys(id: ShortcutId, mod = modKey()): string {
	const binding = shortcut(id);
	const key = binding.code.replace(/^(Key|Digit)/, '');
	return [binding.mod && mod, binding.shift && 'Shift', key].filter(Boolean).join('+');
}

// The sheet ? opens: each place keys work, in the order a session meets them, and in each what its keys do. Bindings that do
// one thing, as Delete and Backspace do, share a row.
const SHEET_ORDER: Scope[] = ['everywhere', 'song', 'roll', 'step', 'arrangement', 'tempo', 'head', 'patch', 'graph'];

export type SheetRow = { keys: string[]; description: string };

export function sheet(mod = modKey()): { scope: Scope; name: string; rows: SheetRow[] }[] {
	return SHEET_ORDER.map((scope) => {
		const rows: SheetRow[] = [];
		for (const binding of SHORTCUTS as readonly Shortcut[]) {
			if (binding.scope !== scope || binding.piano) continue;
			const key = label(binding.id as ShortcutId, mod);
			const same = rows.find((row) => row.description === binding.description);
			if (same) same.keys.push(key);
			else rows.push({ keys: [key], description: binding.description });
		}
		return { scope, name: SCOPES[scope].name, rows };
	}).filter((group) => group.rows.length);
}

// Inputs that are pressed or dragged rather than typed into. Space and the table's keys go past them, as they go past a button.
const PRESSED = new Set(['button', 'submit', 'reset', 'image', 'range']);

// The keys a select uses, which a chooser (`chooser` in Fields.ts) keeps, and leaves the rest to the page.
const CHOOSING = new Set([
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'Enter',
	' ',
	'Tab',
	'Escape'
]);

// Whether focus is in something that takes keys as its own: a text field, a textarea, a select, a checkbox or a radio
// button, or editable text. A key pressed there is left to it, and a button or a slider leaves Space to the transport. A
// toolbar's chooser, such as Snap or Draw, is a setting rather than a field, so it keeps only the keys it uses: the piano keys,
// R, [ and ] and Mod+Z still work while it has focus. Without the key, a chooser is taken to keep it.
export function typingIn(target: EventTarget | null, key?: string): boolean {
	const field = (target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"]') as
		(Element & { type?: string }) | null | undefined;
	if (!field) return false;
	if (key !== undefined && field.tagName === 'SELECT' && field.hasAttribute('data-chooser')) return CHOOSING.has(key);
	return !(field.tagName === 'INPUT' && PRESSED.has(field.type ?? ''));
}
