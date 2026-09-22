// Looks up Cerberus "robots" and lets the browser (which builds the real JSON payload)
// create/delete a per-user "local-runner-{login}" robot. Thin pass-through - the response body
// is forwarded byte-for-byte either way.
'use strict';

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class CerberusRobotService {
  constructor(config, auth) {
    this.config = config;
    this.auth = auth;
  }

  selectedRobot() {
    return this.config.get('robot.name');
  }

  select(robotName) {
    this.config.set('robot.name', robotName == null ? '' : robotName.trim());
    this.config.save();
  }

  runnerName() {
    const custom = this.config.get('robot.runnerName');
    return custom === '' ? this.config.get('cerberus.auth.login') : custom;
  }

  setRunnerName(runnerName) {
    this.config.set('robot.runnerName', runnerName == null ? '' : runnerName.trim());
    this.config.save();
  }

  async listRobots() {
    return this.get('/api/public/robots');
  }

  async getRobot(robotName) {
    return this.get('/api/public/robots/' + encodeURIComponent(robotName));
  }

  async deleteRobot(robotName) {
    const authHeader = await this.auth.authHeader();
    const cerberusUrl = this.auth.cerberusUrl();
    if (!cerberusUrl) return { status: 400, body: '{"error":"Set a Cerberus URL first"}' };
    if (!authHeader) return { status: 401, body: '{"error":"Not authenticated"}' };

    const response = await fetchWithTimeout(cerberusUrl + '/api/public/robots/' + encodeURIComponent(robotName), {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-API-VERSION': '1', [authHeader.name]: authHeader.value },
    });
    return { status: response.status, body: await response.text() };
  }

  async createRobot(rawBody) {
    const authHeader = await this.auth.authHeader();
    const cerberusUrl = this.auth.cerberusUrl();
    if (!cerberusUrl) return { status: 400, body: '{"error":"Set a Cerberus URL first"}' };
    if (!authHeader) return { status: 401, body: '{"error":"Not authenticated"}' };

    const response = await fetchWithTimeout(cerberusUrl + '/api/public/robots', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-VERSION': '1', [authHeader.name]: authHeader.value },
      body: rawBody,
    }, 15000);
    return { status: response.status, body: await response.text() };
  }

  async get(pathname) {
    const authHeader = await this.auth.authHeader();
    const cerberusUrl = this.auth.cerberusUrl();
    if (!cerberusUrl) return { status: 400, body: '{"error":"Set a Cerberus URL first"}' };
    if (!authHeader) return { status: 401, body: '{"error":"Not authenticated"}' };

    const response = await fetchWithTimeout(cerberusUrl + pathname, {
      headers: { Accept: 'application/json', 'X-API-VERSION': '1', [authHeader.name]: authHeader.value },
    });
    return { status: response.status, body: await response.text() };
  }
}

module.exports = { CerberusRobotService };