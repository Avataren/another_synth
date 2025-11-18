// src/audio/serialization/bank-serializer.ts
import type { Bank, Patch, BankMetadata, ValidationResult } from '../types/preset-types';
import { createDefaultBankMetadata, PRESET_SCHEMA_VERSION } from '../types/preset-types';
import { validatePatch } from './patch-serializer';

/**
 * Creates a new bank with patches
 */
export function createBank(
  name: string,
  patches: Patch[] = [],
  metadata?: Partial<BankMetadata>,
): Bank {
  const bankMetadata: BankMetadata = metadata
    ? {
        ...createDefaultBankMetadata(name),
        ...metadata,
        name, // Ensure name is set
      }
    : createDefaultBankMetadata(name);

  return {
    metadata: bankMetadata,
    patches,
  };
}

/**
 * Adds a patch to a bank
 */
export function addPatchToBank(bank: Bank, patch: Patch): Bank {
  return {
    ...bank,
    metadata: {
      ...bank.metadata,
      modified: Date.now(),
    },
    patches: [...bank.patches, patch],
  };
}

/**
 * Removes a patch from a bank by ID
 */
export function removePatchFromBank(bank: Bank, patchId: string): Bank {
  return {
    ...bank,
    metadata: {
      ...bank.metadata,
      modified: Date.now(),
    },
    patches: bank.patches.filter((p) => p.metadata.id !== patchId),
  };
}

/**
 * Updates a patch in a bank
 */
export function updatePatchInBank(bank: Bank, patch: Patch): Bank {
  return {
    ...bank,
    metadata: {
      ...bank.metadata,
      modified: Date.now(),
    },
    patches: bank.patches.map((p) =>
      p.metadata.id === patch.metadata.id ? patch : p,
    ),
  };
}

/**
 * Validates a bank object structure
 */
export function validateBank(bank: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!bank || typeof bank !== 'object') {
    return {
      valid: false,
      errors: ['Invalid bank: not an object'],
    };
  }

  const b = bank as Partial<Bank>;

  // Validate metadata
  if (!b.metadata) {
    errors.push('Missing metadata');
  } else {
    if (!b.metadata.id) errors.push('Missing metadata.id');
    if (!b.metadata.name) errors.push('Missing metadata.name');
    if (!b.metadata.version) {
      errors.push('Missing metadata.version');
    } else if (b.metadata.version > PRESET_SCHEMA_VERSION) {
      warnings.push(
        `Bank version ${b.metadata.version} is newer than current version ${PRESET_SCHEMA_VERSION}. Some features may not work correctly.`,
      );
    }
  }

  // Validate patches array
  if (!b.patches) {
    errors.push('Missing patches array');
  } else if (!Array.isArray(b.patches)) {
    errors.push('Patches must be an array');
  } else {
    // Validate each patch
    b.patches.forEach((patch, index) => {
      const patchValidation = validatePatch(patch);
      if (!patchValidation.valid) {
        const patchName =
          patch && typeof patch === 'object' && 'metadata' in patch
            ? (patch as Patch).metadata?.name || 'unknown'
            : 'unknown';
        errors.push(
          `Patch ${index} (${patchName}) is invalid:`,
        );
        if (patchValidation.errors) {
          errors.push(...patchValidation.errors.map((e) => `  - ${e}`));
        }
      }
      if (patchValidation.warnings) {
        warnings.push(
          ...patchValidation.warnings.map(
            (w) => `Patch ${index}: ${w}`,
          ),
        );
      }
    });
  }

  const result: ValidationResult = {
    valid: errors.length === 0,
  };

  if (errors.length > 0) {
    result.errors = errors;
  }
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

/**
 * Exports a bank to JSON string
 */
export function exportBankToJSON(bank: Bank, pretty = true): string {
  return JSON.stringify(bank, null, pretty ? 2 : undefined);
}

/**
 * Imports a bank from JSON string
 */
export function importBankFromJSON(json: string): {
  bank?: Bank;
  validation: ValidationResult;
} {
  try {
    const parsed = JSON.parse(json);
    const validation = validateBank(parsed);

    if (!validation.valid) {
      return { validation };
    }

    return {
      bank: parsed as Bank,
      validation,
    };
  } catch (error) {
    return {
      validation: {
        valid: false,
        errors: [
          `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ],
      },
    };
  }
}

/**
 * Finds a patch in a bank by ID
 */
export function findPatchById(bank: Bank, patchId: string): Patch | undefined {
  return bank.patches.find((p) => p.metadata.id === patchId);
}

/**
 * Finds patches in a bank by tag
 */
export function findPatchesByTag(bank: Bank, tag: string): Patch[] {
  return bank.patches.filter(
    (p) => p.metadata.tags && p.metadata.tags.includes(tag),
  );
}

/**
 * Gets all unique tags from a bank
 */
export function getAllTags(bank: Bank): string[] {
  const tags = new Set<string>();
  bank.patches.forEach((patch) => {
    if (patch.metadata.tags) {
      patch.metadata.tags.forEach((tag) => tags.add(tag));
    }
  });
  return Array.from(tags).sort();
}
