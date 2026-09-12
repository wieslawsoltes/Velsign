import {env} from 'cloudflare:workers';
import {createService} from '../../../server/service.js';
const service=createService(env);
export const GET=service;
export const POST=service;
export const PATCH=service;
export const DELETE=service;
