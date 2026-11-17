import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	checkSignature,
	CONVERSION_EVENTS,
	EVENT_HEADER,
	getAccount,
	registerWebhook,
	type SecretCache,
	SIGNATURE_HEADER,
	unregisterWebhook,
} from '../shared/api';
import { clientFor, CREDENTIALS_TYPE, toNodeError } from '../shared/transport';

// Starts the workflow on conversion.finished or conversion.failed. The API has one webhook URL per account
// (PATCH /v1/account); it applies to all conversions without their own webhook_url. On activation the node sets this
// URL, on deactivation it removes it again, but only if it still points to this workflow. Every call is checked with
// the account's signing secret (Switchfile-Signature, HMAC-SHA256 of the raw body).
// Secret and lock per trigger in the process: n8n saves static data only after a workflow run, and rejected requests
// do not start one. Without this cache the 60 s lock on fetching the secret would not hold across requests.
const secretCaches = new Map<string, SecretCache>();

function triggerKey(ctx: IHookFunctions | IWebhookFunctions): string {
	return `${ctx.getWorkflow().id ?? ''}:${ctx.getNode().id}`;
}

function secretCacheFor(ctx: IWebhookFunctions): SecretCache {
	const key = triggerKey(ctx);
	let cache = secretCaches.get(key);
	if (!cache) {
		cache = {};
		secretCaches.set(key, cache);
	}
	const stored = ctx.getWorkflowStaticData('node').signingSecret;
	if (cache.signingSecret === undefined && typeof stored === 'string') cache.signingSecret = stored;
	return cache;
}

export class SwitchfileTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Switchfile Trigger',
		name: 'switchfileTrigger',
		icon: { light: 'file:../../icons/switchfile.svg', dark: 'file:../../icons/switchfile.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{($parameter["events"] || []).join(", ")}}',
		description: 'Starts the workflow when a switchfile conversion finishes or fails',
		defaults: {
			name: 'Switchfile Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIALS_TYPE,
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['conversion.finished'],
				options: [
					{
						name: 'Conversion Failed',
						value: 'conversion.failed',
						description: 'A conversion could not be finished',
					},
					{
						name: 'Conversion Finished',
						value: 'conversion.finished',
						description: 'A conversion is done and the result can be downloaded',
					},
				],
			},
			{
				displayName: 'Replace Existing Webhook URL',
				name: 'replaceExisting',
				type: 'boolean',
				default: false,
				description:
					'Whether to replace a webhook URL that is already set in your switchfile account. An account has one webhook URL, so the other receiver stops getting events.',
			},
			{
				displayName:
					'Your switchfile account has one webhook URL. Activating this workflow sets it to this workflow, and conversions that send their own webhook URL do not reach it.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				secretCaches.delete(triggerKey(this));
				const url = this.getNodeWebhookUrl('default');
				const staticData = this.getWorkflowStaticData('node');
				try {
					const client = await clientFor(this);
					const account = await getAccount(client);
					if (!url || account.webhook_url !== url) return false;
					staticData.signingSecret = account.webhook_signing_secret;
					return true;
				} catch (error) {
					throw toNodeError(this, error);
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				secretCaches.delete(triggerKey(this));
				const url = this.getNodeWebhookUrl('default');
				const replace = this.getNodeParameter('replaceExisting', false) as boolean;
				const staticData = this.getWorkflowStaticData('node');
				if (!url) return false;
				try {
					const client = await clientFor(this);
					staticData.signingSecret = await registerWebhook(client, url, replace);
					return true;
				} catch (error) {
					throw toNodeError(this, error);
				}
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				secretCaches.delete(triggerKey(this));
				const url = this.getNodeWebhookUrl('default');
				const staticData = this.getWorkflowStaticData('node');
				try {
					const client = await clientFor(this);
					if (url) await unregisterWebhook(client, url);
					delete staticData.signingSecret;
					return true;
				} catch (error) {
					throw toNodeError(this, error);
				}
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject() as unknown as { rawBody?: Buffer };
		const headers = this.getHeaderData();
		const body = this.getBodyData();
		const signatureHeader = headers[SIGNATURE_HEADER];
		const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
		const raw = request.rawBody ?? Buffer.from(JSON.stringify(body));
		const staticData = this.getWorkflowStaticData('node');

		// Missing or malformed signature: 401 without an API call. If it does not match the stored secret (e.g. rotated in
		// the dashboard), the secret is reloaded with throttling; if that is not possible right now, 503 so the API retries.
		const cache = secretCacheFor(this);
		const check = await checkSignature(cache, raw, signature, async () => {
			const account = await getAccount(await clientFor(this));
			return account.webhook_signing_secret;
		});
		// Also put a reloaded secret into static data (saved once the workflow runs).
		if (typeof cache.signingSecret === 'string') staticData.signingSecret = cache.signingSecret;
		if (check !== 'valid') {
			const response = this.getResponseObject();
			if (check === 'unavailable') {
				response.status(503).json({
					code: 'SIGNING_SECRET_UNAVAILABLE',
					detail: 'The signature could not be checked right now. Try again later.',
				});
			} else {
				response.status(401).json({ code: 'INVALID_SIGNATURE', detail: 'The Switchfile-Signature header is invalid.' });
			}
			return { noWebhookResponse: true };
		}

		const eventHeader = headers[EVENT_HEADER];
		const event = typeof body.event === 'string' ? body.event : Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
		const events = this.getNodeParameter('events', [...CONVERSION_EVENTS]) as string[];
		if (!event || !events.includes(event)) {
			return { webhookResponse: { received: true, ignored: true } };
		}
		return { workflowData: [this.helpers.returnJsonArray(body as IDataObject)] };
	}
}
