import { expect, test, type Page } from './Fixtures.ts';
import { settled } from './Engine.ts';

// The graph editor at a laptop's size: text that can be read, the node search, Tidy, the snap a rate error offers, and a
// wheel that pans.

// Room beside a new patch to drop a node or a wire on, once it is zoomed out.
test.use({ viewport: { width: 1440, height: 1000 } });

const patchEditor = (page: Page) => page.getByRole('region', { name: 'Patch editor' });
const graph = (page: Page) => page.getByTestId('graph');
const search = (page: Page) => patchEditor(page).getByRole('combobox', { name: 'Search nodes' });
const palette = (page: Page) => page.getByTestId('node-palette');
const nodes = (page: Page) => graph(page).locator('g.node');

// A new patch is a sine through an envelope: note 1, mtof 2, osc 3, env 4, mul 5 and out 6.
async function newPatch(page: Page, name: string) {
	await page.goto('/');
	await page.getByRole('button', { name: 'New patch', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
	await expect(graph(page)).toBeVisible();
}

// Small enough that the whole of a new patch is on the canvas, which at 100% it isn't beside the timeline.
async function zoomOut(page: Page) {
	await patchEditor(page).getByRole('button', { name: 'Zoom the graph out' }).click();
	await patchEditor(page).getByRole('button', { name: 'Zoom the graph out' }).click();
	await expect(patchEditor(page).getByTestId('zoom')).toHaveText('64%');
}

async function drag(page: Page, from: string, to: string | { x: number; y: number }) {
	const start = (await page.getByTestId(from).boundingBox())!;
	const end = typeof to === 'string' ? (await page.getByTestId(to).boundingBox())! : { ...to, width: 0, height: 0 };
	await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
	await page.mouse.down();
	await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 5 });
	await page.mouse.up();
}

// The point of the canvas furthest from every node, on screen, and high enough that the search, which keeps inside the window,
// can open there, as the Patch view gives the canvas the whole height.
const emptySpot = (page: Page) =>
	graph(page).evaluate((svg) => {
		const box = svg.getBoundingClientRect();
		const bodies = [...svg.querySelectorAll('g.node rect.body')].map((rect) => rect.getBoundingClientRect());
		const lowest = Math.min(box.bottom, innerHeight - 340);
		let best = { x: box.left + box.width / 2, y: (box.top + lowest) / 2 };
		let room = -Infinity;
		for (let x = box.left + 30; x < box.right - 30; x += 10)
			for (let y = box.top + 20; y < lowest - 20; y += 10) {
				const clear = Math.min(
					...bodies.map((b) => Math.max(b.left - x, x - b.right, b.top - y, y - b.bottom)),
					Infinity
				);
				if (clear > room) [best, room] = [{ x, y }, clear];
			}
		return best;
	});

// Pairs of nodes drawn over each other.
const overlaps = (page: Page) =>
	graph(page).evaluate((svg) => {
		const boxes = [...svg.querySelectorAll('g.node')].map((node) => ({
			id: node.getAttribute('data-testid'),
			box: node.querySelector('rect.body')!.getBoundingClientRect()
		}));
		return boxes.flatMap((a, i) =>
			boxes
				.slice(i + 1)
				.filter(
					({ box: b }) => a.box.left < b.right && b.left < a.box.right && a.box.top < b.bottom && b.top < a.box.bottom
				)
				.map((b) => `${a.id} ${b.id}`)
		);
	});

// The smallest text on the canvas, in CSS pixels on screen.
const smallestText = (page: Page) =>
	graph(page).evaluate((svg) =>
		Math.min(
			...[...svg.querySelectorAll('text')].map(
				(text) => parseFloat(getComputedStyle(text).fontSize) * (text.getScreenCTM()?.a ?? 0)
			)
		)
	);

const viewBox = async (page: Page) => (await graph(page).getAttribute('viewBox'))!.split(' ').map(Number);

test('a node says what it is, and the inspector gives its inputs a unit, a range and round numbers', async ({
	page
}) => {
	await newPatch(page, 'Named');
	await expect(page.getByTestId('node-4')).toContainText('Envelope');
	await expect(page.getByTestId('node-4')).toContainText('env');
	await page.getByRole('button', { name: 'Envelope, env 4' }).click();
	const inspector = patchEditor(page).locator('aside.inspector');
	await expect(inspector.getByRole('heading', { name: 'Envelope env 4' })).toBeVisible();
	await expect(inspector).toContainText("following the note's gate");
	await expect(inspector.getByLabel('value of attack')).toHaveAttribute('placeholder', '0.01');
	await expect(inspector.getByTestId('range-attack')).toHaveText('0.0001 to 60');
	await expect(inspector.getByTestId('range-sustain')).toHaveText('0 to 1');
	await expect(inspector.locator('.input', { hasText: 'attack' }).locator('.unit')).toHaveText('s');
});

test('+ Node opens the node search, and "filter" finds the biquad', async ({ page }) => {
	await newPatch(page, 'Searched');
	const add = patchEditor(page).getByRole('button', { name: '+ Node' });
	await add.click();
	await expect(search(page)).toBeFocused();
	await expect(add).toHaveAttribute('aria-expanded', 'true');
	await search(page).fill('filter');
	const listbox = patchEditor(page).getByRole('listbox', { name: 'Nodes' });
	await expect(listbox.getByRole('group', { name: 'Filters' })).toBeVisible();
	const first = listbox.getByRole('option').first();
	await expect(first).toContainText('Filter');
	await expect(first).toContainText('biquad');
	await expect(first).toHaveAttribute('aria-selected', 'true');
	await expect(search(page)).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
	await page.keyboard.press('Enter');
	await expect(palette(page)).toHaveCount(0);
	await expect(page.getByTestId('node-7')).toContainText('biquad');
	expect(await overlaps(page)).toEqual([]);
	await expect(add).toBeFocused();
});

test('the search goes by other words for a node, and the arrows, Enter and Esc work in it', async ({ page }) => {
	await newPatch(page, 'Keys');
	await patchEditor(page).getByRole('button', { name: '+ Node' }).click();
	await search(page).fill('envelope');
	const options = patchEditor(page).getByRole('option');
	await expect(options.first()).toContainText('Envelope');
	await expect(options.filter({ hasText: 'Follower' })).toHaveCount(1);
	await page.keyboard.press('ArrowDown');
	await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowUp');
	await expect(options.first()).toHaveAttribute('aria-selected', 'true');

	await search(page).fill('lfo');
	await expect(options.first()).toContainText('LFO');
	await expect(options.filter({ hasText: 'Oscillator' })).toHaveCount(1); // A patch's LFO is often a slow oscillator
	await page.keyboard.press('Escape');
	await expect(palette(page)).toHaveCount(0);
	await expect(nodes(page)).toHaveCount(6);
});

test('N opens the search at the pointer while the graph has focus, and not while a field does', async ({ page }) => {
	await newPatch(page, 'Pressed');
	await page.getByRole('navigation', { name: 'Browser' }).getByLabel('Filter the browser').press('n');
	await expect(palette(page)).toHaveCount(0);

	await zoomOut(page);
	const spot = await emptySpot(page);
	await page.mouse.click(spot.x, spot.y);
	await page.keyboard.press('n');
	await expect(search(page)).toBeFocused();
	const opened = (await palette(page).boundingBox())!;
	expect(Math.abs(opened.y - spot.y)).toBeLessThan(4);
	expect(opened.x).toBeLessThan(spot.x + 1);
	await search(page).fill('noise');
	await page.keyboard.press('Enter');
	const body = (await page.getByTestId('node-7').locator('rect.body').boundingBox())!;
	expect(Math.abs(body.x + body.width / 2 - spot.x)).toBeLessThan(40);
	expect(await overlaps(page)).toEqual([]);
	await expect(graph(page)).toBeFocused();
});

test('a double-click on empty canvas opens the search there, and the node lands at the pointer', async ({ page }) => {
	await newPatch(page, 'Clicked twice');
	await zoomOut(page);
	const spot = await emptySpot(page);
	await page.mouse.dblclick(spot.x, spot.y);
	await expect(search(page)).toBeFocused();
	await search(page).fill('delay');
	await page.keyboard.press('Enter');
	const body = (await page.getByTestId('node-7').locator('rect.body').boundingBox())!;
	expect(Math.abs(body.x + body.width / 2 - spot.x)).toBeLessThan(40);
	await expect(page.getByTestId('node-7')).toContainText('Delay');

	// On a node it opens nothing.
	const title = (await page.getByTestId('node-3').locator('rect.title').boundingBox())!;
	await page.mouse.dblclick(title.x + title.width / 2, title.y + title.height / 2);
	await expect(palette(page)).toHaveCount(0);
});

test('a wire dropped on empty canvas asks what it goes to, and the node arrives wired', async ({ page }) => {
	await newPatch(page, 'Dropped');
	await zoomOut(page);
	await drag(page, 'out-3-out', await emptySpot(page));
	await expect(palette(page)).toHaveAttribute('aria-label', 'Add a node wired from this output');
	await expect(patchEditor(page).getByRole('option', { name: /^Noise/ })).toHaveCount(0); // It has no input
	await search(page).fill('filter');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('node-7')).toContainText('biquad');
	await expect(page.getByTestId('wire-7-in')).toBeAttached();
	expect(await overlaps(page)).toEqual([]);
});

test('Tidy lays the graph out again as one edit, which Undo takes back', async ({ page }) => {
	await newPatch(page, 'Tidied');
	await zoomOut(page);
	const laid = await page.getByTestId('node-6').getAttribute('transform');
	const title = (await page.getByTestId('node-6').locator('rect.title').boundingBox())!;
	await page.mouse.move(title.x + 20, title.y + 5);
	await page.mouse.down();
	await page.mouse.move(title.x - 60, title.y + 80, { steps: 4 });
	await page.mouse.up();
	await expect(page.getByTestId('node-6')).not.toHaveAttribute('transform', laid!);
	const moved = await page.getByTestId('node-6').getAttribute('transform');
	const others = await page.getByTestId('node-2').getAttribute('transform');

	await patchEditor(page).getByRole('button', { name: 'Tidy' }).click();
	await expect(page.getByTestId('node-6')).toHaveAttribute('transform', laid!);
	await expect(page.getByTestId('node-2')).toHaveAttribute('transform', others!);
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.getByTestId('node-6')).toHaveAttribute('transform', moved!);
});

test('an envelope wired to a cutoff offers a snap, which mends it as one edit', async ({ page }) => {
	await newPatch(page, 'Filter envelope');
	await zoomOut(page);
	await patchEditor(page).getByRole('button', { name: '+ Node' }).click();
	await search(page).fill('filter');
	await page.keyboard.press('Enter');
	await drag(page, 'out-5-out', 'in-7-in');
	await drag(page, 'out-7-out', 'in-6-l');
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await drag(page, 'out-4-out', 'in-7-cutoff');
	await expect(page.getByTestId('compile-error')).toContainText('put a snap node on the wire');
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-error', 'true');
	await expect(nodes(page)).toHaveCount(7); // Offered, never put in for the author
	await graph(page).getByRole('button', { name: 'Put a snap on this wire' }).click();
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(page.getByTestId('node-8')).toContainText('Snap');
	await expect(page.getByTestId('wire-8-in')).toBeAttached();
	await expect(page.getByTestId('wire-7-cutoff')).toBeAttached();
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-error', 'false');
	expect(await overlaps(page)).toEqual([]);

	await page.keyboard.press('ControlOrMeta+z');
	await expect(nodes(page)).toHaveCount(7);
	await expect(page.getByTestId('compile-error')).toContainText('put a snap node on the wire');
});

test('a node that compiled away says why', async ({ page }) => {
	await newPatch(page, 'Loose end');
	await patchEditor(page).getByRole('button', { name: '+ Node' }).click();
	await search(page).fill('noise');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-dead', 'true');
	await expect(patchEditor(page).getByTestId('node-dead')).toContainText('Nothing it makes reaches the out node');
});

test('a wheel pans, and Mod with the wheel or a pinch zooms around the pointer', async ({ page }) => {
	await newPatch(page, 'Scrolled');
	const zoom = patchEditor(page).getByTestId('zoom');
	const shown = await zoom.textContent();
	const scale = Number(await graph(page).getAttribute('data-scale'));
	const box = (await graph(page).boundingBox())!;
	const pointer = { x: box.x + box.width / 3, y: box.y + box.height / 2 };
	await page.mouse.move(pointer.x, pointer.y);
	const [x, y, width] = await viewBox(page);
	await page.mouse.wheel(0, 100);
	await expect.poll(async () => (await viewBox(page))[1]).toBeCloseTo(y + 100 / scale, 0);
	await page.mouse.wheel(60, 0);
	await expect.poll(async () => (await viewBox(page))[0]).toBeCloseTo(x + 60 / scale, 0);
	expect((await viewBox(page))[2]).toBeCloseTo(width);
	await expect(zoom).toHaveText(shown!);

	const under = async () =>
		graph(page).evaluate((svg, at) => {
			const point = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM()!.inverse());
			return [point.x, point.y];
		}, pointer);
	const before = await under();
	await page.keyboard.down('ControlOrMeta');
	await page.mouse.wheel(0, -100);
	await page.keyboard.up('ControlOrMeta');
	await expect(zoom).not.toHaveText(shown!);
	expect(Number((await zoom.textContent())!.replace('%', ''))).toBeGreaterThan(scale * 100);
	const after = await under();
	expect(after[0]).toBeCloseTo(before[0], 0);
	expect(after[1]).toBeCloseTo(before[1], 0);

	// A pinch is a wheel with Control held, on a Mac too.
	const pinched = await zoom.textContent();
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, 40);
	await page.keyboard.up('Control');
	await expect(zoom).not.toHaveText(pinched!);
});

test('Fit never draws text smaller than 11 pixels, and the rest is panned to', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/?timeline=ballad&patch=lead');
	await expect(nodes(page).first()).toBeVisible();
	expect(await smallestText(page)).toBeGreaterThanOrEqual(10.99);
	const zoomOut = patchEditor(page).getByRole('button', { name: 'Zoom the graph out' });
	await zoomOut.click();
	await zoomOut.click();
	expect(await smallestText(page)).toBeLessThan(10);
	await patchEditor(page).getByRole('button', { name: 'Fit' }).click();
	expect(await smallestText(page)).toBeGreaterThanOrEqual(10.99);
	await expect(patchEditor(page).getByTestId('zoom')).toHaveText('100%');

	// The full stop fits too, from the graph.
	await zoomOut.click();
	await graph(page).focus();
	await page.keyboard.press('.');
	await expect(patchEditor(page).getByTestId('zoom')).toHaveText('100%');
});
