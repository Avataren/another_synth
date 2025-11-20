export const DEFAULT_PATCH_CATEGORY = 'Uncategorized';

export const normalizePatchCategory = (
  input?: string | null,
): string | undefined => {
  if (typeof input !== 'string') {
    return undefined;
  }

  const normalized = input
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');

  return normalized.length > 0 ? normalized : undefined;
};

export const categorySegments = (category?: string | null): string[] => {
  const normalized = normalizePatchCategory(category);
  return normalized ? normalized.split('/') : [];
};

export const formatCategoryLabel = (category?: string | null): string => {
  const normalized = normalizePatchCategory(category);
  return normalized ?? DEFAULT_PATCH_CATEGORY;
};
