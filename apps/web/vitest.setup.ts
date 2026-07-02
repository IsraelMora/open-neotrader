// jsdom (via Node's undici Request/fetch) has no concept of a "document base URL",
// so `new Request('/relative/path')` throws ERR_INVALID_URL even though the same
// call works in a real browser (resolved against `document.baseURI`). ky's `prefix`
// option produces exactly this kind of root-relative request. This shim restores
// browser-like relative-URL resolution (against `window.location.href`) for tests only.
const OriginalRequest = globalThis.Request;

class TestRequest extends OriginalRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) {
      input = new URL(input, globalThis.location.href).toString();
    }
    super(input, init);
  }
}

globalThis.Request = TestRequest as unknown as typeof Request;
