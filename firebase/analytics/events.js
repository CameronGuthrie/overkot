// Shared by the relay and Electron (esbuild bundles this into main.js).
const FEATURES = ['map', 'calendar', 'group_finder', 'wiki', 'settings', 'widgets', 'changelog'];
const ACTIONS = ['locate_player', 'export_build', 'create_listing', 'request_join'];
const WIDGETS = ['boss', 'crafting', 'other', 'affiliation', 'factions', 'minimap', 'groupfinder', 'wiki', 'calendar', 'clock', 'build-exporter', 'temper-tracker', 'odeinfamy', 'arena'];
const EVENTS = ['app_launch', 'app_running', 'app_exit', 'feature_open', 'feature_use', 'widget_enabled'];
const CLIENT_ID = /^\d{1,16}\.\d{1,16}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function eventParams(name, input = {}) {
  if (!EVENTS.includes(name) || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (name === 'feature_open') return FEATURES.includes(input.feature) ? { feature: input.feature } : null;
  if (name === 'feature_use') return ACTIONS.includes(input.action) ? { action: input.action } : null;
  if (name === 'widget_enabled') return WIDGETS.includes(input.widget) ? { widget: input.widget } : null;
  return {};
}

function validateBatch(data, now = Date.now()) {
  if (!data || typeof data.client_id !== 'string' || typeof data.batch_id !== 'string'
      || typeof data.app_version !== 'string' || !CLIENT_ID.test(data.client_id) || !UUID.test(data.batch_id)
      || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.app_version || '')
      || data.app_version.length > 40 || !['win32', 'linux', 'darwin'].includes(data.os)
      || !Array.isArray(data.events) || data.events.length < 1 || data.events.length > 25
      || Object.keys(data).some(k => !['client_id', 'batch_id', 'app_version', 'os', 'events'].includes(k))) return null;
  const events = [];
  for (const event of data.events) {
    if (!event || Object.keys(event).some(k => !['name', 'params', 'timestamp', 'session_id', 'engagement_time_msec'].includes(k))) return null;
    const params = eventParams(event.name, event.params);
    if (!params || !event.params || JSON.stringify(params) !== JSON.stringify(event.params)
        || !Number.isSafeInteger(event.timestamp) || event.timestamp < now - 48 * 3600_000 || event.timestamp > now + 60_000
        || !Number.isSafeInteger(event.session_id) || event.session_id < 1 || event.session_id * 1000 > event.timestamp
        || !Number.isSafeInteger(event.engagement_time_msec) || event.engagement_time_msec < 0 || event.engagement_time_msec > 300_000) return null;
    events.push({ name: event.name, params: { ...params, app_version: data.app_version, operating_system: data.os,
      session_id: event.session_id, engagement_time_msec: event.engagement_time_msec, timestamp_micros: event.timestamp * 1000 } });
  }
  return { client_id: data.client_id, consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events };
}
module.exports = { FEATURES, ACTIONS, WIDGETS, EVENTS, CLIENT_ID, UUID, eventParams, validateBatch };
