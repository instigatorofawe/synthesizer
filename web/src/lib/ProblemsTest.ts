import { describe, expect, it } from 'vitest';
import { lightOf, placeOf, placeWords, sizeOf, type Names, type Problem } from '#lib/Problems.ts';

const names: Names = {
	patch: (id) => ({ lead: 'Stereo lead' })[id],
	node: (patch, node) => (patch === 'lead' && node === 13 ? 'Filter 13' : undefined),
	track: (id) => ({ 1: 'Lead', 2: '' })[id]
};

describe('where a problem is', () => {
	it('is a node of a patch, or the subpatch node a node inside one is drawn as', () => {
		expect(placeOf('patch:lead/node:13')).toEqual({ kind: 'patch', patch: 'lead', node: 13 });
		expect(placeOf('patch:lead/node:7/node:2')).toEqual({ kind: 'patch', patch: 'lead', node: 7 });
		expect(placeOf('patch:builtin-Kick808')).toEqual({ kind: 'patch', patch: 'builtin-Kick808', node: null });
	});

	it('is a track, a clip or the mix of a song', () => {
		expect(placeOf('timeline:"song"/track:2/clip:pluck-a')).toEqual({
			kind: 'song',
			track: 2,
			clip: 'pluck-a',
			mix: false
		});
		expect(placeOf('timeline:"song"/track:1')).toEqual({ kind: 'song', track: 1, clip: null, mix: false });
		expect(placeOf('timeline:"song"/clip:never-placed')).toEqual({
			kind: 'song',
			track: null,
			clip: 'never-placed',
			mix: false
		});
		expect(placeOf('timeline:"song"/bus:fx/inserts/0')).toEqual({ kind: 'song', track: null, clip: null, mix: true });
		expect(placeOf('timeline:"song"/master')).toEqual({ kind: 'song', track: null, clip: null, mix: true });
		expect(placeOf('target')).toBeNull();
	});

	it('reads in words', () => {
		expect(placeWords('patch:lead/node:13', names)).toBe('Stereo lead › Filter 13');
		expect(placeWords('patch:lead/node:4', names)).toBe('Stereo lead › node 4');
		expect(placeWords('patch:lead', names)).toBe('Stereo lead');
		expect(placeWords('patch:gone/node:1', names)).toBe('gone › node 1');
		expect(placeWords('timeline:"song"/track:1/clip:lead-a', names)).toBe('Lead › lead-a');
		expect(placeWords('timeline:"song"/track:2', names)).toBe('Track 2');
		expect(placeWords('timeline:"song"/clip:never-placed', names)).toBe('Clip never-placed');
		expect(placeWords('timeline:"song"/bus:fx', names)).toBe('Bus fx');
		expect(placeWords('timeline:"song"/master', names)).toBe('Master');
		expect(placeWords('timeline:"song"', names)).toBe('The song');
		expect(placeWords('target', names)).toBe('target');
	});
});

describe('the compile light', () => {
	const problem = (severity: Problem['severity']): Problem => ({ key: severity, severity, place: '', message: '' });

	it('says compiling first, then problems, then warnings, then the size', () => {
		expect(lightOf(true, [problem('error')], '5.9 KB')).toEqual({ state: 'compiling', label: 'Compiling…' });
		expect(lightOf(false, [problem('warning'), problem('error')], '5.9 KB')).toEqual({
			state: 'problems',
			label: '1 problem'
		});
		expect(lightOf(false, [problem('error'), problem('error')], '').label).toBe('2 problems');
		expect(lightOf(false, [problem('warning')], '5.9 KB')).toEqual({ state: 'warnings', label: '1 warning' });
		expect(lightOf(false, [], sizeOf(6042))).toEqual({ state: 'fine', label: '5.9 KB' });
		expect(lightOf(false, [], '')).toEqual({ state: 'idle', label: '' });
	});
});
