import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '#lib/server/Db.ts';
import { compileRequest } from '#lib/server/Compile.ts';
import { importInstrument, ImportError, instrumentGraph, MOST_SAMPLE_BYTES, zonesFor } from '#lib/server/Import.ts';
import { allPatches, assetsFor, deleteAsset, InUse, listAssets, deletePatch } from '#lib/server/Repository.ts';
import { buildRequest } from '#lib/Request.ts';
import { timelineSchema } from '#lib/Schema.ts';

const freshDb = () => openDatabase(':memory:');

function wavFile(frames: number, level = 0.5, sampler?: { unity: number; loop?: [number, number] }) {
	const data = Buffer.alloc(frames * 2);
	for (let i = 0; i < frames; ++i) data.writeInt16LE(Math.round(Math.sin(i / 8) * level * 32767), i * 2);
	const fmt = Buffer.alloc(24);
	fmt.write('fmt ', 0, 'latin1');
	fmt.writeUInt32LE(16, 4);
	fmt.writeUInt16LE(1, 8);
	fmt.writeUInt16LE(1, 10);
	fmt.writeUInt32LE(48000, 12);
	fmt.writeUInt32LE(96000, 16);
	fmt.writeUInt16LE(2, 20);
	fmt.writeUInt16LE(16, 22);
	const head = Buffer.alloc(8);
	head.write('data', 0, 'latin1');
	head.writeUInt32LE(data.length, 4);
	const smpl = Buffer.alloc(sampler ? 68 : 0);
	if (sampler) {
		smpl.write('smpl', 0, 'latin1');
		smpl.writeUInt32LE(60, 4);
		smpl.writeUInt32LE(sampler.unity, 20);
		smpl.writeUInt32LE(sampler.loop ? 1 : 0, 36);
		if (sampler.loop) {
			smpl.writeUInt32LE(sampler.loop[0], 52);
			smpl.writeUInt32LE(sampler.loop[1], 56);
		}
	}
	const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, head, data, smpl]);
	const riff = Buffer.alloc(8);
	riff.write('RIFF', 0, 'latin1');
	riff.writeUInt32LE(body.length, 4);
	return new Uint8Array(Buffer.concat([riff, body]));
}

describe('dividing a keyboard', () => {
	const layer = (asset: string, root: number, peak = 1) => ({ asset, root, peak });

	it('gives one recording every key', () => {
		expect(zonesFor([layer('a', 60)])).toEqual([{ asset: 'a', keys: [0, 127], root: 60 }]);
	});

	it('splits halfway between recordings, leaving no key out', () => {
		const zones = zonesFor([layer('high', 72), layer('low', 48), layer('mid', 60)]);
		expect(zones.map((zone) => [zone.asset, zone.keys])).toEqual([
			['low', [0, 54]],
			['mid', [55, 66]],
			['high', [67, 127]]
		]);
	});

	it('leaves no key out or doubled up, whatever the spacing', () => {
		const zones = zonesFor([1, 2, 3, 50, 51, 127].map((root) => layer(String(root), root)));
		const covered = zones.flatMap((zone) => {
			const [low, high] = zone.keys as [number, number];
			return Array.from({ length: high - low + 1 }, (_, i) => low + i);
		});
		expect(covered).toEqual(Array.from({ length: 128 }, (_, i) => i));
	});

	it('makes velocity layers of recordings at one key, quietest first', () => {
		const zones = zonesFor([layer('loud', 60, 0.9), layer('soft', 60, 0.2), layer('mid', 60, 0.5)]);
		expect(zones.map((zone) => [zone.asset, zone.velocities])).toEqual([
			['soft', [0, 42]],
			['mid', [43, 84]],
			['loud', [85, 127]]
		]);
	});
});

describe('importing an instrument', () => {
	const one = (name: string, bytes: Uint8Array) => ({ name, bytes });

	it('writes assets and a zones patch, in one go', () => {
		const db = freshDb();
		const id = importInstrument(db, 'Keys', [one('Piano_C4.wav', wavFile(1000)), one('Piano_C5.wav', wavFile(1000))]);
		const patch = allPatches(db).find((p) => p.id === id);
		expect(patch?.name).toBe('Keys');
		const sample = patch?.graph.nodes.find((node) => node.type === 'sample');
		expect(sample).toMatchObject({ mode: 'zones' });
		expect((sample?.zones as { root: number }[]).map((zone) => zone.root)).toEqual([60, 72]);
		expect(assetsFor(db, [id])).toHaveLength(2);
	});

	it('takes loops and tails from the file', () => {
		const db = freshDb();
		const id = importInstrument(db, 'Pad', [one('pad.wav', wavFile(1000, 0.5, { unity: 57, loop: [100, 500] }))]);
		const asset = assetsFor(db, [id])[0];
		expect(asset).toMatchObject({ root_key: 57, loop_start: 100, loop_end: 501 });
		expect(allPatches(db).find((p) => p.id === id)?.graph.nodes[1].tail).toBe(true);
	});

	it('leaves no tail on a loop that runs to the end', () => {
		const db = freshDb();
		const id = importInstrument(db, 'Pad', [one('pad.wav', wavFile(1000, 0.5, { unity: 57, loop: [100, 999] }))]);
		expect(allPatches(db).find((p) => p.id === id)?.graph.nodes[1]).not.toHaveProperty('tail');
	});

	it('imports nothing if any file is bad, and says which', () => {
		const db = freshDb();
		const before = listAssets(db).length;
		expect(() =>
			importInstrument(db, 'Keys', [one('good.wav', wavFile(100)), one('bad.wav', new Uint8Array(40))])
		).toThrow(/bad\.wav can't be imported: it is not a WAV file/);
		expect(listAssets(db)).toHaveLength(before);
		expect(allPatches(db).filter((p) => p.name === 'Keys')).toEqual([]);
	});

	it('refuses what could never load in a browser', () => {
		const frames = MOST_SAMPLE_BYTES / 2 + 1;
		expect(() => importInstrument(freshDb(), 'Long', [one('long.wav', wavFile(frames))])).toThrow(ImportError);
		expect(() => importInstrument(freshDb(), 'Long', [one('long.wav', wavFile(frames))])).toThrow(
			'an image holds 15.0 MB'
		);
	});

	it('compiles and carries every zone', async () => {
		const db = freshDb();
		const id = importInstrument(db, 'Keys', [one('Piano_C4.wav', wavFile(1000)), one('Piano_C5.wav', wavFile(2000))]);
		const patches = allPatches(db).filter((p) => p.id === id);
		const timeline = timelineSchema.parse({
			clips: [{ id: 'c', length: 960, notes: [{ tick: 0, note: 60, dur: 480 }] }],
			tracks: [{ id: 1, slots: [id], placements: [{ clip: 'c', tick: 0 }] }]
		});
		const { report } = await compileRequest(
			buildRequest(patches, assetsFor(db, [id]), [{ id: 't', name: 'T', timeline }])
		);
		expect(report.errors).toBeUndefined();
		expect(report.ok).toBe(true);
		expect(report.chunks.filter((chunk) => chunk.kind === 'asset')).toHaveLength(2);
	});

	it('wires an instrument that makes sound with velocity and release', () => {
		const graph = instrumentGraph([{ asset: 'a' }], false);
		expect(graph.nodes.map((node) => node.type)).toEqual(['note', 'sample', 'env', 'mul', 'mul', 'mul', 'out']);
		expect(graph.edges.filter((edge) => edge.to === 7).map((edge) => edge.input)).toEqual(['l', 'r']);
	});
});

describe('deleting a sample', () => {
	it('is refused while a patch plays it, and allowed after', () => {
		const db = freshDb();
		const id = importInstrument(db, 'Keys', [{ name: 'a.wav', bytes: wavFile(100) }]);
		const [asset] = listAssets(db);
		expect(asset.patches).toBe(1);
		expect(() => deleteAsset(db, asset.id)).toThrow(InUse);
		expect(() => deleteAsset(db, asset.id)).toThrow('used by Keys');
		deletePatch(db, id);
		deleteAsset(db, asset.id);
		expect(listAssets(db).some((row) => row.id === asset.id)).toBe(false);
	});

	it('leaves a database alone that has none', () => {
		const db: Db = freshDb();
		deleteAsset(db, 'nothing');
		expect(listAssets(db)).toEqual([]);
	});
});
