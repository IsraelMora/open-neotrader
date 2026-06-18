import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanLocalManifests } from './local-sync';

describe('scanLocalManifests', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-plugins-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writePlugin(dir: string, toml: string): void {
    const d = path.join(root, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.toml'), toml);
  }

  const VALID = `[plugin]
id = "test-skill"
name = "Test Skill"
version = "1.0.0"
type = "skill"
description = "una skill de prueba"
author = "tester"
`;

  it('returns one record per directory with a valid manifest', () => {
    writePlugin('test-skill', VALID);

    const records = scanLocalManifests(root);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'test-skill',
      name: 'Test Skill',
      version: '1.0.0',
      type: 'skill',
      description: 'una skill de prueba',
      author: 'tester',
    });
    expect(records[0].installed_path).toBe(path.join(root, 'test-skill'));
  });

  it('skips directories without a manifest.toml', () => {
    fs.mkdirSync(path.join(root, 'empty-dir'));

    expect(scanLocalManifests(root)).toHaveLength(0);
  });

  it('skips manifests that fail validation (e.g. missing id)', () => {
    writePlugin('broken', `[plugin]\nname = "Broken"\nversion = "1.0.0"\ntype = "skill"\n`);

    expect(scanLocalManifests(root)).toHaveLength(0);
  });

  it('returns an empty array when the plugins dir does not exist', () => {
    expect(scanLocalManifests(path.join(root, 'does-not-exist'))).toEqual([]);
  });
});
