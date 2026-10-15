import { createRequire } from 'module';

/*
  The declared settings, read from kempo-config.json itself, so the settings route writes each one
  with its declared type and description. `setSetting` stores exactly what it is handed: a missing
  type would store the Connect webhook secret as plain text, and a missing description would blank
  the line kempo's own /admin/settings screen shows next to it. One list, and a static test checks
  the route only writes what it declares.
*/
const require = createRequire(import.meta.url);
const config = require('../../kempo-config.json');

export const DECLARED_SETTINGS = new Map((config.settings || []).map(setting => [setting.name, setting]));

export const typeOf = name => DECLARED_SETTINGS.get(name)?.type || 'string';
export const descriptionOf = name => DECLARED_SETTINGS.get(name)?.description || null;
