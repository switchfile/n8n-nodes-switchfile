import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

// API key as bearer token. The base URL is configurable (own instance, staging); the default is production.
export class SwitchfileApi implements ICredentialType {
	name = 'switchfileApi';

	displayName = 'Switchfile API';

	icon: Icon = { light: 'file:../icons/switchfile.svg', dark: 'file:../icons/switchfile.dark.svg' };

	documentationUrl = 'https://switchfile.io/developers#n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create a key in the switchfile dashboard under API keys. Keys starting with sf_test_ are sandbox keys and never use credits.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.switchfile.io',
			description: 'Only change this if switchfile support gave you a different address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/account',
		},
	};
}
