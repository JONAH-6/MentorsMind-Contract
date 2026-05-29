import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: string };
    }
  }
}

/**
 * Middleware that allows access if the authenticated user is an admin
 * or if their id matches the route param identified by `paramName`.
 *
 * @param paramName - The req.params key holding the resource owner id (default: 'id')
 *
 * @example
 * router.get('/users/:id/profile', requireOwnerOrAdmin(), handler);
 * router.get('/users/:userId/bookings', requireOwnerOrAdmin('userId'), handler);
 * router.get('/mentors/:mentorId/sessions', requireOwnerOrAdmin('mentorId'), handler);
 */
export const requireOwnerOrAdmin = (paramName = 'id') => (req: Request, res: Response, next: NextFunction): void => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const resourceId = req.params[paramName];
  if (user.role === 'admin' || user.id === resourceId) {
    next();
    return;
  }

  res.status(403).json({ success: false, error: 'Access denied' });
};
