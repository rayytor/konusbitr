import pkg from '../../package.json';

/** Version of the running web app, reported by `GET /api/health`. */
export const APP_VERSION: string = pkg.version;
