function modelName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim().toLowerCase().replace(/^copilot\//, '');
}

export function isHydraFusionModel(value: unknown): boolean {
  const model = modelName(value);
  return model === 'hydrafusion' || model === 'hydrafusion-max';
}

/** Un modello selezionato esplicitamente, non il modello fisico restituito dall'upstream. */
export function fusionFromSelectedModel(value: unknown): boolean | null {
  const model = modelName(value);
  if (!model || model === 'auto') return null;
  if (isHydraFusionModel(model)) return true;
  if (model.includes('fusion')) return null;
  return false;
}

export function fusionFromChatSelection(selected: unknown, resolved: unknown): boolean | null {
  const selection = fusionFromSelectedModel(selected);
  if (selection !== false) return selection;
  const requested = modelName(selected)?.replace(/[._]/g, '-');
  const actual = modelName(resolved)?.replace(/[._]/g, '-');
  return requested && actual === requested ? false : null;
}

/** Il modello fisico da solo non basta: puo' essere stato scelto dal router Fusion. */
export function fusionFromCliUsage(usage: Record<string, unknown>, selectedModel?: string): boolean | null {
  const fusion = usage.fusion;
  if (typeof fusion === 'object' && fusion !== null && !Array.isArray(fusion)) {
    const syntheticModel = (fusion as Record<string, unknown>).syntheticModel;
    return isHydraFusionModel(syntheticModel) ? true : null;
  }
  if (fusion !== null && fusion !== undefined) return null;

  const selected = modelName(selectedModel);
  const actual = modelName(usage.model);
  if (selected && actual === selected && usage.isAuto !== true && fusionFromSelectedModel(selected) === false) {
    return false;
  }
  return null;
}
