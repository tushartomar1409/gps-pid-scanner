import { Router } from 'express';
import { authController } from '../controllers/authController.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { createLoginLimiter } from '../middleware/rateLimit.js';
import { loginSchema } from '../validators/userValidators.js';

export function createAuthRoutes() {
  const router = Router();
  router.post('/login', createLoginLimiter(), validate({ body: loginSchema }), authController.login);
  router.get('/profile', authenticate, authController.profile);
  router.post('/logout', authenticate, authController.logout);
  router.post('/logout-all', authenticate, authController.logoutAll); // GUIDE #11 C2
  return router;
}
