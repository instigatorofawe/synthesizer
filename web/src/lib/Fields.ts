// A field typed in keeps the keys until it is left, so Space and the piano keys don't work while focus stays in one. As the
// top bar's fields do, Enter keeps what was typed and leaves the field, and Esc leaves it too, putting back the number that
// was there. A field that handles these keys itself, a combobox, and a dialog's fields are left alone.
import { matches, typingIn } from '#lib/Shortcuts.ts';

const TYPED = new Set(['text', 'number', 'search']);

// An action for a container. Svelte hears an element's own keys where the page is mounted, so these are heard on the window,
// after them, and only for fields in the container.
export function leavesFields(container: HTMLElement) {
	const was = new WeakMap<HTMLInputElement, string>(); // A number field's value when it took focus

	const field = (target: EventTarget | null): HTMLInputElement | null =>
		target instanceof HTMLInputElement &&
		TYPED.has(target.type) &&
		target.getAttribute('role') !== 'combobox' &&
		!target.closest('dialog')
			? target
			: null;

	const focusin = (event: FocusEvent) => {
		const input = field(event.target);
		if (input?.type === 'number') was.set(input, input.value);
	};
	const keydown = (event: KeyboardEvent) => {
		const input = field(event.target);
		if (!input || event.defaultPrevented || !container.contains(input)) return;
		if (event.key === 'Enter') {
			input.blur();
		} else if (matches(event, 'escape')) {
			event.preventDefault();
			event.stopPropagation(); // It leaves the field and nothing else
			const before = was.get(input);
			if (before !== undefined) input.value = before;
			input.blur();
		}
	};

	container.addEventListener('focusin', focusin);
	window.addEventListener('keydown', keydown);
	return {
		destroy() {
			container.removeEventListener('focusin', focusin);
			window.removeEventListener('keydown', keydown);
		}
	};
}

// A chooser in a toolbar, such as Snap or Draw: a setting rather than a field. Chosen with the pointer, it gives focus back to
// what had it, as a desktop app's toolbar does, so the keys go on working where they were. While it has focus, from the keyboard,
// it keeps only the keys a select uses (`typingIn`).
export function chooser(select: HTMLSelectElement) {
	select.setAttribute('data-chooser', '');
	let before: Element | null = null; // What had focus when the pointer pressed it
	const pressed = () => {
		if (document.activeElement !== select) before = document.activeElement;
	};
	const chosen = () => {
		const back = before;
		before = null;
		if (!back) return;
		const focusable = back instanceof HTMLElement || back instanceof SVGElement;
		if (focusable && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
		else select.blur();
	};
	// Chosen by the keys, it keeps focus, so the keys can go on choosing. A key it doesn't use, such as a piano key, is the
	// page's, and focus leaves it first, so it doesn't also choose the option that key starts, as a select does with letters.
	const keyed = (event: KeyboardEvent) => {
		before = null;
		if (!typingIn(select, event.key) && !event.metaKey && !event.ctrlKey) select.blur();
	};
	select.addEventListener('pointerdown', pressed);
	select.addEventListener('change', chosen);
	select.addEventListener('keydown', keyed);
	return {
		destroy() {
			select.removeEventListener('pointerdown', pressed);
			select.removeEventListener('change', chosen);
			select.removeEventListener('keydown', keyed);
		}
	};
}
