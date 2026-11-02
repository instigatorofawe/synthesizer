import { expect, it } from 'vitest';
import { nodeCatalog } from '#lib/server/Compile.ts';
import { NODE_TYPES } from '#lib/Schema.ts';

// A save checks a graph against NODE_TYPES and the compiler reads its own table. One that only the compiler knows could be
// drawn and previewed and then refused on save.
it('saves every node the compiler offers, and no others', async () => {
	const types = (await nodeCatalog()).map((entry) => entry.type);
	expect([...types].sort()).toEqual([...NODE_TYPES].sort());
});
