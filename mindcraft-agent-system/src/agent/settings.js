// extremely lightweight obj that can be imported/modified by any file
import { applySessionPolicy } from '../utils/session_policy.js';
let settings = {};
export default settings;
export function setSettings(new_settings) {
    Object.keys(settings).forEach(key => delete settings[key]);
    Object.assign(settings, new_settings);
    applySessionPolicy(settings);
}
