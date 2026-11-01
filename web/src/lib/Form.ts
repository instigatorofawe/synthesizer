// Helpers shared by the actions.
import { z } from 'zod';

export function parseDocument<T extends z.ZodType>(schema: T, text: unknown): z.infer<T> | { error: string } {
	let value: unknown;
	try {
		value = JSON.parse(String(text));
	} catch (e) {
		return { error: `not valid JSON: ${(e as Error).message}` };
	}
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	const issue = parsed.error.issues[0];
	return { error: `${issue.path.join('.') || 'document'}: ${issue.message}` };
}

export function isError(value: unknown): value is { error: string } {
	return typeof value === 'object' && value !== null && 'error' in value && Object.keys(value).length === 1;
}

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}
