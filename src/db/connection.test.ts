import { describe, expect, it } from 'vitest';
import { explainDbError, pgConfig } from './connection.js';

const SUPABASE = 'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require';

describe('pgConfig', () => {
  it('verifies hosted databases against the given CA and strips TLS params from the URL', () => {
    const config = pgConfig(SUPABASE, { caCertPath: 'certs/ca.crt', readFile: (p) => `PEM:${p}` });
    expect(config.ssl).toEqual({ ca: 'PEM:certs/ca.crt' });
    expect(config.connectionString).toBe('postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
  });

  it('uses verified TLS for a remote host even without sslmode', () => {
    expect(pgConfig('postgresql://u:p@db.example.com:5432/x').ssl).toBe(true);
    expect(pgConfig(SUPABASE).ssl).toBe(true);
  });

  it('never turns verification off, even with sslmode=no-verify', () => {
    expect(pgConfig('postgresql://u:p@db.example.com/x?sslmode=no-verify').ssl).toBe(true);
  });

  it('skips TLS only for local databases or sslmode=disable', () => {
    expect(pgConfig('postgresql://u@localhost:5433/x').ssl).toBeUndefined();
    expect(pgConfig('postgresql://u@db.internal/x?sslmode=disable').ssl).toBeUndefined();
  });

  it('keeps unrelated params', () => {
    expect(pgConfig('postgresql://u@localhost/x?schema=public&sslmode=disable').connectionString).toBe(
      'postgresql://u@localhost/x?schema=public',
    );
  });
});

describe('explainDbError', () => {
  it('explains certificate errors and ignores others', () => {
    expect(explainDbError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toContain('DATABASE_CA_CERT');
    expect(explainDbError({ code: 'ECONNREFUSED' })).toBeNull();
    expect(explainDbError(null)).toBeNull();
  });
});
