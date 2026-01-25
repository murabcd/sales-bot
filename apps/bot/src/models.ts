import fs from "node:fs/promises";
import path from "node:path";
import {
	type ModelConfig,
	type ModelsFile,
	normalizeModelRef,
	type SelectedModel,
	selectModel,
} from "./models-core.js";

export async function loadModelsConfig(
	configPath = "config/models.json",
): Promise<ModelsFile> {
	const fullPath = path.resolve(configPath);
	const raw = await fs.readFile(fullPath, "utf8");
	const parsed = JSON.parse(raw) as ModelsFile;
	return parsed;
}

export {
	type ModelConfig,
	type ModelsFile,
	type SelectedModel,
	normalizeModelRef,
	selectModel,
};
