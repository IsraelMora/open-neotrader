import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  Inject,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import {
  buildSignedMessage,
  sha256Hex,
  verifySignature,
  publisherIdFromPublicKey,
} from './signature.util';

/** Token de inyección para configurar la ventana anti-replay en milisegundos. */
export const SIGNATURE_WINDOW_MS = 'SIGNATURE_WINDOW_MS';
const DEFAULT_WINDOW_MS = 300_000;

interface SignedRequest {
  headers: Record<string, string>;
  method: string;
  url: string;
  body: unknown;
  publisherId: string;
  publicKey: string;
}

/**
 * Guard que verifica la firma ECDSA de cada petición entrante.
 *
 * Valida que las cabeceras `x-publisher-id`, `x-public-key`, `x-timestamp`
 * y `x-signature` estén presentes, que el timestamp caiga dentro de la
 * ventana anti-replay y que la firma cubra el método, la ruta y el hash
 * del cuerpo. Si la verificación es exitosa adjunta `publisherId` y `publicKey` a la
 * petición para que los manejadores los consuman vía `@Publisher()`.
 */
@Injectable()
export class SignatureGuard implements CanActivate {
  private readonly windowMs: number;

  // Por DI, @Optional() inyecta `undefined` si no hay provider, y eso
  // ANULABA el default de parámetro (edad > undefined === false → el
  // anti-replay se saltaba). El `?? DEFAULT` lo hace a prueba de undefined.
  constructor(@Optional() @Inject(SIGNATURE_WINDOW_MS) windowMs?: number) {
    this.windowMs = windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Ejecuta la verificación de firma y anti-replay.
   *
   * @param context - Contexto de ejecución de NestJS.
   * @returns `true` si la petición es válida; lanza excepción en caso contrario.
   */
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<SignedRequest>();
    const h = req.headers;
    const id = h['x-publisher-id'];
    const pub = h['x-public-key'];
    const ts = h['x-timestamp'];
    const sig = h['x-signature'];
    if (!id || !pub || !ts || !sig) {
      throw new UnauthorizedException('faltan cabeceras de firma');
    }
    if (publisherIdFromPublicKey(pub) !== id) {
      throw new ForbiddenException('el id no corresponde a la clave pública');
    }
    const edad = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(edad) || edad > this.windowMs) {
      throw new UnauthorizedException('timestamp fuera de la ventana (replay)');
    }
    const bodyHash = sha256Hex(JSON.stringify(req.body ?? {}));
    const path = req.url.split('?')[0];
    const msg = buildSignedMessage(ts, req.method, path, bodyHash);
    if (!verifySignature(pub, msg, sig)) {
      throw new UnauthorizedException('firma inválida');
    }
    req.publisherId = id;
    req.publicKey = pub;
    return true;
  }
}
