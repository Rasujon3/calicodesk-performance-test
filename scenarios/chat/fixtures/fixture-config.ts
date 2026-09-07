/**
 * Shared configuration for the CalicoDesk chat embed fixture server.
 *
 * The fixture server is a tiny static file server that serves
 * `scenarios/chat/fixtures/` (embed.html) so Playwright tests can load the
 * external-website embed page over HTTP. These constants keep the port and
 * origin in one place: `server.mjs`, `playwright.config.ts`, and the spec all
 * agree on the same value.
 */

export const FIXTURE_SERVER_HOST = '127.0.0.1';

export const FIXTURE_SERVER_PORT = Number(
  process.env.CALICODESK_FIXTURE_PORT ?? 4177,
);

export const FIXTURE_ORIGIN = `http://${FIXTURE_SERVER_HOST}:${FIXTURE_SERVER_PORT}`;

export const FIXTURE_EMBED_PATH = '/embed.html';

export const FIXTURE_EMBED_URL = `${FIXTURE_ORIGIN}${FIXTURE_EMBED_PATH}`;