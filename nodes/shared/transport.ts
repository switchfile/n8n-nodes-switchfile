// Connects the shared logic (api.ts) to n8n: API requests go through httpRequestWithAuthentication (the key comes
// from the credentials), signed upload and download URLs through httpRequest without a key.
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import type { ApiRequest, ApiResponse, Client } from './api';
import { ConversionFailedError, normalizeBaseUrl, SwitchfileApiError } from './api';

export const CREDENTIALS_TYPE = 'switchfileApi';

type Context = IExecuteFunctions | IHookFunctions | IWebhookFunctions;

function toN8nRequest(request: ApiRequest): IHttpRequestOptions {
	const isBuffer = Buffer.isBuffer(request.body);
	return {
		method: request.method,
		url: request.url,
		qs: request.qs,
		headers: request.headers,
		body: request.body as IHttpRequestOptions['body'],
		json: !isBuffer && !request.binary,
		encoding: request.binary ? 'arraybuffer' : undefined,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// Requests with a key never follow redirects; api.ts reports 3xx as UNEXPECTED_REDIRECT.
		disableFollowRedirect: request.auth === true,
		timeout: request.timeoutMs,
	};
}

function toResponse(raw: unknown): ApiResponse {
	const r = (raw ?? {}) as { statusCode?: number; headers?: Record<string, unknown>; body?: unknown };
	return { statusCode: r.statusCode ?? 0, headers: r.headers ?? {}, body: r.body };
}

function makeClient(ctx: Context, baseUrl: string): Client {
	return {
		baseUrl,
		sleep: async (ms: number) => await sleep(ms),
		send: async (request: ApiRequest) => {
			const options = toN8nRequest(request);
			const raw = request.auth
				? await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_TYPE, options)
				: await ctx.helpers.httpRequest(options);
			return toResponse(raw);
		},
	};
}

/** Client for the node's credentials (base URL from the credentials). */
export async function clientFor(ctx: Context): Promise<Client> {
	const credentials = await ctx.getCredentials(CREDENTIALS_TYPE);
	return makeClient(ctx, normalizeBaseUrl(credentials.baseUrl));
}

/** Maps api.ts errors to n8n errors (code and status stay visible). */
export function toNodeError(ctx: Context, error: unknown, itemIndex?: number): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	if (error instanceof ConversionFailedError) {
		return new NodeOperationError(ctx.getNode(), error.message, {
			itemIndex,
			description: `Error code ${error.code}. Conversion ID ${error.conversion.id}.`,
		});
	}
	if (error instanceof SwitchfileApiError) {
		if (error.status === 0) {
			return new NodeOperationError(ctx.getNode(), error.message, { itemIndex, description: `Error code ${error.code}.` });
		}
		const body: JsonObject = { code: error.code, message: error.message, status: error.status };
		return new NodeApiError(ctx.getNode(), body, {
			itemIndex,
			message: error.message,
			description: `Error code ${error.code}.`,
			httpCode: String(error.status),
		});
	}
	const message = error instanceof Error ? error.message : String(error);
	return new NodeOperationError(ctx.getNode(), message, { itemIndex });
}

/** Output fields for continueOnFail. */
export function errorJson(error: unknown): IDataObject {
	if (error instanceof ConversionFailedError) {
		return { error: error.message, code: error.code, conversion: error.conversion as IDataObject };
	}
	if (error instanceof SwitchfileApiError) return { error: error.message, code: error.code, status: error.status };
	return { error: error instanceof Error ? error.message : String(error) };
}
