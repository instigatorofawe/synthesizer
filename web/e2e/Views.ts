import { expect, type Page } from './Fixtures.ts';

// The page shows the Song view or the Patch view. What the other one holds is out of sight and can't be used, so a test
// that goes from one to the other switches as someone would, with the view's tab.
export async function openView(page: Page, view: 'song' | 'patch') {
	const tab = page.getByTestId(`view-${view}`);
	await tab.click();
	await expect(tab).toHaveAttribute('aria-selected', 'true');
}
