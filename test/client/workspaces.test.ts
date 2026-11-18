import { describe, expect, it } from 'vitest';
import { flattenCloud, relativeFolder } from '../../src/client/workspaces.js';

// Shape observed live on /v3/cloud/W/789.awp, trimmed.
const root = {
  type: 'folder', libelle: '/', id: '\\0810908X\\W\\789', isLoaded: true,
  children: [
    {
      type: 'folder', libelle: 'METHODOLOGIE', id: '\\0810908X\\W\\789\\METHODOLOGIE', isLoaded: true, taille: 10,
      children: [{ type: 'folder', libelle: 'Dissertation', id: '\\0810908X\\W\\789\\METHODOLOGIE\\Dissertation', isLoaded: false, children: [] }],
    },
    { type: 'file', libelle: 'Cours.pdf', id: '\\\\CLOUD07\\cloud\\0810908X\\W\\789\\Cours.pdf', taille: 42, date: '2026-09-26 14:23:00' },
  ],
};

describe('workspace cloud', () => {
  it('turns node ids into paths relative to the workspace root', () => {
    expect(relativeFolder('\\0810908X\\W\\789', 789)).toBe('');
    expect(relativeFolder('\\0810908X\\W\\789\\METHODOLOGIE\\Dissertation', 789)).toBe('\\METHODOLOGIE\\Dissertation');
  });

  it('flattens the tree, flags folders whose contents were not returned, keeps full file ids', () => {
    expect(flattenCloud(root, 789)).toEqual([
      { type: 'folder', name: 'METHODOLOGIE', folder: '\\METHODOLOGIE', parent: '', date: null, sizeBytes: 10, contentsListed: true },
      { type: 'folder', name: 'Dissertation', folder: '\\METHODOLOGIE\\Dissertation', parent: '\\METHODOLOGIE', date: null, sizeBytes: 0, contentsListed: false },
      { type: 'file', name: 'Cours.pdf', fileId: '\\\\CLOUD07\\cloud\\0810908X\\W\\789\\Cours.pdf', parent: '', date: '2026-09-26 14:23:00', sizeBytes: 42 },
    ]);
  });
});
