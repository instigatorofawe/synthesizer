import type { Page } from '@playwright/test';

// Gates on the page's two real boundaries: the compiler's replies, as they reach the page, and images on their way to the
// engine. A test closes a gate, sees what it holds, and opens it, so the order it tests is forced rather than hoped for. Held
// messages pass on unchanged: only when they arrive differs. Nothing is timed, except under a stress run (Fixtures.ts), which
// opens each gate after a delay to slow the page's compiles or loads the way a slow machine would.
export type Gate = 'compile' | 'load';

type Held = { closed: boolean; delay: number; held: (() => void)[] };
type Gated = Window & { gates?: Record<Gate, Held> };

// Installs the gates before the page's own scripts run. Each starts open, unless it is in `closed`, and with no delay unless one
// is given.
export async function installGates(page: Page, closed: Gate[] = [], delays: Partial<Record<Gate, number>> = {}) {
	await page.addInitScript(
		({ closed, delays }) => {
			const page = window as Gated;
			// Installed already, as a stress run does for every page: this one only closes what it says.
			if (page.gates) {
				for (const gate of closed) page.gates[gate].closed = true;
				return;
			}
			const gates: Record<Gate, Held> = {
				compile: { closed: closed.includes('compile'), delay: delays.compile ?? 0, held: [] },
				load: { closed: closed.includes('load'), delay: delays.load ?? 0, held: [] }
			};
			page.gates = gates;
			const pass = (gate: Held, send: () => void) => {
				if (gate.closed) gate.held.push(send);
				else if (gate.delay) setTimeout(send, gate.delay);
				else send();
			};
			// The compiler's worker only: Export WAV renders in a worker of its own. (No private fields here: this runs as the
			// page's own script, without the helpers the test's compiler would give them.)
			const compilers = new WeakSet<Worker>();
			window.Worker = class extends window.Worker {
				constructor(url: string | URL, options?: WorkerOptions) {
					super(url, options);
					if (String(url).includes('CompilerWorker')) compilers.add(this);
				}
				set onmessage(handler: ((event: MessageEvent) => void) | null) {
					super.onmessage =
						handler && compilers.has(this) ? (event) => pass(gates.compile, () => handler.call(this, event)) : handler;
				}
				get onmessage() {
					return super.onmessage;
				}
			};
			const post = MessagePort.prototype.postMessage;
			MessagePort.prototype.postMessage = function (
				this: MessagePort,
				...args: Parameters<MessagePort['postMessage']>
			) {
				if ((args[0] as { type?: string })?.type === 'load') pass(gates.load, () => post.apply(this, args));
				else post.apply(this, args);
			};
		},
		{ closed, delays }
	);
}

export const closeGate = (page: Page, gate: Gate) =>
	page.evaluate((gate) => void ((window as Gated).gates![gate].closed = true), gate);

// How many messages the gate holds now.
export const heldAt = (page: Page, gate: Gate) =>
	page.evaluate((gate) => (window as Gated).gates![gate].held.length, gate);

// Lets what the gate holds through, in order, and leaves it open.
export const openGate = (page: Page, gate: Gate) =>
	page.evaluate((gate) => {
		const held = (window as Gated).gates![gate];
		held.closed = false;
		for (const send of held.held.splice(0)) send();
	}, gate);
