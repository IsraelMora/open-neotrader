import { unwrapKv, kvBool, kvNum, kvStr } from './kv.util';

describe('kv.util — tolera doble-encoding (panel JSON.stringify vs KvService crudo)', () => {
  describe('unwrapKv', () => {
    it('desenvuelve string JSON-encoded ("openai" → openai)', () => {
      expect(unwrapKv('"openai"')).toBe('openai');
    });
    it('deja crudo lo no-JSON (openai → openai)', () => {
      expect(unwrapKv('openai')).toBe('openai');
    });
    it('NO convierte a number/boolean valores crudos (300 → "300", true → "true")', () => {
      expect(unwrapKv('300')).toBe('300');
      expect(unwrapKv('true')).toBe('true');
    });
    it('null → null', () => {
      expect(unwrapKv(null)).toBeNull();
    });
  });

  describe('kvBool — estricto true/false, tolera JSON-encoding', () => {
    it('acepta crudo y JSON-encoded para true/false', () => {
      expect(kvBool('true', false)).toBe(true);
      expect(kvBool('"true"', false)).toBe(true);
      expect(kvBool('false', true)).toBe(false);
      expect(kvBool('"false"', true)).toBe(false);
    });
    it('match estricto: True/1/0 crudos → fallback (no se reinterpretan)', () => {
      expect(kvBool('True', false)).toBe(false);
      expect(kvBool('1', false)).toBe(false);
      expect(kvBool('0', true)).toBe(true);
    });
    it('null → default', () => {
      expect(kvBool(null, true)).toBe(true);
      expect(kvBool(null, false)).toBe(false);
    });
    it('valor desconocido → default', () => {
      expect(kvBool('maybe', true)).toBe(true);
    });
  });

  describe('kvNum', () => {
    it('parsea crudo y JSON-encoded', () => {
      expect(kvNum('300', 1)).toBe(300);
      expect(kvNum('"300"', 1)).toBe(300);
      expect(kvNum('0.1', 9)).toBeCloseTo(0.1);
    });
    it('null o no-numérico → default', () => {
      expect(kvNum(null, 7)).toBe(7);
      expect(kvNum('abc', 7)).toBe(7);
    });
  });

  describe('kvStr', () => {
    it('desenvuelve y devuelve string, null si null', () => {
      expect(kvStr('"plugin-x"')).toBe('plugin-x');
      expect(kvStr('plugin-x')).toBe('plugin-x');
      expect(kvStr(null)).toBeNull();
    });
  });
});
