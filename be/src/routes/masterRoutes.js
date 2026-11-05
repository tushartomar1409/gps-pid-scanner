// Master-data + user routers (one per module, built from the shared CRUD router).
import { createCrudRouter } from './crudRouter.js';
import { requireRole } from '../middleware/roleMiddleware.js';
import {
  zoneController, wardController, agencyController, vehicleController, userController,
} from '../controllers/masterControllers.js';
import { zoneSchemas, wardSchemas, agencySchemas, vehicleSchemas } from '../validators/masterValidators.js';
import { userSchemas } from '../validators/userValidators.js';

export const createZoneRoutes = () =>
  createCrudRouter({ controller: zoneController, schemas: zoneSchemas, permission: 'zones' });

export const createWardRoutes = () =>
  createCrudRouter({ controller: wardController, schemas: wardSchemas, permission: 'wards' });

export const createAgencyRoutes = () =>
  createCrudRouter({ controller: agencyController, schemas: agencySchemas, permission: 'agencies' });

export const createVehicleRoutes = () =>
  createCrudRouter({ controller: vehicleController, schemas: vehicleSchemas, permission: 'vehicles' });

// Users: SUPER_ADMIN only (GUIDE #2 task 8), on top of the users:* permission check.
export const createUserRoutes = () =>
  createCrudRouter({
    controller: userController,
    schemas: userSchemas,
    permission: 'users',
    guards: [requireRole('SUPER_ADMIN')],
  });
