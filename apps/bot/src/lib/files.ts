export type FilePart = {
	mediaType: string;
	url: string;
	filename?: string;
};

export function isPdfDocument(params: {
	mimeType?: string | null;
	fileName?: string | null;
}): boolean {
	const mimeType = params.mimeType?.toLowerCase();
	if (mimeType === "application/pdf") return true;
	return params.fileName?.toLowerCase().endsWith(".pdf") ?? false;
}

export function isDocxDocument(params: {
	mimeType?: string | null;
	fileName?: string | null;
}): boolean {
	const mimeType = params.mimeType?.toLowerCase();
	if (
		mimeType ===
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	) {
		return true;
	}
	return params.fileName?.toLowerCase().endsWith(".docx") ?? false;
}

export function toFilePart(params: {
	buffer: Uint8Array | ArrayBuffer;
	mediaType: string;
	filename?: string;
}): FilePart {
	const buffer =
		params.buffer instanceof Uint8Array
			? params.buffer
			: new Uint8Array(params.buffer);
	const base64 = Buffer.from(buffer).toString("base64");
	const url = `data:${params.mediaType};base64,${base64}`;
	return {
		mediaType: params.mediaType,
		url,
		filename: params.filename,
	};
}
