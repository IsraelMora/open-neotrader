/**
 * MigrationRunnerService — Aplica migraciones SQL pendientes al arrancar.
 *
 * Estrategia:
 *   - Mantiene tabla `_migration_history` con las migraciones ya aplicadas.
 *   - Lee el directorio `prisma/migrations/` en orden alfanumérico.
 *   - Aplica solo las nuevas (no registradas).
 *   - Transaccional: si una migración falla, el proceso no arranca.
 *
 * Por qué no usar `prisma migrate deploy`:
 *   - mejor-sqlite3 + driver adapter usa la API de PrismaClient, no la CLI de migraciones.
 *   - Este runner es un reemplazo ligero que funciona con el mismo esquema de archivos SQL.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const HISTORY_TABLE = '_migration_history';

@Injectable()
export class MigrationRunnerService implements OnModuleInit {
  private readonly log = new Logger(MigrationRunnerService.name);

  onModuleInit(): void {
    const dbUrl = process.env['DATABASE_URL'] ?? 'file:./neurotrader.db';
    const dbPath = dbUrl.replace(/^file:/, '');
    this.runMigrations(dbPath);
  }

  runMigrations(dbPath: string): void {
    const db = new Database(dbPath);
    try {
      // Crear tabla de historial si no existe
      db.exec(`
        CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}" (
          "name"       TEXT     NOT NULL PRIMARY KEY,
          "applied_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
      if (!fs.existsSync(migrationsDir)) {
        this.log.warn(`Directorio de migraciones no encontrado: ${migrationsDir}`);
        return;
      }

      const applied = new Set<string>(
        (db.prepare(`SELECT name FROM "${HISTORY_TABLE}"`).all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );

      // Ordenar migraciones alfanuméricamente (0001_, 0002_, ...)
      const dirs = fs
        .readdirSync(migrationsDir)
        .filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())
        .sort((a, b) => a.localeCompare(b));

      let newCount = 0;
      for (const dir of dirs) {
        if (applied.has(dir)) continue;

        const sqlFile = path.join(migrationsDir, dir, 'migration.sql');
        if (!fs.existsSync(sqlFile)) continue;

        const sql = fs.readFileSync(sqlFile, 'utf-8');
        this.log.log(`Aplicando migración: ${dir}`);

        // Ejecutar en transacción
        const apply = db.transaction(() => {
          db.exec(sql);
          db.prepare(`INSERT INTO "${HISTORY_TABLE}" (name) VALUES (?)`).run(dir);
        });
        apply();
        newCount++;
      }

      if (newCount === 0) {
        this.log.log('Base de datos al día — no hay migraciones pendientes');
      } else {
        this.log.log(`${newCount} migración(es) aplicada(s) correctamente`);
      }
    } finally {
      db.close();
    }
  }
}
