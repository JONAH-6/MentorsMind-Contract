import { Request, Response, NextFunction } from 'express';

export interface VersionInfo {
  version: string;
  status: 'current' | 'deprecated' | 'sunset';
  deprecatedAt?: Date;
  sunsetAt?: Date;
  migrationGuide?: string;
  breakingChanges?: string[];
}

export const versionRegistry: Record<string, VersionInfo> = {
  'v1': {
    version: 'v1',
    status: 'deprecated',
    deprecatedAt: new Date('2026-01-01'),
    sunsetAt: new Date('2027-01-01'),
    migrationGuide: 'https://api.mentorminds.com/migration/v1-to-v2',
    breakingChanges: ['Auth header changes', 'Pagination format changes'],
  },
  'v2': {
    version: 'v2',
    status: 'current',
  }
};

export const apiVersioningMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Extract version from path, e.g., /api/v1/...
  const pathParts = req.path.split('/');
  const versionParam = pathParts.find(part => part.match(/^v[0-9]+$/));
  const version = versionParam || 'v2';
  
  const versionInfo = versionRegistry[version];

  if (!versionInfo) {
    res.status(404).json({ error: 'API version not found' });
    return;
  }

  if (versionInfo.status === 'sunset') {
    if (versionInfo.sunsetAt && new Date() >= versionInfo.sunsetAt) {
      res.status(410).json({ 
        error: 'API version is no longer supported (sunset).',
        migrationGuide: versionInfo.migrationGuide
      });
      return;
    }
  }

  if (versionInfo.status === 'deprecated') {
    if (versionInfo.deprecatedAt) {
      res.setHeader('Deprecation', versionInfo.deprecatedAt.toUTCString());
    }
    if (versionInfo.sunsetAt) {
      res.setHeader('Sunset', versionInfo.sunsetAt.toUTCString());
    }
    if (versionInfo.migrationGuide) {
      res.setHeader('Link', `<${versionInfo.migrationGuide}>; rel="successor-version"`);
    }
  }

  next();
};
