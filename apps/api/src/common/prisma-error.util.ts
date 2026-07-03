/** Detects a Prisma P2002 (unique constraint violation) without importing @prisma/client's error class. */
export function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
