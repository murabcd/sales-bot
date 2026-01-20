import fs from "node:fs/promises";
import path from "node:path";

export type ModelConfig = {
	provider: string;
	id: string;
	label?: string;
	reasoning?: string;
};

export type ModelsFile = {
	defaults: {
		primary: string;
		fallbacks?: string[];
	};
	models: Record<string, ModelConfig>;
};

export type SelectedModel = {
	ref: string;
	config: ModelConfig;
	fallbacks: string[];
};

export function normalizeModelRef(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.includes("/")) return trimmed;
	return `openai/${trimmed}`;
}

export async function loadModelsConfig(
	configPath = "config/models.json",
): Promise<ModelsFile> {
	const fullPath = path.resolve(configPath);
	const raw = await fs.readFile(fullPath, "utf8");
	const parsed = JSON.parse(raw) as ModelsFile;
	return parsed;
}

export function selectModel(
	models: ModelsFile,
	overrideRef?: string | null,
): SelectedModel {
	const primary = normalizeModelRef(
		overrideRef && overrideRef.trim().length > 0
			? overrideRef
			: models.defaults.primary,
	);
	const config = models.models[primary];
	if (!config) {
		throw new Error(`Unknown model: ${primary}`);
	}
	const fallbacks = (models.defaults.fallbacks ?? [])
		.map(normalizeModelRef)
		.filter((ref) => ref !== primary);
	return { ref: primary, config, fallbacks };
}
