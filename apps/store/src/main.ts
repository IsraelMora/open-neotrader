import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  const corsOrigins = process.env['CORS_ORIGINS'];
  app.enableCors({
    origin: corsOrigins ? corsOrigins.split(',') : false,
    credentials: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  await app.listen(process.env['PORT'] ? Number(process.env['PORT']) : 3002);
}
void bootstrap();
