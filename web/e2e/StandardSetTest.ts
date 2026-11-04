import { readFileSync } from 'node:fs';
import { fromSongMenu } from './Chrome.ts';
import { startAudioNewest } from './Engine.ts';
import { expect, test, type Page } from './Fixtures.ts';
import { emptyNewSong } from './NewSong.ts';

// The standard set as examples/Instruments holds it, which is nothing until the set is made. What these expect comes from its
// Index.json and its examples, so they hold for a set of any size, and for none.
interface Entry {
	name: string;
	file: string;
	family: string;
}
interface Project {
	patches: Record<string, { name: string; graph: { nodes: { type: string }[] } }>;
	programs: { timeline: { tracks: { slots: string[] }[] } }[];
}
const examples = new URL('../../examples/', import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, examples), 'utf8'));
const SET = read<Entry[]>('Instruments/Index.json');
const project = (entry: Entry) => read<Project>(`Instruments/${entry.file}`);
const PREFIX = read<{ prefix: string }>('Instruments/GeneralMidi.json').prefix;
const isInsert = (patch: Project['patches'][string]) => patch.graph.nodes.some((node) => node.type === 'in');
// Each family's patches as a track's patch picker lists them: a patch two of the examples play is in the first one's family,
// and an effect, which takes a track's sound in, is left out, since a track plays an instrument.
const FAMILIES = (() => {
	const seen = new Set<string>();
	return SET.map((entry) => {
		const fresh = Object.entries(project(entry).patches).filter(([key]) => !seen.has(key));
		for (const [key] of fresh) seen.add(key);
		const voices = fresh.filter(([, patch]) => !isInsert(patch));
		return { family: entry.family, keys: voices.map(([key]) => key), names: voices.map(([, patch]) => patch.name) };
	}).filter((family) => family.keys.length);
})();
// The set's effects, by name, as an insert's choices list them.
const EFFECTS = [
	...new Set(SET.flatMap((entry) => Object.values(project(entry).patches).filter(isInsert)).map((patch) => patch.name))
].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
// The recipes' groups, which come after the set's in the browser, by name.
const RECIPE_GROUPS = [
	...new Set(read<{ group: string }[]>('Recipes/Index.json').map((recipe) => recipe.group))
].sort();

test.use({ viewport: { width: 1440, height: 900 } }); // The browser beside the page

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const list = (page: Page) => page.getByRole('listbox', { name: 'Patches' });
const group = (page: Page, name: string) => list(page).getByRole('group', { name: `Built in ${name}`, exact: true });

// The picker's groups by the names a screen reader gives them, in order.
const groupNames = (page: Page) =>
	list(page)
		.getByRole('group')
		.evaluateAll((groups) =>
			groups.map((element) =>
				(element.getAttribute('aria-labelledby') ?? '')
					.split(' ')
					.map((id) => document.getElementById(id)?.textContent?.trim())
					.join(' ')
			)
		);

async function emptySong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click();
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue(name);
	await emptyNewSong(page);
}

async function slots(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const doc = JSON.parse(await page.getByLabel('Song JSON').inputValue());
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	return doc.tracks.map((track: { slots: string[] }) => track.slots);
}

test("a patch picker lists the set's patches first, under their families, and then the techniques", async ({
	page
}) => {
	await emptySong(page, 'Instruments');
	await page.getByRole('button', { name: 'Add track' }).click();
	await expect(group(page, 'Techniques')).toContainText('Kick808');
	const builtin = (await groupNames(page)).filter((name) => name.startsWith('Built in'));
	expect(builtin).toEqual([...FAMILIES.map((family) => `Built in ${family.family}`), 'Built in Techniques']);
	for (const { family, names } of FAMILIES) await expect(group(page, family).getByRole('option')).toHaveText(names);

	// A family's name finds its patches, and "drum" the kit's and the drum recipes' too.
	await page.keyboard.type('drum');
	await expect(group(page, 'Techniques')).toContainText('Kick808');
	const kit = FAMILIES.find((family) => family.family === 'Drum kit');
	if (kit) await expect(group(page, 'Drum kit').getByRole('option')).toHaveText(kit.names);
	if (!FAMILIES.length) return;
	const first = FAMILIES[0];
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(first.family.toLowerCase());
	await expect(group(page, first.family).getByRole('option')).toHaveText(first.names);

	// Chosen, it is the set's patch that the track plays.
	await group(page, first.family).getByRole('option', { name: first.names[0], exact: true }).click();
	await expect(page.getByTestId('track-patch-1')).toHaveText(first.names[0]);
	expect(await slots(page)).toEqual([[`${PREFIX}${first.keys[0]}`]]);
});

test("a mixer strip's inserts offer the set's effects, and then the techniques", async ({ page }) => {
	await page.goto('/?timeline=song');
	await page
		.getByRole('tablist', { name: 'Song views' })
		.getByRole('tab', { name: /^Mixer/ })
		.click();
	const add = page.getByLabel('Add an insert to Lead');
	const groups = add.locator('optgroup');
	await expect(groups).toHaveCount(EFFECTS.length ? 2 : 1);
	expect(await groups.evaluateAll((list) => list.map((group) => group.getAttribute('label')))).toEqual([
		...(EFFECTS.length ? ['Effects'] : []),
		'Techniques'
	]);
	if (EFFECTS.length) await expect(groups.first().locator('option')).toHaveText(EFFECTS);
	await expect(groups.last().locator('option', { hasText: 'Reverb' }).first()).toBeAttached();
});

test("the browser lists the set's examples after the pieces and before the recipes", async ({ page }) => {
	await page.goto('/?timeline=song');
	const summaries = browser(page).locator('h2:has-text("Examples") ~ details > summary');
	const names = await summaries.evaluateAll((list) => list.map((summary) => summary.firstChild?.textContent?.trim()));
	expect(names).toEqual(['pieces', ...(SET.length ? ['instruments'] : []), ...RECIPE_GROUPS]);
	if (!SET.length) return;
	await summaries.nth(1).click();
	await expect(browser(page).locator('h2:has-text("Examples") ~ details').nth(1).getByRole('link')).toHaveText(
		SET.map((entry) => entry.name)
	);
	await browser(page).getByRole('link', { name: SET[0].name, exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`recipe=${SET[0].name}`));
});

test("the set's examples name their instruments, play as they are, and one added to the library plays the set's patches", async ({
	page
}) => {
	test.skip(!SET.length, 'the set is empty');
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	// Each track head names its first slot's instrument, as the built-in patch is named.
	for (const entry of SET) {
		const { patches, programs } = project(entry);
		await page.goto(`/?recipe=${entry.name}`);
		await expect(page.getByTestId('track-patch-1')).toHaveText(patches[programs[0].timeline.tracks[0].slots[0]].name);
	}

	const entry = SET[0];
	const { patches, programs } = project(entry);
	const key = programs[0].timeline.tracks[0].slots[0];
	await page.goto(`/?recipe=${entry.name}`);
	await startAudioNewest(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	const peaks = () =>
		page
			.getByRole('region', { name: 'Patch editor', includeHidden: true })
			.getByTestId('peak')
			.evaluateAll((list) => list.map((e) => Number(e.getAttribute('data-loudest'))));
	await expect.poll(async () => Math.max(0, ...(await peaks())), { timeout: 8000 }).toBeGreaterThan(0.01);
	await page.getByRole('button', { name: 'Stop', exact: true }).click();

	await fromSongMenu(page, 'Add to library');
	await page.waitForURL(`**/?timeline=recipe-${entry.name}`);
	await expect(page.getByLabel('Patch slot 1', { exact: true })).toHaveAttribute('data-patch', `${PREFIX}${key}`);
	await expect(page.getByTestId('track-patch-1')).toHaveText(patches[key].name);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	expect(problems).toEqual([]);
});
