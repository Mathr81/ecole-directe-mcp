import { z } from 'zod';

/** "2025-2026": the form École Directe's archives use. */
export const schoolYear = z
  .string()
  .regex(/^\d{4}-\d{4}$/, 'Année scolaire attendue au format AAAA-AAAA, par exemple 2025-2026.')
  .optional();
