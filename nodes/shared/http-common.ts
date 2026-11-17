// GENERATED from integrations/shared/http-common.ts by `bun integrations/shared/build.ts`. Do not edit by hand.
// Shared HTTP helpers for the n8n and Zapier integrations (one source, no npm package: n8n's strict mode allows
// no runtime dependencies). `bun integrations/shared/build.ts` writes this file to
// integrations/n8n/nodes/shared/http-common.ts (unchanged) and integrations/zapier/src/http-common.js (CommonJS).
// integrations/shared/http-common.test.ts tests the functions and checks that both copies are current.
// Also contains the trigger signature check (checkSignature) with throttled fetching of the secret.
// Import only `crypto` (n8n linter) and use only Node APIs that both n8n and Zapier (Node 22) provide.
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

/** Input file for multipart/form-data. */
export interface MultipartFile {
	data: Buffer;
	filename: string;
	contentType?: string;
}

/** Field and file names in the Content-Disposition header: replace line breaks, quotes and backslashes. */
export function quoteName(name: string): string {
	return String(name).replace(/[\r\n"\\]/g, '_');
}

/** multipart/form-data by hand (no FormData) so the body is a Buffer with a known length. */
export function multipartBody(
	fields: Record<string, string>,
	file: MultipartFile,
): { body: Buffer; contentType: string } {
	const boundary = `----switchfile${randomUUID().replace(/-/g, '')}`;
	const parts: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${quoteName(name)}"\r\n\r\n${value}\r\n`,
				'utf8',
			),
		);
	}
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoteName(file.filename)}"\r\n` +
				`Content-Type: ${quoteName(file.contentType || 'application/octet-stream')}\r\n\r\n`,
			'utf8',
		),
	);
	parts.push(file.data);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const SAFE_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const BLOCKED_HEADER = /^(authorization|cookie|host|content-length|transfer-encoding|connection)$/i;
const SAFE_HEADER_VALUE = /^[^\r\n\0]*$/;

/**
 * Headers for the PUT to the upload URL: only those the API specifies (e.g. for object storage), never
 * Authorization, Cookie, Host or length and connection headers; no invalid names or values with line breaks.
 * Same rules as safeUploadHeaders in the SDKs.
 */
export function safeUploadHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value === undefined || value === null) continue;
		const text = String(value);
		if (!SAFE_HEADER_NAME.test(name) || BLOCKED_HEADER.test(name) || !SAFE_HEADER_VALUE.test(text)) continue;
		out[name] = text;
	}
	return out;
}

/** HMAC-SHA256 (hex) of the raw body with the account's webhook_signing_secret. */
export function signPayload(payload: Buffer | string, secret: string): string {
	return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Checks Switchfile-Signature (64 hex characters, case-insensitive) in constant time. */
export function verifySignature(payload: unknown, signature: unknown, secret: unknown): boolean {
	if (typeof signature !== 'string' || typeof secret !== 'string' || secret === '') return false;
	if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return false;
	const given = signature.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(given)) return false;
	const expected = Buffer.from(signPayload(payload, secret), 'utf8');
	return timingSafeEqual(expected, Buffer.from(given, 'utf8'));
}

/** Minimum interval between two fetches of the secret (also after a failure). */
export const SECRET_RETRY_MS = 60_000;

/** Trigger cache (n8n: the node's static data, Zapier: per key in the process): secret and time of last fetch. */
export interface SecretCache {
	signingSecret?: unknown;
	secretFetchedAt?: unknown;
}

/**
 * Result of the check: `invalid` means definitely wrong (401), `unavailable` means "cannot be checked right now" (503;
 * the API redelivers webhooks only on 5xx and network errors).
 */
export type SignatureCheck = 'valid' | 'invalid' | 'unavailable';

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Checks the signature of a webhook request against the stored secret.
 * - Missing or malformed signature (not 64 hex characters): `invalid`, without an API call.
 * - Matches the stored secret: `valid`, without an API call.
 * - Otherwise (no secret stored, or rotated in the dashboard): reload the secret, at most once per SECRET_RETRY_MS
 *   (also after failures that do not throw), then check again. If the throttle is active or the fetch failed:
 *   `unavailable`, so the API redelivers later and no event is lost.
 */
export async function checkSignature(
	cache: SecretCache,
	payload: unknown,
	signature: unknown,
	fetchSecret: () => Promise<string>,
	now: number = Date.now(),
): Promise<SignatureCheck> {
	const given = typeof signature === 'string' ? signature.trim() : '';
	if (!SIGNATURE_PATTERN.test(given)) return 'invalid';
	const stored = () => (typeof cache.signingSecret === 'string' ? cache.signingSecret : '');
	if (stored() !== '' && verifySignature(payload, given, stored())) return 'valid';
	const last = typeof cache.secretFetchedAt === 'number' ? cache.secretFetchedAt : 0;
	if (now - last < SECRET_RETRY_MS) return 'unavailable';
	cache.secretFetchedAt = now;
	let fetched = '';
	try {
		fetched = await fetchSecret();
	} catch {
		// The failure is recorded via secretFetchedAt; the next attempt comes after SECRET_RETRY_MS at the earliest.
	}
	if (typeof fetched !== 'string' || fetched === '') return 'unavailable';
	cache.signingSecret = fetched;
	return verifySignature(payload, given, fetched) ? 'valid' : 'invalid';
}

/** Message for a 3xx response from the API (like UNEXPECTED_REDIRECT in the SDKs): do not follow, check the base URL. */
export function unexpectedRedirectMessage(status: number, location: unknown, url: string): string {
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		// not a URL: keep as is
	}
	const target = typeof location === 'string' && location !== '' ? ` to ${location}` : '';
	return `The switchfile API at ${host} answered with a redirect (HTTP ${status}${target}). Check the base URL; it should be https://api.switchfile.io.`;
}
