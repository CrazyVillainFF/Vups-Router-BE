import { dataAdapters } from "./data.js";
import { developerAdapters } from "./developer.js";
import { referenceAdapters } from "./reference.js";
import { researchAdapters } from "./research.js";
import { utilityAdapters } from "./utilities.js";

export const ADAPTERS = Object.freeze({
  ...researchAdapters,
  ...referenceAdapters,
  ...dataAdapters,
  ...developerAdapters,
  ...utilityAdapters
});

export function getAdapter(id) {
  return ADAPTERS[String(id || "")] || null;
}

export function adapterTools(id) {
  return getAdapter(id)?.tools || [];
}

export function findTool(adapterId, toolName) {
  return adapterTools(adapterId).find(tool => tool.name === toolName) || null;
}

export function publicTools(id) {
  return adapterTools(id).map(tool => ({
    name: tool.name,
    description: tool.description,
    sensitive: Boolean(tool.sensitive),
    inputSchema: tool.inputSchema
  }));
}
