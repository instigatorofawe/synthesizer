// WAV files into an instrument. Import writes one shape, a `sample` node in zones mode, so a saved instrument never needs
// migrating, and a single recording is just an instrument with one zone.
import { randomUUID } from 'node:crypto';
import type { Zone } from '#lib/GraphEdit.ts';
import type { Db } from '#lib/server/Db.ts';
import { createAsset, createPatch } from '#lib/server/Repository.ts';
import { decodeWav, rootOf, WavError, type Wav } from '#lib/server/Wav.ts';
import type { Graph } from '#lib/Schema.ts';

export class ImportError extends Error {}

export interface Upload {
	name: string;
	bytes: Uint8Array;
}

// The browser engine's image slot, in bindings/Wasm.cpp, less room for the patches and Program beside the samples. An image
// over it can't load, so an instrument is refused here, where the reason can still be given.
export const MOST_SAMPLE_BYTES = (16 << 20) - (1 << 20);
export const MOST_ZONES = 256;

interface Layer {
	asset: string;
	root: number;
	peak: number;
}

const MOST_KEY = 127;

// Each recording plays from halfway to the one below it up to halfway to the one above, and the ends reach the ends of the
// keyboard. Several at one key are velocity layers, quietest first, split evenly: only their levels say which is which.
export function zonesFor(layers: Layer[]): Zone[] {
	const keys = [...new Set(layers.map((layer) => layer.root))].sort((a, b) => a - b);
	const zones: Zone[] = [];
	keys.forEach((root, index) => {
		const low = index === 0 ? 0 : Math.floor((keys[index - 1] + root) / 2) + 1;
		const high = index === keys.length - 1 ? MOST_KEY : Math.floor((root + keys[index + 1]) / 2);
		const here = layers.filter((layer) => layer.root === root).sort((a, b) => a.peak - b.peak);
		here.forEach((layer, step) => {
			const velocities: [number, number] = [
				Math.round((step * 128) / here.length),
				Math.round(((step + 1) * 128) / here.length) - 1
			];
			zones.push({ asset: layer.asset, keys: [low, high], root, ...(here.length > 1 ? { velocities } : {}) });
		});
	});
	return zones;
}

export function instrumentGraph(zones: Zone[], tail: boolean): Graph {
	return {
		params: [],
		nodes: [
			{ id: 1, type: 'note' },
			{ id: 2, type: 'sample', mode: 'zones', zones, ...(tail ? { tail: true } : {}) },
			{ id: 3, type: 'env', inputs: { attack: 0.002, decay: 0.05, sustain: 1, release: 0.15 } },
			{ id: 4, type: 'mul' },
			{ id: 5, type: 'mul' },
			{ id: 6, type: 'mul' },
			{ id: 7, type: 'out' }
		],
		edges: [
			{ from: 1, port: 'velocity', to: 4, input: 'a' },
			{ from: 3, port: 'out', to: 4, input: 'b' },
			{ from: 2, port: 'l', to: 5, input: 'a' },
			{ from: 4, port: 'out', to: 5, input: 'b' },
			{ from: 2, port: 'r', to: 6, input: 'a' },
			{ from: 4, port: 'out', to: 6, input: 'b' },
			{ from: 5, port: 'out', to: 7, input: 'l' },
			{ from: 6, port: 'out', to: 7, input: 'r' }
		]
	};
}

function decodeAll(files: Upload[]): (Wav & { file: string })[] {
	return files.map((file) => {
		try {
			return { ...decodeWav(file.bytes), file: file.name };
		} catch (e) {
			if (e instanceof WavError) throw new ImportError(`${file.name} can't be imported: ${e.message}`);
			throw e;
		}
	});
}

const megabytes = (bytes: number) => (bytes / (1 << 20)).toFixed(1);

// The whole set or nothing, so a bad file in the middle leaves no half an instrument behind.
export function importInstrument(db: Db, name: string, files: Upload[]): string {
	const wavs = decodeAll(files);
	if (wavs.length > MOST_ZONES) throw new ImportError(`an instrument has at most ${MOST_ZONES} zones`);
	const total = wavs.reduce((sum, wav) => sum + wav.data.length, 0);
	if (total > MOST_SAMPLE_BYTES) {
		throw new ImportError(`these samples take ${megabytes(total)} MB, and an image holds ${megabytes(MOST_SAMPLE_BYTES)} MB of them`);
	}
	return db.transaction((tx) => {
		const t = tx as unknown as Db;
		const layers = wavs.map((wav) => {
			const asset = randomUUID();
			const root = rootOf(wav, wav.file);
			createAsset(t, {
				id: asset,
				name: wav.file.replace(/\.[^.]*$/, ''),
				encoding: wav.encoding,
				channels: wav.channels,
				rate: wav.rate,
				frames: wav.frames,
				root_key: root,
				loop_start: wav.loop?.start ?? 0,
				loop_end: wav.loop?.end ?? 0,
				data: Buffer.from(wav.data).toString('base64')
			});
			return { asset, root, peak: wav.peak };
		});
		// A tail is what's left after a loop, so a note can play out through it after release.
		const tail = wavs.some((wav) => wav.loop && wav.loop.end < wav.frames);
		return createPatch(t, name, instrumentGraph(zonesFor(layers), tail));
	});
}
