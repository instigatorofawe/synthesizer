// "Mod" is the platform's command key: ⌘ on a Mac and Ctrl elsewhere. A Mac takes Ctrl-click for a right-click, so Ctrl can't
// be Mod there. No gesture uses Alt, which is Option on a Mac, and which opens a menu bar or switches tabs on other systems.
export const onMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function isMod(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, mac = onMac()): boolean {
	return mac ? event.metaKey : event.ctrlKey;
}
