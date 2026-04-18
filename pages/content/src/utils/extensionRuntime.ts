import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('extensionRuntime');

let hasWarnedGetUrlFailure = false;

export const isExtensionContextInvalidatedError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('extension context invalidated') ||
    message.includes('context invalidated') ||
    message.includes('receiving end does not exist') ||
    message.includes('runtime is not available')
  );
};

export const getExtensionAssetUrl = (assetPath: string): string => {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      return '';
    }
    return chrome.runtime.getURL(assetPath);
  } catch (error) {
    if (!hasWarnedGetUrlFailure) {
      hasWarnedGetUrlFailure = true;
      logger.warn('[extensionRuntime] Failed to resolve extension asset URL', {
        assetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return '';
  }
};

