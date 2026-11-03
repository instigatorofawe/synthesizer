import { expect, test as base, type Page } from '@playwright/test';
import { redoButton, startAudio, undoButton } from './Chrome.ts';
import { engineRenders } from './Engine.ts';

// The transport's keys, Stop pressed twice, and an undo history for each patch and timeline that outlasts opening others.

// A page load waits until the page has hydrated, since keys pressed before then go nowhere.
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

// Below 1400 px the browser folds to a rail and opens over the page, and these tests use it as it sits beside the page.
test.use({ viewport: { width: 1440, height: 900 } });

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const state = (page: Page) => page.getByTestId('state');
const tickShown = async (page: Page) => Number(await page.getByTestId('tick').textContent());
const nodes = (page: Page) => page.getByTestId('graph').locator('g.node');

// The side column's tabs: the patch's parameters, or its JSON beside the graph.
async function patchView(page: Page, name: 'Patch' | 'JSON') {
	await page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name }).click();
}

async function newPatch(page: Page, name: string) {
	await page.goto('/');
	await page.getByRole('button', { name: 'New patch', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
	await expect(page.getByTestId('graph')).toBeVisible();
}

// Opens a patch from the browser, which keeps the page, as a reload wouldn't.
async function openPatch(page: Page, name: string) {
	await browser(page).getByRole('link', { name }).click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
}

async function deleteNode(page: Page, id: number) {
	await page.getByTestId(`node-${id}`).locator('rect.title').click();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId(`node-${id}`)).toHaveCount(0);
}

test('Space plays and stops from anywhere but a field, and a button with focus does not take it', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.keyboard.press('Space'); // Starts audio as well
	await expect(state(page)).toHaveAttribute('data-playing', 'true', { timeout: 10000 });
	await page.keyboard.press('Space');
	await expect(state(page)).toHaveAttribute('data-playing', 'false');

	// Pressed, Play would start the song again just after Space stopped it.
	const play = page.getByRole('button', { name: 'Play', exact: true });
	await play.click();
	await expect(state(page)).toHaveAttribute('data-playing', 'true');
	await play.focus();
	await page.keyboard.press('Space');
	await expect(state(page)).toHaveAttribute('data-playing', 'false');
	await engineRenders(page, 0.3);
	await expect(state(page)).toHaveAttribute('data-playing', 'false');

	// The roll has focus, and it doesn't scroll.
	const roll = page.getByTestId('roll');
	await roll.focus();
	const scroll = () => roll.evaluate((e) => e.closest('.roll')!.scrollTop);
	const before = await scroll();
	await page.keyboard.press('Space');
	await expect(state(page)).toHaveAttribute('data-playing', 'true');
	expect(await scroll()).toBe(before);
	await page.keyboard.press('Space');
	await expect(state(page)).toHaveAttribute('data-playing', 'false');

	// A field keeps its Space.
	const name = page.getByLabel('Song name', { exact: true });
	await name.focus();
	await page.keyboard.press('End');
	await page.keyboard.press('Space');
	await expect(name).toHaveValue('Song ');
	await engineRenders(page, 0.3);
	await expect(state(page)).toHaveAttribute('data-playing', 'false');
});

test('Stop pressed again goes back to the start, and so does Home', async ({ page }) => {
	await page.goto('/?timeline=song');
	await startAudio(page);
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	const stop = page.getByRole('button', { name: 'Stop', exact: true });

	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect.poll(() => tickShown(page), { timeout: 8000 }).toBeGreaterThan(500);
	await stop.click();
	await expect(state(page)).toHaveAttribute('data-playing', 'false');
	const stopped = await tickShown(page);
	await engineRenders(page, 0.3);
	expect(await tickShown(page)).toBe(stopped); // Once, it only stops
	expect(stopped).toBeGreaterThan(0);
	await stop.click();
	await expect.poll(() => tickShown(page)).toBe(0);

	// Home, while it plays and while it doesn't.
	await page.keyboard.press('Space');
	await expect.poll(() => tickShown(page), { timeout: 8000 }).toBeGreaterThan(1500);
	await page.keyboard.press('Home');
	await expect.poll(() => tickShown(page)).toBeLessThan(1500);
	await expect(state(page)).toHaveAttribute('data-playing', 'true');
	await page.keyboard.press('Space');
	await expect(state(page)).toHaveAttribute('data-playing', 'false');
	expect(await tickShown(page)).toBeGreaterThan(0);
	await page.keyboard.press('Home');
	await expect.poll(() => tickShown(page)).toBe(0);
});

test("a patch's undo outlasts opening another patch, its JSON and a save", async ({ page }) => {
	await newPatch(page, 'Kept history');
	const undo = undoButton(page);
	const redo = redoButton(page);
	await expect(undo).toBeDisabled();
	await deleteNode(page, 4);

	await openPatch(page, 'Stereo lead');
	await expect(undo).toBeDisabled(); // A history of its own
	await openPatch(page, 'Kept history');
	await expect(page.getByTestId('node-4')).toHaveCount(0);
	await undo.click();
	await expect(page.getByTestId('node-4')).toBeVisible();
	await redo.click();
	await expect(page.getByTestId('node-4')).toHaveCount(0);

	await patchView(page, 'JSON');
	await patchView(page, 'Patch');
	await undo.click();
	await expect(page.getByTestId('node-4')).toBeVisible();

	// A save keeps it, and what is undone is then an edit to save.
	await deleteNode(page, 3);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await undo.click();
	await expect(page.getByTestId('node-3')).toBeVisible();
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
});

test('an edit typed into the JSON is undone as one step, from the graph or the JSON', async ({ page }) => {
	await newPatch(page, 'Typed into');
	const count = await nodes(page).count();
	await patchView(page, 'JSON');
	const json = page.getByLabel('Graph JSON');
	const original = await json.inputValue();
	const graph = JSON.parse(original) as { nodes: { id: number }[]; edges: { from: number; to: number }[] };
	const edited = JSON.stringify(
		{
			...graph,
			nodes: graph.nodes.filter((node) => node.id !== 4),
			edges: graph.edges.filter((edge) => edge.from !== 4 && edge.to !== 4)
		},
		null,
		1
	);
	await json.fill(edited);
	await json.pressSequentially('   '); // More keystrokes, in the same visit to the field
	const typed = await json.inputValue();
	await patchView(page, 'Patch');
	await expect(nodes(page)).toHaveCount(count - 1);

	await page.keyboard.press('ControlOrMeta+z');
	await expect(nodes(page)).toHaveCount(count);
	await patchView(page, 'JSON');
	await expect(json).toHaveValue(original);

	// Redo from the JSON view, with the field left alone.
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(json).toHaveValue(typed);
	await page.keyboard.press('ControlOrMeta+z');
	await expect(json).toHaveValue(original);
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
});

test("a timeline's undo outlasts opening another timeline", async ({ page }) => {
	await page.goto('/?timeline=song');
	const undo = undoButton(page);
	await expect(undo).toBeDisabled();
	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('placement-1-0')).toHaveCount(0);

	await browser(page).getByRole('link', { name: 'Ballad' }).click();
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('Ballad');
	await expect(undo).toBeDisabled(); // A history of its own
	await browser(page).getByRole('link', { name: 'Song' }).click();
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('Song');
	await expect(page.getByTestId('placement-1-0')).toHaveCount(0);
	await undo.click();
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await redoButton(page).click();
	await expect(page.getByTestId('placement-1-0')).toHaveCount(0);
});
