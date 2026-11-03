import { describe, expect, it } from 'vitest';
import { buildRequest } from '#lib/Request.ts';
import { referencedAssets, referencedPatches, referencedSubpatches, timelineSchema } from '#lib/Schema.ts';
import { readCatalogue } from '#lib/server/Builtins.ts';
import { compileRequest } from '#lib/server/Compile.ts';
import { NEW_TIMELINE, TEMPLATE_BARS, TEMPLATE_PATCH } from '#lib/Template.ts';
import { ticksPerBar } from '#lib/TimelineEdit.ts';
import { trackAlone } from '#lib/Workspace.ts';

describe('the new song', () => {
	it('is a timeline as one is saved, which the schema leaves as it is', () => {
		expect(timelineSchema.parse(JSON.parse(JSON.stringify(NEW_TIMELINE)))).toEqual(NEW_TIMELINE);
	});

	it('plays a built-in patch that ships, with nothing to fetch before it sounds', async () => {
		const patch = (await readCatalogue()).patches.find((candidate) => candidate.id === TEMPLATE_PATCH);
		expect(patch).toBeDefined();
		expect(referencedPatches(NEW_TIMELINE)).toEqual([TEMPLATE_PATCH]);
		expect(referencedAssets(patch!.graph)).toEqual([]);
		expect(referencedSubpatches(patch!.graph)).toEqual([]);
	});

	it('has one track and an empty four-bar clip on it at bar 1', () => {
		expect(NEW_TIMELINE.tracks).toHaveLength(1);
		const [track] = NEW_TIMELINE.tracks;
		expect(track.slots).toEqual([TEMPLATE_PATCH]);
		expect(track.placements).toEqual([{ clip: NEW_TIMELINE.clips[0].id, tick: 0, repeat: 1 }]);
		expect(NEW_TIMELINE.clips).toHaveLength(1);
		expect(NEW_TIMELINE.clips[0]).toMatchObject({ length: TEMPLATE_BARS * ticksPerBar(NEW_TIMELINE), notes: [] });
	});

	// With no notes the song's image has no track in it, which is why the keys play the track on its own until it has one.
	it('compiles, and its track compiles on its own for the keys', async () => {
		const patch = (await readCatalogue()).patches.find((candidate) => candidate.id === TEMPLATE_PATCH)!;
		const song = await compileRequest(buildRequest([patch], [], [{ id: 'new', name: 'New', timeline: NEW_TIMELINE }]));
		expect(song.report.errors).toBeUndefined();
		expect(song.report.programs[0].tracks).toEqual([]);

		const alone = trackAlone(NEW_TIMELINE, NEW_TIMELINE.tracks[0].id)!;
		const keys = await compileRequest(
			buildRequest([patch], [], [{ id: 'keys', name: 'Keys', timeline: alone }], { live: true })
		);
		expect(keys.report.errors).toBeUndefined();
		expect(keys.report.programs[0].tracks.map((track) => track.index)).toEqual([0]);
	});
});
