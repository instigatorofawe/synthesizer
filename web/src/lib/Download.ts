export function downloadImage(base64: string, filename: string) {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}
