import { describe, expect, it } from 'vitest';
import { computeAverages } from '../../src/client/averages.js';
import type { Grade, GradePeriod } from '../../src/client/types.js';

function grade(overrides: Partial<Grade> = {}): Grade {
  return {
    id: '1',
    subject: 'MATHEMATIQUES',
    subjectCode: 'MATHS',
    period: '1er Semestre',
    periodCode: 'A001',
    type: 'Devoir surveillé',
    label: 'DS',
    value: 10,
    status: null,
    significant: true,
    scale: 20,
    date: '2026-09-21',
    coefficient: 1,
    classAverage: 10,
    classMin: 5,
    classMax: 15,
    ...overrides,
  };
}

function period(overrides: Partial<GradePeriod> = {}): GradePeriod {
  return {
    code: 'A001',
    label: '1er Semestre',
    start: '2026-09-01',
    end: '2027-01-15',
    closed: false,
    annual: false,
    subjects: [
      { code: 'MATHS', label: 'MATHEMATIQUES', coefficient: 1, officialAverage: null },
      { code: 'PH-CH', label: 'PHYSIQUE-CHIMIE', coefficient: 1, officialAverage: null },
    ],
    officialOverall: null,
    ...overrides,
  };
}

describe('computeAverages', () => {
  it('weights each mark by its coefficient, on a /20 scale', () => {
    // 9/10 coef 0.5 → 18/20 ; 12/20 coef 1 → (18*0.5 + 12*1) / 1.5 = 14
    const [report] = computeAverages(
      [
        grade({ id: '1', value: 9, scale: 10, coefficient: 0.5 }),
        grade({ id: '2', value: 12, scale: 20, coefficient: 1 }),
      ],
      [period()],
    );

    expect(report.subjects).toEqual([
      expect.objectContaining({ code: 'MATHS', subject: 'MATHEMATIQUES', average: 14, gradeCount: 2 }),
    ]);
  });

  it('ignores ungraded, non-significant and zero-coefficient marks', () => {
    const [report] = computeAverages(
      [
        grade({ id: '1', value: 16 }),
        grade({ id: '2', value: null, status: 'Abs' }),
        grade({ id: '3', value: 2, significant: false }),
        grade({ id: '4', value: 0, coefficient: 0 }),
      ],
      [period()],
    );

    expect(report.subjects[0]).toMatchObject({ average: 16, gradeCount: 1 });
  });

  it('weights the overall average by subject coefficient', () => {
    const [report] = computeAverages(
      [
        grade({ id: '1', subjectCode: 'MATHS', value: 16 }),
        grade({ id: '2', subjectCode: 'PH-CH', subject: 'PHYSIQUE-CHIMIE', value: 10 }),
      ],
      [
        period({
          subjects: [
            { code: 'MATHS', label: 'MATHEMATIQUES', coefficient: 3, officialAverage: null },
            { code: 'PH-CH', label: 'PHYSIQUE-CHIMIE', coefficient: 1, officialAverage: null },
          ],
        }),
      ],
    );

    // (16*3 + 10*1) / 4 = 14.5
    expect(report.overall).toBe(14.5);
  });

  it('defaults an unlisted subject to coefficient 1', () => {
    const [report] = computeAverages(
      [grade({ subjectCode: 'FRANC', subject: 'FRANC', value: 12 })],
      [period({ subjects: [] })],
    );

    expect(report.subjects[0]).toMatchObject({ code: 'FRANC', coefficient: 1, average: 12 });
  });

  it('keeps each period to its own marks, and the annual period to all of them', () => {
    const reports = computeAverages(
      [grade({ id: '1', periodCode: 'A001', value: 10 }), grade({ id: '2', periodCode: 'A002', value: 20 })],
      [
        period({ code: 'A001' }),
        period({ code: 'A002', label: '2ème Semestre' }),
        period({ code: 'A999Z', label: 'Année', annual: true }),
      ],
    );

    expect(reports.map((r) => [r.code, r.overall])).toEqual([
      ['A001', 10],
      ['A002', 20],
      ['A999Z', 15],
    ]);
  });

  it('estimates the class average the same way, from each mark’s class average', () => {
    const [report] = computeAverages(
      [grade({ id: '1', classAverage: 8 }), grade({ id: '2', classAverage: 12 }), grade({ id: '3', classAverage: null })],
      [period()],
    );

    expect(report.subjects[0].classAverageEstimate).toBe(10);
  });

  it('reports no average, rather than zero, for a period without marks', () => {
    const [report] = computeAverages([], [period()]);

    expect(report).toMatchObject({ overall: null, subjects: [] });
  });

  it('passes through the official averages once École Directe publishes them', () => {
    const [report] = computeAverages(
      [grade({ value: 14 })],
      [
        period({
          closed: true,
          officialOverall: 13.9,
          subjects: [{ code: 'MATHS', label: 'MATHEMATIQUES', coefficient: 1, officialAverage: 13.8 }],
        }),
      ],
    );

    expect(report).toMatchObject({ closed: true, officialOverall: 13.9 });
    expect(report.subjects[0]).toMatchObject({ average: 14, officialAverage: 13.8 });
  });

  it('rounds to two decimals', () => {
    const [report] = computeAverages(
      [grade({ id: '1', value: 10 }), grade({ id: '2', value: 11 }), grade({ id: '3', value: 11 })],
      [period()],
    );

    expect(report.subjects[0].average).toBe(10.67);
  });
});
