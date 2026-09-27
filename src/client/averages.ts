/**
 * Averages computed from the marks themselves.
 *
 * Schools can withhold averages until a period is closed
 * (`moyenneUniquementPeriodeCloture`): the per-subject figures come back
 * empty and the overall one holds placeholder values. Everything needed to
 * compute them is there regardless — each mark's value, scale, coefficient
 * and period, and each subject's coefficient — so they are computed the way
 * École Directe does:
 *
 *   subject = Σ(mark/scale × 20 × coef) / Σ coef
 *   overall = Σ(subject × subject coef) / Σ subject coef
 *
 * Ungraded (Abs, NE…), non-significant and zero-coefficient marks are left
 * out, as they are in the official figure.
 */
import type { Grade, GradePeriod, PeriodAverages, SubjectAverage } from './types.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function weightedMean(pairs: Array<{ value: number; weight: number }>): number | null {
  const totalWeight = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (totalWeight <= 0) return null;
  return round2(pairs.reduce((sum, pair) => sum + pair.value * pair.weight, 0) / totalWeight);
}

function counts(grade: Grade): boolean {
  return grade.value !== null && grade.significant && grade.coefficient > 0 && grade.scale > 0;
}

function subjectAverages(grades: Grade[], period: GradePeriod): SubjectAverage[] {
  const bySubject = new Map<string, Grade[]>();
  for (const grade of grades.filter(counts)) {
    const list = bySubject.get(grade.subjectCode) ?? [];
    list.push(grade);
    bySubject.set(grade.subjectCode, list);
  }
  const listed = new Map(period.subjects.map((subject) => [subject.code, subject]));

  return [...bySubject].map(([code, marks]) => {
    const info = listed.get(code);
    return {
      code,
      subject: info?.label ?? marks[0].subject,
      coefficient: info?.coefficient ?? 1,
      average: weightedMean(marks.map((mark) => ({ value: (mark.value! / mark.scale) * 20, weight: mark.coefficient }))),
      classAverageEstimate: weightedMean(
        marks
          .filter((mark) => mark.classAverage !== null)
          .map((mark) => ({ value: (mark.classAverage! / mark.scale) * 20, weight: mark.coefficient })),
      ),
      gradeCount: marks.length,
      officialAverage: info?.officialAverage ?? null,
    };
  });
}

export function computeAverages(grades: Grade[], periods: GradePeriod[]): PeriodAverages[] {
  return periods.map((period) => {
    // Marks carry the code of their term; the annual period has none of its own.
    const marks = period.annual ? grades : grades.filter((grade) => grade.periodCode === period.code);
    const subjects = subjectAverages(marks, period);
    return {
      code: period.code,
      label: period.label,
      start: period.start,
      end: period.end,
      closed: period.closed,
      annual: period.annual,
      overall: weightedMean(
        subjects
          .filter((subject) => subject.average !== null)
          .map((subject) => ({ value: subject.average!, weight: subject.coefficient })),
      ),
      officialOverall: period.officialOverall,
      subjects,
    };
  });
}
