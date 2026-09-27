import { z } from 'zod';

/**
 * A calendar date as AAAA-MM-JJ. Malformed dates used to reach École Directe
 * and come back as `[]`, which an LLM reads as "nothing that week" rather than
 * "you called me wrong" — so they are rejected here, with a message saying
 * what was expected.
 */
export function isoDate(description: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ, par exemple 2026-09-28.')
    .refine((value) => {
      // Round-tripping through Date catches 2026-13-45 and 2026-02-30, which
      // the regex lets through and Date would otherwise silently roll over.
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }, 'Date inexistante (AAAA-MM-JJ) : vérifie le mois et le jour.')
    .describe(description);
}

/** The cross-field check the per-field schemas cannot express. */
export function dateRangeError(fromDate: string, toDate: string) {
  if (fromDate <= toDate) return null;
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: `fromDate (${fromDate}) est postérieure à toDate (${toDate}) : la période est vide.`,
      },
    ],
  };
}
