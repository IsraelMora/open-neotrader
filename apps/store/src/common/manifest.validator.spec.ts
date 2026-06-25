import { parseAndValidateManifest, ManifestError } from './manifest.validator';

const UNI = `
[plugin]
id = "tech-momentum"
name = "Tech"
type = "universe"
version = "1.0.0"
author = "alex"
description = "d"
[universe]
symbols = { NVDA = "equity" }
`;

describe('manifest.validator', () => {
  it('acepta un universe válido', () => {
    const m = parseAndValidateManifest(UNI);
    expect(m.id).toBe('tech-momentum');
    expect(m.type).toBe('universe');
  });
  it('acepta cualquier tipo de plugin del proyecto (provider, discipline, extra, …)', () => {
    for (const t of ['provider', 'discipline', 'extra', 'preset']) {
      const m = parseAndValidateManifest(
        UNI.replace('type = "universe"', `type = "${t}"`).replace(
          /\[universe\][\s\S]*$/,
          '',
        ),
      );
      expect(m.type).toBe(t);
    }
  });

  it('acepta un skill SIN bloque [skill] (formato runtime, payload va en el tarball)', () => {
    const skill = `
[plugin]
id = "trend-following"
name = "Trend Following"
type = "skill"
version = "1.0.0"
author = "a"
description = "d"
[skills]
keys = ["trend.analyze"]
`;
    expect(parseAndValidateManifest(skill).type).toBe('skill');
  });
  it('rechaza id no kebab', () => {
    expect(() =>
      parseAndValidateManifest(UNI.replace('tech-momentum', 'Tech X')),
    ).toThrow(ManifestError);
  });
  it('rechaza skill con file traversal', () => {
    const skill = `
[plugin]
id = "s"
name = "S"
type = "skill"
version = "1.0.0"
author = "a"
description = "d"
[skill]
name = "x"
file = "../../etc/passwd"
`;
    expect(() => parseAndValidateManifest(skill)).toThrow(ManifestError);
  });
  it('acepta skill con file relativo', () => {
    const skill = `
[plugin]
id = "s2"
name = "S"
type = "skill"
version = "1.0.0"
author = "a"
description = "d"
[skill]
name = "x"
file = "skill.md"
`;
    expect(parseAndValidateManifest(skill).type).toBe('skill');
  });
});
