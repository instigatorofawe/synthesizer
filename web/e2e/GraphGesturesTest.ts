import { expect, test, type Page } from './Fixtures.ts';
import { settled } from './Engine.ts';
import { redoButton, undoButton } from './Chrome.ts';

// The graph's gestures: a wire chosen and deleted, nodes chosen in a box and moved or deleted together, nodes copied from one
// patch into another, duplicated and Mod-dragged, and the JSON as a tab beside the graph.

test.use({ viewport: { width: 1440, height: 1000 } });

const patchEditor = (page: Page) => page.getByRole('region', { name: 'Patch editor' });
const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const graph = (page: Page) => page.getByTestId('graph');
const nodes = (page: Page) => graph(page).locator('g.node');
const side = (page: Page) => patchEditor(page).locator('aside.inspector');
const sideTab = (page: Page, name: 'Node' | 'Nodes' | 'Wire' | 'Patch' | 'JSON') =>
	page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name, exact: true });

// A new patch is a sine through an envelope: note 1, mtof 2, osc 3, env 4, mul 5 and out 6.
async function newPatch(page: Page, name: string) {
	await page.goto('/');
	await anotherPatch(page, name);
}

// A patch made from the browser, which keeps the page and what it has copied, as a reload wouldn't.
async function anotherPatch(page: Page, name: string) {
	await page.getByRole('button', { name: 'New patch', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
	await expect(graph(page)).toBeVisible();
}

async function openPatch(page: Page, name: string | RegExp) {
	await browser(page)
		.getByRole('link', typeof name === 'string' ? { name, exact: true } : { name })
		.click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
}

// Small enough that the whole of a new patch is on the canvas, which at 100% it isn't.
async function zoomOut(page: Page) {
	await patchEditor(page).getByRole('button', { name: 'Zoom the graph out' }).click();
	await patchEditor(page).getByRole('button', { name: 'Zoom the graph out' }).click();
	await expect(patchEditor(page).getByTestId('zoom')).toHaveText('64%');
}

// Halfway along a wire, on screen, where nothing covers it.
async function wireMiddle(page: Page, id: string) {
	const hit = page.getByTestId(`hit-${id}`);
	const at = await hit.evaluate((path: SVGPathElement) => {
		const point = path.getPointAtLength(path.getTotalLength() / 2);
		return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
	});
	const under = await page.evaluate(
		([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-testid'),
		[at.x, at.y]
	);
	expect(under).toBe(`hit-${id}`);
	return { x: at.x, y: at.y };
}

const title = (page: Page, id: number) => page.getByTestId(`node-${id}`).locator('rect.title');

async function centre(page: Page, id: number) {
	const box = (await title(page, id).boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Where a node is drawn, in the graph's units.
const placeOf = async (page: Page, id: number) =>
	(await page.getByTestId(`node-${id}`).getAttribute('transform'))!.match(/-?[\d.]+/g)!.map(Number);

test('a wire is chosen with a click, says what it joins, and Delete takes it away until Undo', async ({ page }) => {
	await newPatch(page, 'Unwired');
	await zoomOut(page);
	const wire = page.getByTestId('wire-5-b');
	const at = await wireMiddle(page, '5-b');
	await page.mouse.click(at.x, at.y);
	await expect(wire).toHaveAttribute('data-chosen', 'true');
	await expect(sideTab(page, 'Wire')).toHaveAttribute('aria-selected', 'true');
	await expect(side(page).getByTestId('wire-joins')).toHaveText(/Envelope 4\s+out\s+→\s+Multiply 5\s+b/);
	await expect(side(page)).toContainText('Without it, b takes its own value, 1.');

	await page.keyboard.press('Delete');
	await expect(wire).toHaveCount(0);
	await expect(page.getByTestId('in-5-b')).not.toHaveClass(/wired/);
	await expect(sideTab(page, 'Patch')).toHaveAttribute('aria-selected', 'true');
	await undoButton(page).click();
	await expect(wire).toBeAttached();
	await expect(page.getByTestId('in-5-b')).toHaveClass(/wired/);
	await redoButton(page).click();
	await expect(wire).toHaveCount(0);
	await undoButton(page).click();
	await expect(wire).toBeAttached();

	// A right-click opens a menu. No rate error is on this wire, so no snap is offered.
	const into = await wireMiddle(page, '5-a');
	await page.mouse.click(into.x, into.y, { button: 'right' });
	const menu = page.getByRole('menu', { name: 'Wire' });
	await expect(menu.getByRole('menuitem', { name: 'Put a snap on this wire' })).toHaveCount(0);
	await menu.getByRole('menuitem', { name: 'Delete' }).click();
	await expect(page.getByTestId('wire-5-a')).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.getByTestId('wire-5-a')).toBeAttached();

	// Esc lets go of a wire, as of a node.
	await page.mouse.click(into.x, into.y);
	await expect(page.getByTestId('wire-5-a')).toHaveAttribute('data-chosen', 'true');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('wire-5-a')).toHaveAttribute('data-chosen', 'false');
});

test("a wire's menu offers a snap where its input can't take audio", async ({ page }) => {
	await newPatch(page, 'Filtered by a snap'); // ControlsKeysTest makes a Filtered, and a second would be Filtered 2
	await sideTab(page, 'JSON').click();
	const json = page.getByLabel('Graph JSON');
	type Doc = { nodes: { id: number; type: string }[]; edges: { from: number; to: number; input?: string }[] };
	const doc = JSON.parse(await json.inputValue()) as Doc;
	doc.nodes.push({ id: 7, type: 'biquad' });
	doc.edges = [
		...doc.edges.filter((edge) => edge.to !== 6),
		{ from: 5, to: 7, input: 'in' },
		{ from: 7, to: 6, input: 'l' },
		{ from: 4, to: 7, input: 'cutoff' }
	];
	await json.fill(JSON.stringify(doc, null, 1));
	await json.blur();
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-error', 'true', { timeout: 10000 });
	await zoomOut(page);

	const at = await wireMiddle(page, '7-cutoff');
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.getByRole('menu', { name: 'Wire' }).getByRole('menuitem', { name: 'Put a snap on this wire' }).click();
	await expect(page.getByTestId('wire-7-cutoff')).toBeAttached();
	await expect(page.getByTestId('wire-8-in')).toBeAttached();
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-error', 'false', { timeout: 10000 });
});

test('a box chooses the nodes it touches, which move as one and are deleted together', async ({ page }) => {
	await newPatch(page, 'Boxed');
	await zoomOut(page);
	const mtof = (await page.getByTestId('node-2').locator('rect.body').boundingBox())!;
	const osc = (await page.getByTestId('node-3').locator('rect.body').boundingBox())!;

	// From empty canvas under the note-to-Hz node, which has nothing below it, to the top of the oscillator beside it. That
	// touches those two, and stops short of the envelope under the oscillator.
	await page.keyboard.down('Shift');
	await page.mouse.move(mtof.x + 10, mtof.y + mtof.height + 6);
	await page.mouse.down();
	await page.mouse.move(osc.x + osc.width - 10, osc.y + 10, { steps: 5 });
	await expect(page.getByTestId('box')).toBeVisible();
	await page.mouse.up();
	await page.keyboard.up('Shift');
	await expect(page.getByTestId('box')).toHaveCount(0);
	await expect(page.getByTestId('node-2')).toHaveClass(/chosen/);
	await expect(page.getByTestId('node-3')).toHaveClass(/chosen/);
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(2);
	await expect(sideTab(page, 'Nodes')).toHaveAttribute('aria-selected', 'true');
	await expect(side(page).getByRole('heading', { name: '2 nodes' })).toBeVisible();

	// A drag moves both by the same amount, and one Undo puts both back.
	const [two, three] = [await placeOf(page, 2), await placeOf(page, 3)];
	const from = await centre(page, 3);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 40, from.y + 90, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => (await placeOf(page, 3))[1]).toBeGreaterThan(three[1]);
	const [moved2, moved3] = [await placeOf(page, 2), await placeOf(page, 3)];
	expect(moved2[0] - two[0]).toBe(moved3[0] - three[0]);
	expect(moved2[1] - two[1]).toBe(moved3[1] - three[1]);
	await undoButton(page).click();
	await expect.poll(() => placeOf(page, 3)).toEqual(three);
	expect(await placeOf(page, 2)).toEqual(two);

	// Shift-click adds the out node, which Delete leaves, and says so.
	await page.keyboard.down('Shift');
	await title(page, 6).click();
	await page.keyboard.up('Shift');
	await expect(side(page).getByRole('heading', { name: '3 nodes' })).toBeVisible();
	await expect(side(page).getByTestId('kept')).toHaveText(/^Output 6 stays/);
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('node-2')).toHaveCount(0);
	await expect(page.getByTestId('node-3')).toHaveCount(0);
	await expect(page.getByTestId('node-6')).toBeVisible();
	await expect(page.getByTestId('wire-5-a')).toHaveCount(0); // From the oscillator, which went
	await undoButton(page).click();
	await expect(nodes(page)).toHaveCount(6);
	await expect(page.getByTestId('wire-5-a')).toBeAttached();

	// Mod+A chooses every node, and Delete then leaves the note and out nodes. Esc lets go.
	await graph(page).focus();
	await page.keyboard.press('ControlOrMeta+a');
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(6);
	await expect(side(page).getByTestId('kept')).toHaveText(/^Note 1 and Output 6 stay/);
	await page.keyboard.press('Escape');
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+a');
	await side(page).getByRole('button', { name: 'Delete 4 nodes' }).click();
	await expect(nodes(page)).toHaveCount(2);
	await expect(page.getByTestId('node-1')).toBeVisible();
	await expect(page.getByTestId('node-6')).toBeVisible();
	await undoButton(page).click();
	await expect(nodes(page)).toHaveCount(6);
});

test('nodes copied from one patch paste into another with fresh ids, and it compiles', async ({ page }) => {
	await newPatch(page, 'Pasted into');
	await anotherPatch(page, 'Copied from');

	// A level on a parameter, between the envelope's multiply and the out node: param 7, which reads parameter 1, into mul 8.
	await sideTab(page, 'JSON').click();
	const json = page.getByLabel('Graph JSON');
	const doc = JSON.parse(await json.inputValue());
	doc.params = [{ id: 1, name: 'level', scope: 'track', min: 0, max: 1, default: 0.5, smooth_ms: 10 }];
	doc.nodes.push({ id: 7, type: 'param', param: 1 }, { id: 8, type: 'mul' });
	doc.edges = [
		...doc.edges.filter((edge: { to: number }) => edge.to !== 6),
		{ from: 5, to: 8, input: 'a' },
		{ from: 7, to: 8, input: 'b' },
		{ from: 8, to: 6, input: 'l' }
	];
	await json.fill(JSON.stringify(doc, null, 1));
	await json.blur();
	await expect(page.getByTestId('node-8')).toBeAttached();

	// Chosen from the keyboard, which reaches a node off the canvas: Enter, then Shift+Enter to add one.
	await title(page, 7).focus();
	await page.keyboard.press('Enter');
	await title(page, 8).focus();
	await page.keyboard.press('Shift+Enter');
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(2);
	await expect(json).toBeVisible(); // Choosing keeps the JSON open
	await page.keyboard.press('ControlOrMeta+c');

	await openPatch(page, 'Pasted into');
	await zoomOut(page);
	await expect(nodes(page)).toHaveCount(6);
	const canvas = (await graph(page).boundingBox())!;
	await page.mouse.move(canvas.x + canvas.width - 220, canvas.y + 60);
	await page.keyboard.press('ControlOrMeta+v');
	await expect(nodes(page)).toHaveCount(8);
	await expect(page.getByTestId('node-7')).toHaveClass(/chosen/);
	await expect(page.getByTestId('node-8')).toHaveClass(/chosen/);
	await expect(page.getByTestId('wire-8-b')).toBeAttached(); // The wire between them came along
	await expect(page.getByTestId('wire-8-a')).toHaveCount(0); // The one from outside them didn't

	// The parameter came with its node, since this patch had none of that name.
	await sideTab(page, 'JSON').click();
	const pasted = JSON.parse(await json.inputValue());
	expect(pasted.params).toEqual([expect.objectContaining({ id: 1, name: 'level' })]);
	expect(pasted.nodes.find((node: { id: number }) => node.id === 7)).toMatchObject({ type: 'param', param: 1 });

	// Wired in between the multiply and the out node from the inspector, it compiles and nothing is left out.
	await title(page, 8).focus();
	await page.keyboard.press('Enter');
	await sideTab(page, 'Node').click();
	await side(page).getByLabel('source of a').selectOption('5:out');
	await title(page, 6).focus();
	await page.keyboard.press('Enter');
	await side(page).getByLabel('source of l').selectOption('8:out');
	await expect(page.getByTestId('node-8')).toHaveAttribute('data-dead', 'false', { timeout: 10000 });
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-dead', 'false');
	await expect(page.getByTestId('node-5')).toHaveAttribute('data-dead', 'false');
});

test('a built-in can be chosen in and copied from, and nothing changes it', async ({ page }) => {
	await page.goto('/?patch=builtin-Arpeggio&view=patch');
	await expect(nodes(page)).toHaveCount(7);
	await graph(page).focus();
	await page.keyboard.press('ControlOrMeta+a');
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(7);
	await expect(side(page).getByRole('heading', { name: '7 nodes' })).toBeVisible();
	await expect(side(page).getByRole('button', { name: /^Delete/ })).toHaveCount(0);
	await page.keyboard.press('Delete');
	await page.keyboard.press('ControlOrMeta+d');
	await title(page, 1).click({ button: 'right' });
	const menu = page.getByRole('menu', { name: '7 nodes' });
	await expect(menu.getByRole('menuitem')).toHaveText(['Copy']);
	await menu.getByRole('menuitem', { name: 'Copy' }).click();
	await expect(nodes(page)).toHaveCount(7);
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(7);

	// Into a patch of the library's own, which has an out node, so the built-in's isn't pasted.
	await openPatch(page, /^Square, /);
	await expect(nodes(page)).toHaveCount(4);
	await graph(page).focus();
	await page.keyboard.press('ControlOrMeta+v');
	await expect(nodes(page)).toHaveCount(10);
	await expect(graph(page).locator('g.node.chosen')).toHaveCount(6);
	await expect(graph(page).locator('g.node.chosen', { hasText: 'Output' })).toHaveCount(0);
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
});

test('Mod+D duplicates beside what is chosen, and Mod-drag leaves the node and moves a copy', async ({ page }) => {
	await newPatch(page, 'Doubled');
	await zoomOut(page);
	await title(page, 3).click();
	await page.keyboard.press('ControlOrMeta+d');
	await expect(nodes(page)).toHaveCount(7);
	await expect(page.getByTestId('node-7')).toHaveClass(/chosen/);
	await expect(page.getByTestId('node-3')).not.toHaveClass(/chosen/);
	await expect(page.getByTestId('node-7')).toContainText('osc · sine');
	await expect(page.getByTestId('wire-7-freq')).toHaveCount(0); // Its wire came from a node that wasn't copied
	await undoButton(page).click();
	await expect(nodes(page)).toHaveCount(6);

	const before = await placeOf(page, 4);
	const from = await centre(page, 4);
	await page.keyboard.down('ControlOrMeta');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x, from.y + 120, { steps: 5 });
	await page.mouse.up();
	await page.keyboard.up('ControlOrMeta');
	await expect(nodes(page)).toHaveCount(7);
	expect(await placeOf(page, 4)).toEqual(before);
	const copy = await placeOf(page, 7);
	expect(copy[0]).toBe(before[0]);
	expect(copy[1]).toBeGreaterThan(before[1]);
	await expect(page.getByTestId('node-7')).toContainText('Envelope');
	await expect(page.getByTestId('node-7')).toHaveClass(/chosen/);
	await undoButton(page).click();
	await expect(nodes(page)).toHaveCount(6);
});

test('the JSON is a tab beside the graph, and an edit there is drawn at once and undone as one step', async ({
	page
}) => {
	await newPatch(page, 'Side by side');
	await sideTab(page, 'JSON').click();
	const json = page.getByLabel('Graph JSON');
	await expect(json).toBeVisible();
	await expect(graph(page)).toBeVisible();
	await expect(page.getByTestId('node-3')).toContainText('osc · sine');

	const doc = JSON.parse(await json.inputValue());
	doc.nodes.find((node: { id: number }) => node.id === 3).wave = 'saw';
	await json.fill(JSON.stringify(doc, null, 1));
	await expect(page.getByTestId('node-3')).toContainText('osc · saw');

	// Choosing a node keeps the JSON open, and an edit on the canvas shows in it.
	await zoomOut(page);
	await title(page, 4).click();
	await expect(json).toBeVisible();
	await expect(page.getByTestId('node-4')).toHaveClass(/chosen/);
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('node-4')).toHaveCount(0);
	await expect(json).not.toHaveValue(/"type": "env"/);

	await undoButton(page).click();
	await expect(json).toHaveValue(/"type": "env"/);
	await expect(page.getByTestId('node-4')).toBeVisible();
	await undoButton(page).click();
	await expect(page.getByTestId('node-3')).toContainText('osc · sine');
	await expect(json).toHaveValue(/"wave": "sine"/);

	// The JSON stays open from one patch to the next.
	await openPatch(page, 'Stereo lead');
	await expect(json).toHaveValue(/"name": "cutoff"/);
	await sideTab(page, 'Patch').click();
	await expect(json).toHaveCount(0);
});
