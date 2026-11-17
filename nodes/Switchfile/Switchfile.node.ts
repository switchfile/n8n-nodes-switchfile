import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import type { Client, Conversion, ConvertSettings } from '../shared/api';
import { convertFile, convertUrl, downloadResults, getConversion, parseOptionsJson, waitForConversion } from '../shared/api';
import { clientFor, CREDENTIALS_TYPE, errorJson, toNodeError } from '../shared/transport';

const CONVERT_OPERATIONS = ['convertFile', 'convertUrl'];

// Actions: convert a file (binary data), convert a URL, get a conversion. With "Download Result" there is one item with
// binary data per result file (e.g. one page per image), otherwise one item with the conversion.
export class Switchfile implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Switchfile',
		name: 'switchfile',
		icon: { light: 'file:../../icons/switchfile.svg', dark: 'file:../../icons/switchfile.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description: 'Convert files between formats with switchfile',
		defaults: {
			name: 'Switchfile',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: CREDENTIALS_TYPE,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Convert File',
						value: 'convertFile',
						description: 'Convert a file from a binary field',
						action: 'Convert a file',
					},
					{
						name: 'Convert URL',
						value: 'convertUrl',
						description: 'Convert a file that is available at a public URL',
						action: 'Convert a file from a URL',
					},
					{
						name: 'Get Conversion',
						value: 'get',
						description: 'Get the status and result of a conversion',
						action: 'Get a conversion',
					},
				],
				default: 'convertFile',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { operation: ['convertFile'] } },
				hint: 'The name of the input binary field containing the file to be converted',
			},
			{
				displayName: 'File URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/report.docx',
				displayOptions: { show: { operation: ['convertUrl'] } },
				description: 'Public http or https address of the file',
			},
			{
				displayName: 'Target Format',
				name: 'to',
				type: 'string',
				default: '',
				placeholder: 'pdf',
				displayOptions: { show: { operation: CONVERT_OPERATIONS } },
				description:
					'File extension of the format to convert to, for example pdf, jpg or mp4. Leave empty when you choose a preset under Options. The list of formats is at https://switchfile.io/convert.',
			},
			{
				displayName: 'Conversion ID',
				name: 'conversionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['get'] } },
				description: 'The ID of the conversion, as returned by Convert File, Convert URL or the trigger',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: { show: { operation: CONVERT_OPERATIONS } },
				description:
					'Whether to wait until the conversion is finished. Turn this off to continue right away and fetch the result later with Get Conversion or the Switchfile Trigger.',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['get'] } },
				description: 'Whether to wait until the conversion is finished',
			},
			{
				displayName: 'Download Result',
				name: 'downloadResult',
				type: 'boolean',
				default: true,
				displayOptions: { show: { operation: CONVERT_OPERATIONS, waitForCompletion: [true] } },
				description:
					'Whether to add the converted files as binary data. A result with several files (for example one image per page) gives one item per file.',
			},
			{
				displayName: 'Download Result',
				name: 'downloadResult',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['get'] } },
				description:
					'Whether to add the converted files as binary data when the conversion is finished. A result with several files gives one item per file.',
			},
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { downloadResult: [true] } },
				hint: 'The name of the output binary field to put the converted file in',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: CONVERT_OPERATIONS } },
				options: [
					{
						displayName: 'Conversion Settings',
						name: 'conversionSettings',
						type: 'json',
						default: '{}',
						description:
							'Settings for the conversion as a JSON object, for example {"quality": 80}. The settings for each format are listed in the API documentation.',
					},
					{
						displayName: 'File Name',
						name: 'filename',
						type: 'string',
						default: '',
						placeholder: 'report.docx',
						description:
							'Name of the input file. By default the name from the binary data or the URL is used.',
					},
					{
						displayName: 'Input Format',
						name: 'inputFormat',
						type: 'string',
						default: '',
						placeholder: 'docx',
						description: 'Format of the input file, if the file name has no extension',
					},
					{
						displayName: 'Preset',
						name: 'preset',
						type: 'string',
						default: '',
						placeholder: 'Web images',
						description:
							'ID or name of a preset from your switchfile dashboard. It sets the target format and its settings; Conversion Settings override single values.',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 1800,
						typeOptions: { minValue: 1 },
						description: 'How many seconds to wait for the conversion before the node fails',
					},
					{
						displayName: 'Webhook URL',
						name: 'webhookUrl',
						type: 'string',
						default: '',
						placeholder: 'https://example.com/hooks/switchfile',
						description:
							'Send conversion.finished or conversion.failed to this URL instead of the webhook URL of your account',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['get'], waitForCompletion: [true] } },
				options: [
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 1800,
						typeOptions: { minValue: 1 },
						description: 'How many seconds to wait for the conversion before the node fails',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const client = await clientFor(this);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const wait = this.getNodeParameter('waitForCompletion', itemIndex, operation !== 'get') as boolean;
				const download = wait || operation === 'get' ? (this.getNodeParameter('downloadResult', itemIndex, false) as boolean) : false;
				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
				const timeoutSeconds = typeof options.timeout === 'number' ? options.timeout : 1800;

				let conversion: Conversion;
				if (operation === 'get') {
					const id = this.getNodeParameter('conversionId', itemIndex) as string;
					conversion = await getConversion(client, id);
					if (wait) conversion = await waitForConversion(client, conversion, timeoutSeconds);
				} else {
					const settings: ConvertSettings = {
						to: this.getNodeParameter('to', itemIndex, '') as string,
						preset: (options.preset as string) || undefined,
						options: parseOptionsJson(options.conversionSettings),
						inputFormat: (options.inputFormat as string) || undefined,
						webhookUrl: (options.webhookUrl as string) || undefined,
						wait,
						timeoutSeconds,
					};
					const filename = (options.filename as string) || undefined;
					if (operation === 'convertFile') {
						const field = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
						const binary = this.helpers.assertBinaryData(itemIndex, field);
						const data = await this.helpers.getBinaryDataBuffer(itemIndex, field);
						const name = filename ?? binary.fileName ?? `file${binary.fileExtension ? `.${binary.fileExtension}` : ''}`;
						if (!settings.inputFormat && !/\.[A-Za-z0-9]+$/.test(name) && binary.fileExtension) {
							settings.inputFormat = binary.fileExtension;
						}
						conversion = await convertFile(client, { data, filename: name, mimeType: binary.mimeType }, settings);
					} else {
						const url = this.getNodeParameter('url', itemIndex) as string;
						conversion = await convertUrl(client, url, { ...settings, filename });
					}
				}

				returnData.push(...(await outputFor(this, client, conversion, download, itemIndex)));
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: errorJson(error), pairedItem: { item: itemIndex } });
					continue;
				}
				throw toNodeError(this, error, itemIndex);
			}
		}

		return [returnData];
	}
}

/** One item per result file (with binary data) or one item with the conversion. */
async function outputFor(
	ctx: IExecuteFunctions,
	client: Client,
	conversion: Conversion,
	download: boolean,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const json = conversion as IDataObject;
	if (!download || conversion.status !== 'finished') return [{ json, pairedItem: { item: itemIndex } }];
	const field = ctx.getNodeParameter('outputBinaryPropertyName', itemIndex, 'data') as string;
	const files = await downloadResults(client, conversion);
	const out: INodeExecutionData[] = [];
	for (const [index, file] of files.entries()) {
		const binaryData = await ctx.helpers.prepareBinaryData(file.data, file.filename);
		out.push({
			json: { ...json, file: { filename: file.filename, size: file.size, index } },
			binary: { [field]: binaryData },
			pairedItem: { item: itemIndex },
		});
	}
	return out.length > 0 ? out : [{ json, pairedItem: { item: itemIndex } }];
}
