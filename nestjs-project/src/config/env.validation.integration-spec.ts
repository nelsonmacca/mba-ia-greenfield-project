import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_BUCKET: 'streamtube-videos',
  STORAGE_ACCESS_KEY: 'streamtube',
  STORAGE_SECRET_KEY: 'streamtube',
};

// Typed result so destructuring `value`/`error` is not an unsafe `any` access.
interface ValidatedEnv {
  value: Record<string, unknown>;
  error?: ValidationError;
}

const validate = (env: Record<string, string>): ValidatedEnv =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as ValidatedEnv;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage', () => {
  const validateWithoutRequired = (omit: string): ValidatedEnv => {
    const env = { ...requiredEnv } as Record<string, string>;
    delete env[omit];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    }) as ValidatedEnv;
  };

  it.each([
    'STORAGE_ENDPOINT',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
  ])('should reject when %s is missing', (key) => {
    const { error } = validateWithoutRequired(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a non-URI STORAGE_ENDPOINT', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-url' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should apply storage defaults when optional vars are not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_FORCE_PATH_STYLE).toBe('true');
    expect(value.STORAGE_UPLOAD_URL_TTL).toBe(900);
    expect(value.STORAGE_DOWNLOAD_URL_TTL).toBe(3600);
    expect(value.STORAGE_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024 * 1024);
  });
});

describe('envValidationSchema — queue & worker', () => {
  it('should apply Redis defaults when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should default WORKER_MODE to false', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.WORKER_MODE).toBe('false');
  });

  it('should reject an invalid WORKER_MODE value', () => {
    const { error } = validate({ WORKER_MODE: 'maybe' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('WORKER_MODE');
  });
});
