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
  it('rechaza type=provider (código, fase 2)', () => {
    expect(() =>
      parseAndValidateManifest(
        UNI.replace('type = "universe"', 'type = "provider"'),
      ),
    ).toThrow(ManifestError);
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
