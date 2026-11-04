// Set to null to restore all otherwise-compatible OpenRouter text models.
export const ALLOWED_MODEL_IDS = ['nvidia/nemotron-3.5-lightning:free'];
export const DEFAULT_MODEL_ID = 'nvidia/nemotron-3.5-lightning:free';
export const isModelAllowed = (id, allowedModelIds = ALLOWED_MODEL_IDS) => allowedModelIds === null || allowedModelIds.includes(id);
export function defaultModelId(models, allowedModelIds = ALLOWED_MODEL_IDS) {
  const target = models.find(model => model.id === DEFAULT_MODEL_ID && isModelAllowed(model.id, allowedModelIds));
  if (target) return target.id;
  if (allowedModelIds !== null) throw new Error(`The configured model (${DEFAULT_MODEL_ID}) is unavailable. No other model will be selected.`);
  if (!models.length) throw new Error('No supported text models are available.');
  return models[0].id;
}
