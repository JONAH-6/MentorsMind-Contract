import request from 'supertest';
import express from 'express';
import { apiVersioningMiddleware, versionRegistry } from '../src/middleware/api-versioning.middleware';

describe('apiVersioningMiddleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(apiVersioningMiddleware);
    app.get('/api/v1/test', (req, res) => {
      res.json({ success: true, version: 'v1' });
    });
    app.get('/api/v2/test', (req, res) => {
      res.json({ success: true, version: 'v2' });
    });
    app.get('/api/test', (req, res) => {
      res.json({ success: true, version: 'default' });
    });
  });

  it('should allow current version (v2)', async () => {
    const response = await request(app).get('/api/v2/test');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('should default to v2 if no version is provided', async () => {
    const response = await request(app).get('/api/test');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('should return 404 for unknown version', async () => {
    const response = await request(app).get('/api/v99/test');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('API version not found');
  });

  it('should return 200 with headers for deprecated version (v1)', async () => {
    const response = await request(app).get('/api/v1/test');
    expect(response.status).toBe(200);
    expect(response.header).toHaveProperty('deprecation');
    expect(response.header).toHaveProperty('sunset');
    expect(response.header).toHaveProperty('link');
  });

  it('should return 410 for sunset version if date has passed', async () => {
    // Mocking a sunset version
    versionRegistry['v0'] = {
      version: 'v0',
      status: 'sunset',
      sunsetAt: new Date('2020-01-01'),
      migrationGuide: 'https://api.example.com/migration'
    };

    const response = await request(app).get('/api/v0/test');
    expect(response.status).toBe(410);
    expect(response.body.error).toContain('sunset');
    expect(response.body.migrationGuide).toBe('https://api.example.com/migration');
    
    delete versionRegistry['v0'];
  });
});
