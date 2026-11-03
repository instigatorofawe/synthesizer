import { expect, test as base, type Page } from '@playwright/test';
import { undoButton } from './Chrome.ts';

// A patch seen whole and modulated: Fit pressed again shows all of it, "Modulate this input…" makes a filter envelope in one
// gesture, and a lane in the Song view can move any input inside a patch.

const test = base.extend({
	page: async ({ page }, use) => {
		const goto = page.goto.bind(page);
		page.goto = async (...args) => {
			const response = await goto(...args);
			if (response?.ok()) await page.locator('body[data-hydrated]').waitFor({ state: 'attached' });
			return response;
		};
		await use(page);
	}
});

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

test.use({ viewport: { width: 1440, height: 900 } });

const patchEditor = (page: Page) => page.getByRole('region', { name: 'Patch editor' });
const graph = (page: Page) => page.getByTestId('graph');
const nodes = (page: Page) => graph(page).locator('g.node');
const sideTab = (page: Page, name: 'Node' | 'Patch' | 'JSON') =>
	page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name, exact: true });
const settled = (page: Page) =>
	expect(page.getByTestId('status')).toHaveAttribute('aria-busy', 'false', { timeout: 10000 });

// How many of the graph's nodes are on the canvas, whole.
const onCanvas = (page: Page) =>
	graph(page).evaluate((svg) => {
		const box = svg.getBoundingClientRect();
		return [...svg.querySelectorAll('g.node')].filter((node) => {
			const at = node.getBoundingClientRect();
			return (
				at.left >= box.left - 1 && at.right <= box.right + 1 && at.top >= box.top - 1 && at.bottom <= box.bottom + 1
			);
		}).length;
	});

// A new patch is a sine through an envelope: note 1, mtof 2, osc 3, env 4, mul 5 and out 6. This puts a saw through filter 7,
// at a cutoff of 900, between the oscillator and the envelope's multiply, and wires `extra` too.
async function filteredPatch(page: Page, name: string, extra: object[] = []) {
	await page.goto('/');
	await page.getByRole('button', { name: 'New patch', exact: true }).click();
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
	await sideTab(page, 'JSON').click();
	const json = page.getByLabel('Graph JSON');
	const doc = JSON.parse(await json.inputValue());
	const osc = doc.nodes.find((node: { id: number }) => node.id === 3);
	osc.wave = 'saw';
	doc.nodes.push({ id: 7, type: 'biquad', inputs: { cutoff: 900 }, x: osc.x + 190, y: osc.y });
	doc.edges = [
		...doc.edges.filter((edge: { from: number; to: number }) => !(edge.from === 3 && edge.to === 5)),
		{ from: 3, port: 'out', to: 7, input: 'in' },
		{ from: 7, port: 'out', to: 5, input: 'a' },
		...extra
	];
	await json.fill(JSON.stringify(doc, null, 1));
	await json.blur();
	await expect(page.getByTestId('node-7')).toBeAttached();
	await sideTab(page, 'Patch').click();
	await patchEditor(page).getByRole('button', { name: 'Tidy' }).click();
	await expect(nodes(page)).toHaveCount(7);
}

async function graphJson(page: Page) {
	await sideTab(page, 'JSON').click();
	const doc = JSON.parse(await page.getByLabel('Graph JSON').inputValue());
	await sideTab(page, 'Patch').click();
	return doc as {
		params: { name: string; min: number; max: number; default: number }[];
		nodes: { id: number; type: string; inputs?: Record<string, number> }[];
		edges: { from: number; to: number; input?: string }[];
	};
}

test('Fit pressed again shows the whole patch, however small, and a third press goes back', async ({ page }) => {
	await page.goto('/?patch=builtin-VelocityFilterAmp&view=patch');
	const fit = patchEditor(page).getByTestId('fit');
	await expect(fit).toHaveAttribute('data-fit', 'readable'); // The first view of a patch is a fit
	const total = await nodes(page).count();
	await expect.poll(() => onCanvas(page)).toBeLessThan(total); // Cut short at the smallest text that reads
	await expect(patchEditor(page).getByTestId('zoom')).toHaveText('100%');

	await fit.click();
	await expect(fit).toHaveAttribute('data-fit', 'whole');
	await expect.poll(() => onCanvas(page)).toBe(total);
	await expect(patchEditor(page).getByTestId('zoom')).not.toHaveText('100%');

	await page.keyboard.press('.');
	await expect(fit).toHaveAttribute('data-fit', 'readable');
	await expect(patchEditor(page).getByTestId('zoom')).toHaveText('100%');
});

test("Modulate this input puts an envelope on a filter's cutoff, through a snap and a Control, as one edit", async ({
	page
}) => {
	await filteredPatch(page, 'Swept by hand');
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.getByTestId('value-7-cutoff').click({ button: 'right' });
	await page
		.getByRole('menu', { name: 'cutoff of Filter 7' })
		.getByRole('menuitem', { name: 'Modulate this input…' })
		.click();
	const choose = page.getByRole('menu', { name: 'Modulate cutoff with' });
	await expect(choose.getByRole('menuitem', { name: 'Filter 7' })).toHaveCount(0); // Its own output would be a loop
	await choose.getByRole('menuitem', { name: 'Envelope 4', exact: true }).click();
	await expect(nodes(page)).toHaveCount(11);
	await expect(page.getByTestId('in-7-cutoff')).toHaveClass(/wired/);
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	const doc = await graphJson(page);
	expect(doc.params).toMatchObject([{ name: 'cutoff amount', default: 9550 }]);
	const type = (id: number) => doc.nodes.find((node) => node.id === id)?.type;
	const into = (to: number, input: string) => doc.edges.find((edge) => edge.to === to && edge.input === input)!.from;
	const add = into(7, 'cutoff');
	expect(type(add)).toBe('add');
	expect(doc.nodes.find((node) => node.id === add)?.inputs).toEqual({ b: 900 });
	const mul = into(add, 'a');
	expect(type(mul)).toBe('mul');
	expect(type(into(mul, 'b'))).toBe('param');
	const snap = into(mul, 'a');
	expect(type(snap)).toBe('snap');
	expect(into(snap, 'in')).toBe(4);

	// The amount is a Control, and one Undo takes all of it back.
	await expect(page.getByRole('slider', { name: 'cutoff amount' })).toBeVisible();
	await undoButton(page).click();
	await expect(nodes(page)).toHaveCount(7);
	await expect(page.getByTestId('in-7-cutoff')).not.toHaveClass(/wired/);
});

test('an envelope wired straight to a cutoff is offered Modulate beside the snap', async ({ page }) => {
	await filteredPatch(page, 'Wired cutoff', [{ from: 4, port: 'out', to: 7, input: 'cutoff' }]);
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(1);
	await graph(page).getByRole('button', { name: 'Modulate this input' }).click();
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(nodes(page)).toHaveCount(11);
});

test('a lane on an input inside a built-in patch copies the patch, gives the input a parameter, and moves it', async ({
	page
}) => {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click();
	await page.getByLabel('New song name').fill('Inside the patch');
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByTestId('track-patch-1')).toHaveText('FurElise Electric piano');

	const add = page.getByLabel('Add a lane');
	const inside = add.locator('optgroup[label="In FurElise Electric piano"] option');
	await expect(inside.first()).toBeAttached();
	const option = (await inside.first().textContent())!;
	const input = option.split(' · ')[1];
	await add.selectOption({ label: option });
	await expect(page.getByRole('button', { name: `Remove lane ${input}` })).toBeVisible();
	await expect(page.getByTestId('lane-0')).toBeVisible();
	await expect(page.getByTestId('track-patch-1')).toHaveText(/FurElise Electric piano.*copy/i);
	await expect(page.getByTestId('unsaved')).toHaveText('2 unsaved'); // The song, and the copy's new parameter
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
});
