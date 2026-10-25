import "dotenv/config";
import { DEFAULT_VUPS_VISION_MODEL } from "../src/vupsGalax.js";
import { normalizeBaseUrl } from "../src/providerClient.js";
import { openRouterApiKey, openRouterBaseUrl, openRouterModel } from "../src/openrouter.js";

function text(name) {
  return typeof process.env[name] === "string" ? process.env[name].trim() : "";
}

function bool(name) {
  const value = text(name).toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return null;
}

function imageInput(entry) {
  const modalities = entry?.architecture?.input_modalities;
  if (Array.isArray(modalities)) return modalities.map(String).map(value => value.toLowerCase()).includes("image");
  const modality = String(entry?.architecture?.modality || "").toLowerCase();
  const input = modality.includes("->") ? modality.split("->")[0] : modality;
  return input.split(/[+,]/).map(value => value.trim()).includes("image");
}

function outputText(entry) {
  const modalities = entry?.architecture?.output_modalities;
  if (Array.isArray(modalities)) return modalities.map(String).map(value => value.toLowerCase()).includes("text");
  const modality = String(entry?.architecture?.modality || "").toLowerCase();
  const output = modality.includes("->") ? modality.split("->").at(-1) : modality;
  return output.split(/[+,]/).map(value => value.trim()).includes("text");
}

function freeModel(entry) {
  const pricing = entry?.pricing;
  if (!pricing) return null;
  const values = ["prompt", "completion", "request"].map(name => pricing[name]).filter(value => value !== undefined && value !== null && value !== "");
  return values.length > 0 && values.every(value => Number(value) === 0);
}

const dedicatedValues = [text("VUPS_BASE_URL"), text("VUPS_API_KEY"), text("VUPS_UNDERLYING_MODEL")];
const dedicated = dedicatedValues.some(Boolean);
if (dedicated && !dedicatedValues.every(Boolean)) {
  console.error("Partial VUPS configuration. Set all of VUPS_BASE_URL, VUPS_API_KEY, and VUPS_UNDERLYING_MODEL, or none of them.");
  process.exitCode = 1;
} else {
  const baseUrlValue = dedicated ? text("VUPS_BASE_URL") : openRouterBaseUrl() || "";
  const apiKey = dedicated ? text("VUPS_API_KEY") : openRouterApiKey() || "";
  const textModel = dedicated ? text("VUPS_UNDERLYING_MODEL") : openRouterModel();
  const visionEnabled = bool("VUPS_VISION");
  const configuredVisionModel = text("VUPS_VISION_MODEL");

  if (!baseUrlValue || !apiKey || !textModel) {
    console.error("Vups vision is not configured. Set the VUPS_* trio or OPENROUTER_API_KEY.");
    process.exitCode = 1;
  } else if (visionEnabled === false) {
    console.log("VUPS_VISION=false: image requests are intentionally disabled.");
  } else {
    let baseUrl;
    try {
      baseUrl = normalizeBaseUrl(baseUrlValue);
    } catch {
      console.error("VUPS_BASE_URL is not a valid http(s) endpoint.");
      process.exitCode = 1;
      baseUrl = null;
    }

    if (baseUrl) {
      const imageModel = configuredVisionModel || (!dedicated ? DEFAULT_VUPS_VISION_MODEL : textModel);
      const usesTextModel = !configuredVisionModel && (dedicated ? visionEnabled === true : false);
      let response;
      try {
        response = await fetch(`${baseUrl}/models`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000)
        });
      } catch {
        console.error("Could not reach the configured model catalog. Check VUPS_BASE_URL or network access.");
        process.exitCode = 1;
      }

      if (response) {
        if (!response.ok) {
          console.error(`The configured endpoint returned HTTP ${response.status} for /models. This endpoint may not support model discovery.`);
          process.exitCode = 1;
        } else {
          const payload = await response.json().catch(() => null);
          const entries = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.models)
              ? payload.models
              : Array.isArray(payload?.resources)
                ? payload.resources.map(entry => ({ id: entry?.model_id, ...entry }))
                : null;
          if (!entries) {
            console.error("The configured endpoint did not return a recognizable model list.");
            process.exitCode = 1;
          } else {
            const models = entries
              .filter(entry => typeof entry?.id === "string" && entry.id)
              .map(entry => ({
                id: entry.id,
                vision: imageInput(entry),
                text: outputText(entry),
                free: freeModel(entry)
              }));
            const visionModels = models
              .filter(entry => entry.vision && entry.text)
              .sort((a, b) => Number(b.free === true) - Number(a.free === true) || a.id.localeCompare(b.id));
            const selected = models.find(entry => entry.id === imageModel);

            if (dedicated && !configuredVisionModel && visionEnabled !== true) {
              console.error("Dedicated VUPS configuration needs an explicit image model choice. Set VUPS_VISION_MODEL, or set VUPS_VISION=true if the dedicated text model accepts images.");
              process.exitCode = 1;
            } else if (selected?.vision) {
              console.log(`Vision model OK: ${imageModel}${selected.free === true ? " (free)" : ""}${usesTextModel ? " (the dedicated text model)" : ""}`);
            } else if (selected && usesTextModel) {
              console.log(`Configured text model ${imageModel} is listed but does not advertise image input. VUPS_VISION=true forces image requests to it.`);
            } else if (selected) {
              console.error(`Configured image model ${imageModel} is listed but does not advertise image input.`);
              process.exitCode = 1;
            } else {
              console.error(`Configured image model ${imageModel} is not listed by ${dedicated ? "VUPS_BASE_URL" : "OpenRouter"}.`);
              process.exitCode = 1;
            }

            if (process.exitCode && visionModels.length > 0) {
              console.log("Image-capable models available at this endpoint:");
              for (const entry of visionModels.slice(0, 25)) {
                console.log(`  ${entry.id}${entry.free === true ? " (free)" : ""}`);
              }
              console.log(`Set VUPS_VISION_MODEL to one of these IDs${dedicated ? "" : ", or rely on the OpenRouter fallback default"}.`);
            }
          }
        }
      }
    }
  }
}
