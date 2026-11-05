import { createCrudController } from './crudController.js';
import { zoneService, wardService, agencyService, vehicleService } from '../services/masterServices.js';
import { userService } from '../services/userService.js';

export const zoneController = createCrudController(zoneService, { singular: 'Zone', plural: 'Zones' });
export const wardController = createCrudController(wardService, { singular: 'Ward', plural: 'Wards' });
export const agencyController = createCrudController(agencyService, { singular: 'Agency', plural: 'Agencies' });
export const vehicleController = createCrudController(vehicleService, { singular: 'Vehicle', plural: 'Vehicles' });
export const userController = createCrudController(userService, { singular: 'User', plural: 'Users' });
