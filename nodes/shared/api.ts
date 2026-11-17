// Shared logic of the switchfile nodes: requests with retries, /v1 conversion (file, URL), waiting, download and
// webhook signatures. Deliberately no runtime import from n8n-workflow: the transport (httpRequestWithAuthentication
// or httpRequest) and sleep are passed in as functions, so the tests run against the mock server without n8n.
// Errors are never thrown inside a catch block here (n8n linter); the nodes wrap them in NodeApiError.
import { randomUUID } from 'crypto';

import { multipartBody, safeUploadHeaders, unexpectedRedirectMessage } from './http-common';

// Shared with the Zapier app (source: integrations/shared/http-common.ts).
export {
	checkSignature,
	multipartBody,
	safeUploadHeaders,
	SECRET_RETRY_MS,
	signPayload,
	verifySignature,
	type SecretCache,
	type SignatureCheck,
} from './http-common';

/** Files up to this size are sent in the request (multipart), larger ones via POST /v1/uploads. */
export const MULTIPART_LIMIT = 50 * 1024 * 1024;
/** Long poll per request (seconds), as in the SDKs. */
export const LONG_POLL_SECONDS = 30;
export const DEFAULT_BASE_URL = 'https://api.switchfile.io';
export const USER_AGENT = 'n8n-nodes-switchfile/0.1.1';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Json = Record<string, unknown>;

export interface ApiRequest {
	method: HttpMethod;
	/** Absolute URL. */
	url: string;
	qs?: Record<string, string | number>;
	headers?: Record<string, string>;
	/** Object: JSON. Buffer: sent as is (Content-Type in headers). */
	body?: Json | Buffer;
	/** false for signed upload and download URLs: the API key is never sent there. */
	auth: boolean;
	/** Response as a Buffer instead of JSON. */
	binary?: boolean;
	timeoutMs: number;
}

export interface ApiResponse {
	statusCode: number;
	headers: Record<string, unknown>;
	body: unknown;
}

export interface Client {
	send: (request: ApiRequest) => Promise<ApiResponse>;
	sleep: (ms: number) => Promise<void>;
	baseUrl: string;
	maxRetries?: number;
	timeoutMs?: number;
}

export interface ConversionFile {
	filename: string;
	size: number;
	url: string;
}

export interface Conversion extends Json {
	id: string;
	status: 'queued' | 'processing' | 'finished' | 'failed';
	result: { files: ConversionFile[] } | null;
	download_url: string | null;
	error: { code: string; message: string } | null;
}

/** API error with a stable code (problem+json `code`) and HTTP status. */
export class SwitchfileApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly body?: unknown,
		readonly retryAfter?: number,
	) {
		super(message);
		this.name = 'SwitchfileApiError';
	}
}

/** The conversion failed (status failed); `conversion` holds code and message under `error`. */
export class ConversionFailedError extends Error {
	readonly code: string;

	constructor(readonly conversion: Conversion) {
		super(`The conversion failed: ${conversion.error?.message ?? 'unknown error'}`);
		this.name = 'ConversionFailedError';
		this.code = conversion.error?.code ?? 'CONVERSION_FAILED';
	}
}

export function normalizeBaseUrl(raw: unknown): string {
	const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE_URL;
	return value.replace(/\/+$/, '');
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
	for (const [k, v] of Object.entries(headers ?? {})) {
		if (k.toLowerCase() === name) return Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v);
	}
	return undefined;
}

/** Reads the body defensively: depending on Content-Type, n8n returns an object, string or Buffer. */
export function parseBody(body: unknown): unknown {
	if (Buffer.isBuffer(body)) body = body.toString('utf8');
	if (typeof body !== 'string') return body;
	if (body === '') return null;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

const FALLBACK_CODES: Record<number, string> = {
	401: 'UNAUTHENTICATED',
	403: 'FORBIDDEN',
	404: 'NOT_FOUND',
	413: 'FILE_TOO_LARGE',
	422: 'INVALID_DATA',
	429: 'RATE_LIMIT_EXCEEDED',
};

export function errorFromResponse(status: number, body: unknown, retryAfter?: string): SwitchfileApiError {
	const b = body && typeof body === 'object' ? (body as Json) : {};
	const code =
		typeof b.code === 'string' && b.code !== ''
			? b.code
			: status >= 500
				? 'INTERNAL_ERROR'
				: (FALLBACK_CODES[status] ?? 'HTTP_ERROR');
	let message = `The switchfile API answered with HTTP ${status}.`;
	for (const k of ['detail', 'message', 'title']) {
		if (typeof b[k] === 'string' && b[k] !== '') {
			message = b[k] as string;
			break;
		}
	}
	const ra = retryAfter !== undefined && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : undefined;
	return new SwitchfileApiError(code, message, status, body, ra);
}

function backoff(attempt: number): number {
	return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * One request with retries: GET and DELETE after network errors and 5xx, POST/PATCH only with an idempotency key.
 * 429 RATE_LIMIT_EXCEEDED and 409 IDEMPOTENCY_KEY_IN_USE always (Retry-After up to 60 s).
 */
export async function send(client: Client, request: ApiRequest, idempotencyKey?: string): Promise<ApiResponse> {
	const maxRetries = client.maxRetries ?? 3;
	const retryServer = request.method === 'GET' || request.method === 'DELETE' || idempotencyKey !== undefined;
	const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(request.headers ?? {}) };
	if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
	for (let attempt = 0; ; attempt++) {
		let response: ApiResponse | undefined;
		let failure: unknown;
		try {
			response = await client.send({ ...request, headers });
		} catch (error) {
			failure = error;
		}
		if (response === undefined) {
			if (retryServer && attempt < maxRetries) {
				await client.sleep(backoff(attempt));
				continue;
			}
			const reason = failure instanceof Error ? `: ${failure.message}` : '';
			throw new SwitchfileApiError('NETWORK_ERROR', `Could not reach ${hostOf(request.url)}${reason}`, 0);
		}
		if (response.statusCode >= 200 && response.statusCode < 300) return response;
		if (response.statusCode >= 300 && response.statusCode < 400) {
			// Never follow API redirects (the key would stay in the header) and do not retry: usually the base URL is
			// wrong (http instead of https).
			throw new SwitchfileApiError(
				'UNEXPECTED_REDIRECT',
				unexpectedRedirectMessage(response.statusCode, header(response.headers, 'location'), request.url),
				response.statusCode,
			);
		}
		const err = errorFromResponse(response.statusCode, parseBody(response.body), header(response.headers, 'retry-after'));
		const again =
			(err.status === 429 && err.code === 'RATE_LIMIT_EXCEEDED') ||
			(err.status === 409 && err.code === 'IDEMPOTENCY_KEY_IN_USE') ||
			(retryServer && [500, 502, 503, 504].includes(err.status));
		if (again && attempt < maxRetries) {
			const wait = err.retryAfter !== undefined ? err.retryAfter * 1000 : backoff(attempt);
			if (wait <= 60_000) {
				await client.sleep(wait);
				continue;
			}
		}
		throw err;
	}
}

/** JSON request to the API (with key). */
export async function api<T = Json>(
	client: Client,
	method: HttpMethod,
	path: string,
	options: { qs?: Record<string, string | number>; body?: Json; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<T> {
	const response = await send(
		client,
		{
			method,
			url: client.baseUrl + path,
			qs: options.qs,
			body: options.body,
			auth: true,
			timeoutMs: options.timeoutMs ?? client.timeoutMs ?? 60_000,
		},
		options.idempotencyKey,
	);
	return parseBody(response.body) as T;
}

/**
 * Resolves a signed API URL: relative paths against the base URL, only http(s) and no credentials in the URL.
 */
export function resolveSignedUrl(client: Client, url: string): string {
	const absolute = /^https?:\/\//i.test(url) ? url : `${client.baseUrl}/${url.replace(/^\/+/, '')}`;
	let parsed: URL | undefined;
	try {
		parsed = new URL(absolute);
	} catch {
		parsed = undefined;
	}
	if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
		throw new SwitchfileApiError('BAD_RESPONSE', 'The switchfile API returned a file URL that is not allowed.', 0);
	}
	return absolute;
}

// ---- Conversion ----

export interface ConvertSettings {
	/** Target format; empty when a preset is set. */
	to?: string;
	/** Conversion settings, e.g. { quality: 80 }. */
	options?: Json;
	inputFormat?: string;
	webhookUrl?: string;
	/** Wait for the result (default true). */
	wait?: boolean;
	/** Maximum wait time (seconds, default 1800). */
	timeoutSeconds?: number;
	idempotencyKey?: string;
	multipartLimit?: number;
	/** ID or name of a dashboard preset: sets target format and settings; `to` may then be empty. */
	preset?: string;
}

export interface FileInput {
	data: Buffer;
	filename: string;
	mimeType?: string;
}

function commonFields(settings: ConvertSettings): Json {
	const to = (settings.to ?? '').trim().replace(/^\./, '').toLowerCase();
	const preset = (settings.preset ?? '').trim();
	if (to === '' && preset === '') {
		throw new SwitchfileApiError('INVALID_DATA', 'The target format is missing. Enter a format or choose a preset.', 0);
	}
	const fields: Json = {};
	if (to !== '') fields.to = to;
	if (preset !== '') fields.preset = preset;
	if (settings.options && Object.keys(settings.options).length > 0) fields.options = settings.options;
	if (settings.inputFormat) fields.input_format = settings.inputFormat.trim().replace(/^\./, '').toLowerCase();
	if (settings.webhookUrl) fields.webhook_url = settings.webhookUrl.trim();
	return fields;
}

function waitQuery(settings: ConvertSettings): Record<string, number> | undefined {
	return settings.wait === false ? undefined : { wait: LONG_POLL_SECONDS };
}

function requestTimeout(client: Client, settings: ConvertSettings): number {
	return (client.timeoutMs ?? 60_000) + (settings.wait === false ? 0 : LONG_POLL_SECONDS * 1000);
}

async function finish(client: Client, conversion: Conversion, settings: ConvertSettings): Promise<Conversion> {
	if (settings.wait === false) return conversion;
	return await waitForConversion(client, conversion, settings.timeoutSeconds ?? 1800);
}

/** Converts a file (binary data). Up to 50 MB in the request, larger via an upload URL. */
export async function convertFile(client: Client, file: FileInput, settings: ConvertSettings): Promise<Conversion> {
	const fields = commonFields(settings);
	const key = settings.idempotencyKey ?? randomUUID();
	const limit = settings.multipartLimit ?? MULTIPART_LIMIT;
	let conversion: Conversion;
	if (file.data.length <= limit) {
		const form: Record<string, string> = { filename: file.filename };
		if (fields.to) form.to = String(fields.to);
		if (fields.preset) form.preset = String(fields.preset);
		if (fields.options) form.options = JSON.stringify(fields.options);
		if (fields.input_format) form.input_format = String(fields.input_format);
		if (fields.webhook_url) form.webhook_url = String(fields.webhook_url);
		const { body, contentType } = multipartBody(form, {
			data: file.data,
			filename: file.filename,
			contentType: file.mimeType,
		});
		const response = await send(
			client,
			{
				method: 'POST',
				url: `${client.baseUrl}/v1/convert`,
				qs: waitQuery(settings),
				headers: { 'Content-Type': contentType },
				body,
				auth: true,
				timeoutMs: Math.max(requestTimeout(client, settings), 30 * 60_000),
			},
			key,
		);
		conversion = parseBody(response.body) as Conversion;
	} else {
		const upload = await api<{ upload_id: string; url: string; headers?: Record<string, string> }>(client, 'POST', '/v1/uploads', {
			body: { filename: file.filename, size: file.data.length },
			idempotencyKey: `${key}:upload`,
		});
		await send(client, {
			method: 'PUT',
			url: resolveSignedUrl(client, upload.url),
			headers: { ...safeUploadHeaders(upload.headers), 'Content-Length': String(file.data.length) },
			body: file.data,
			auth: false,
			timeoutMs: 60 * 60_000,
		});
		conversion = await api<Conversion>(client, 'POST', '/v1/convert', {
			qs: waitQuery(settings),
			body: { upload_id: upload.upload_id, filename: file.filename, ...fields },
			idempotencyKey: key,
			timeoutMs: requestTimeout(client, settings),
		});
	}
	return await finish(client, conversion, settings);
}

/** Converts the file behind a public URL. */
export async function convertUrl(
	client: Client,
	url: string,
	settings: ConvertSettings & { filename?: string },
): Promise<Conversion> {
	if (!/^https?:\/\//i.test(url.trim())) {
		throw new SwitchfileApiError('INVALID_DATA', 'The file URL must start with http:// or https://.', 0);
	}
	const body: Json = { url: url.trim(), ...commonFields(settings) };
	if (settings.filename) body.filename = settings.filename;
	const conversion = await api<Conversion>(client, 'POST', '/v1/convert', {
		qs: waitQuery(settings),
		body,
		idempotencyKey: settings.idempotencyKey ?? randomUUID(),
		timeoutMs: requestTimeout(client, settings),
	});
	return await finish(client, conversion, settings);
}

export async function getConversion(client: Client, id: string, waitSeconds?: number): Promise<Conversion> {
	if (!id || id.trim() === '') throw new SwitchfileApiError('INVALID_DATA', 'The conversion ID is missing.', 0);
	const qs = waitSeconds ? { wait: Math.min(LONG_POLL_SECONDS, Math.max(1, Math.round(waitSeconds))) } : undefined;
	return await api<Conversion>(client, 'GET', `/v1/conversions/${encodeURIComponent(id.trim())}`, {
		qs,
		timeoutMs: (client.timeoutMs ?? 60_000) + (qs ? LONG_POLL_SECONDS * 1000 : 0),
	});
}

const done = (c: Conversion) => c.status === 'finished' || c.status === 'failed';

/**
 * Waits until the conversion is done (long poll with wait=30, with a pause growing x1.5 up to 5 s in between if the
 * API answers immediately). Throws ConversionFailedError on status failed, SwitchfileApiError TIMEOUT after
 * timeoutSeconds.
 */
export async function waitForConversion(client: Client, conversion: Conversion, timeoutSeconds = 1800): Promise<Conversion> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	let current = conversion;
	let pause = 500;
	while (!done(current)) {
		const left = deadline - Date.now();
		if (left <= 0) {
			throw new SwitchfileApiError(
				'TIMEOUT',
				`The conversion ${current.id} did not finish within ${timeoutSeconds} seconds. Use "Get Conversion" to check it later.`,
				0,
				current,
			);
		}
		const started = Date.now();
		current = await getConversion(client, current.id, Math.min(LONG_POLL_SECONDS, Math.ceil(left / 1000)));
		if (!done(current) && Date.now() - started < 1000) {
			await client.sleep(Math.min(pause, Math.max(0, deadline - Date.now())));
			pause = Math.min(5000, pause * 1.5);
		}
	}
	if (current.status === 'failed') throw new ConversionFailedError(current);
	return current;
}

export interface DownloadedFile {
	data: Buffer;
	filename: string;
	size: number;
}

/** Downloads all result files (signed URLs, no key). Empty list while nothing is finished. */
export async function downloadResults(client: Client, conversion: Conversion): Promise<DownloadedFile[]> {
	const files = conversion.result?.files ?? [];
	const out: DownloadedFile[] = [];
	for (const file of files) {
		const response = await send(client, {
			method: 'GET',
			url: resolveSignedUrl(client, file.url),
			auth: false,
			binary: true,
			timeoutMs: 60 * 60_000,
		});
		const body = response.body;
		const data = Buffer.isBuffer(body)
			? body
			: body instanceof ArrayBuffer
				? Buffer.from(body)
				: ArrayBuffer.isView(body)
					? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
					: Buffer.from(String(body ?? ''), 'utf8');
		out.push({ data, filename: file.filename, size: data.length });
	}
	return out;
}

// ---- Webhooks ----

export const SIGNATURE_HEADER = 'switchfile-signature';
export const EVENT_HEADER = 'switchfile-event';
export const CONVERSION_EVENTS = ['conversion.finished', 'conversion.failed'] as const;

export interface Account extends Json {
	webhook_url: string | null;
	webhook_signing_secret: string;
}

export async function getAccount(client: Client): Promise<Account> {
	return await api<Account>(client, 'GET', '/v1/account');
}

export async function setWebhookUrl(client: Client, url: string | null): Promise<Account> {
	return await api<Account>(client, 'PATCH', '/v1/account', { body: { webhook_url: url } });
}

/**
 * Sets the account's webhook URL to `url`. The account has exactly one URL; a different one is only overwritten with
 * `replace`, otherwise WEBHOOK_URL_IN_USE is thrown. Returns the signing secret.
 */
export async function registerWebhook(client: Client, url: string, replace: boolean): Promise<string> {
	const account = await getAccount(client);
	if (account.webhook_url && account.webhook_url !== url && !replace) {
		throw new SwitchfileApiError(
			'WEBHOOK_URL_IN_USE',
			`Your switchfile account already sends webhooks to ${account.webhook_url}. An account has one webhook URL. ` +
				'Turn on "Replace Existing Webhook URL" to use this workflow instead.',
			409,
		);
	}
	const updated = account.webhook_url === url ? account : await setWebhookUrl(client, url);
	return updated.webhook_signing_secret;
}

/** Removes the webhook URL, but only if it still points to `url` (otherwise it now belongs to someone else). */
export async function unregisterWebhook(client: Client, url: string): Promise<boolean> {
	const account = await getAccount(client);
	if (account.webhook_url !== url) return false;
	await setWebhookUrl(client, null);
	return true;
}

/** Reads the conversion settings from the node's JSON field. */
export function parseOptionsJson(raw: unknown): Json {
	if (raw === undefined || raw === null || raw === '') return {};
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			value = undefined;
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new SwitchfileApiError('INVALID_DATA', 'Conversion Settings must be a JSON object, for example {"quality": 80}.', 0);
	}
	return value as Json;
}
