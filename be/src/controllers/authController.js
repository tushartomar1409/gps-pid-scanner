import { authService } from '../services/authService.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { requestContext } from './crudController.js';

export const authController = {
  async login(req, res) {
    const data = await authService.login(req.valid.body, requestContext(req));
    sendSuccess(res, { message: 'Login successful', data });
  },
  async profile(req, res) {
    const data = await authService.profile(req.user.id);
    sendSuccess(res, { message: 'Profile fetched successfully', data });
  },
  async logout(req, res) {
    await authService.logout(requestContext(req));
    sendSuccess(res, { message: 'Logged out successfully' });
  },
};
