// A field typed in keeps the keys until it is left, so Space and the piano keys don't work while focus stays in one. As the
// top bar's fields do, Enter keeps what was typed and leaves the field, and Esc leaves it too, putting back the number that
// was there. A field that handles these keys itself, a combobox, and a dialog's fields are left alone.
import { matches } from '#lib/Shortcuts.ts';

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
