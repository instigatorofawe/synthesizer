export function downloadImage(base64: string, filename: string) {
	downloadBytes(
		Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
		filename,
		'application/octet-stream'
	);
}

export function downloadBytes(bytes: Uint8Array<ArrayBuffer>, filename: string, type: string) {
	const url = URL.createObjectURL(new Blob([bytes], { type }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}
