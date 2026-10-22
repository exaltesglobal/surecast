// Loaded first by every test: point the app at the test database.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_USER ??= 'surecast';
process.env.DB_PASSWORD ??= 'devpass';
process.env.DB_NAME = process.env.TEST_DB_NAME ?? 'surecast_test';
process.env.RUN_SCHEDULER = 'false';
process.env.QUIET_EMAIL = '1';
process.env.APP_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.CRON_SECRET = 'cron-test';
process.env.PUBLIC_URL = 'http://localhost:3000';
