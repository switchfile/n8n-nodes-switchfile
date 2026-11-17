# n8n-nodes-switchfile

n8n community nodes for [switchfile](https://switchfile.io): convert files between formats inside your workflows and
start a workflow when a conversion finishes.

- **Switchfile** node with three operations: Convert File (binary data in, binary data out), Convert URL and
  Get Conversion. The node can also be used as a tool by AI agents.
- **Switchfile Trigger** starts a workflow on `conversion.finished` or `conversion.failed`.

## Installation

In n8n, open **Settings → Community Nodes → Install**, enter `n8n-nodes-switchfile` and confirm. See the
[n8n guide for community nodes](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted setups
and queue mode.

## Credentials

1. Create an API key in the [switchfile dashboard](https://switchfile.io/dashboard/keys). Keys starting with
   `sf_test_` are sandbox keys and never use credits, which is useful while you build a workflow.
2. In n8n, add a **Switchfile API** credential and paste the key. Leave **Base URL** at `https://api.switchfile.io`.

n8n checks the key when you save the credential.

## Operations

### Convert File

Converts the file in a binary field of each input item, for example from an HTTP Request, Read Binary File or
email node.

| Field | Description |
|---|---|
| Input Binary Field | Name of the binary field with the file, `data` by default |
| Target Format | File extension of the result, for example `pdf`, `jpg`, `mp4`. Leave it empty when you use a preset |
| Wait for Completion | On by default. Off: the node returns the conversion right away with status `queued` |
| Download Result | On by default. Adds the converted file as binary data |
| Output Binary Field | Name of the binary field for the result, `data` by default |
| Options → Preset | ID or name of a preset from your dashboard. It sets the format and its settings |
| Options → Conversion Settings | JSON object with settings, for example `{"quality": 80}` |
| Options → File Name, Input Format | Use these when the binary data has no file name or extension |
| Options → Timeout | Seconds to wait before the node fails, 1800 by default |
| Options → Webhook URL | Send the result event for this conversion to another URL |

Each output item contains the conversion (`id`, `status`, `input`, `to`, `result.files`, `credits`, …). When a
conversion produces several files, for example one image per PDF page, the node returns one item per file with
`file.index` and `file.filename`.

Files up to 50 MB are sent with the request. Larger files go through an upload URL; the limit is the maximum file
size of your plan.

### Convert URL

Same as Convert File, but switchfile downloads the input from a public `http` or `https` URL.

### Get Conversion

Returns a conversion by ID. Turn on **Wait for Completion** to wait until it is finished, and **Download Result** to
add the result files as binary data. Use this after Convert File or Convert URL with Wait for Completion turned off,
or after the trigger.

### Errors

API errors show the error code from the [API documentation](https://switchfile.io/developers), for example
`UNSUPPORTED_PAIR`, `INVALID_DATA` or `CREDITS_EXCEEDED`. A conversion that fails returns its code, such as
`CONVERSION_FAILED` or `INVALID_INPUT`. With **On Error → Continue** the node outputs `{ error, code, status }` for the item instead of
stopping the workflow.

## Trigger

**Switchfile Trigger** receives `conversion.finished` and, if selected, `conversion.failed`. Each item is the
webhook payload:

```json
{
  "event": "conversion.finished",
  "created_at": "2026-11-07T10:00:00+00:00",
  "data": { "id": "…", "status": "finished", "result": { "files": [{ "filename": "report.pdf", "size": 48213, "url": "…" }] } }
}
```

Add a Switchfile node with **Get Conversion**, `{{ $json.data.id }}` as Conversion ID and **Download Result** on to
get the file.

Things to know:

- A switchfile account has one webhook URL. When you activate the workflow, the trigger sets it to this workflow.
  If the account already sends webhooks to another URL, activation stops with an error; turn on
  **Replace Existing Webhook URL** to take it over. Deactivating the workflow removes the URL only if it still
  points to this workflow.
- The account webhook covers conversions that do not send their own Webhook URL.
- Listening for a test event also changes the account webhook URL until you stop listening. For a workflow that
  is already active, test with a second switchfile account or a sandbox key from another account.
- Every request is checked against the `Switchfile-Signature` header (HMAC-SHA256 with the signing secret of your
  account). Requests without a valid signature get `401` and do not start the workflow. The node stores the secret
  when the workflow is activated. If a signature does not match, for example after you created a new signing secret in
  the dashboard, the node loads the secret again (at most once a minute) and checks once more. While that is not
  possible it answers `503`, and switchfile delivers the event again later.

## Examples

### Turn email attachments into PDF files

1. **Email Trigger (IMAP)** with **Download Attachments** on. The first attachment is in the binary field
   `attachment_0`.
2. **Switchfile → Convert File** with Input Binary Field `attachment_0` and Target Format `pdf`.
3. A storage node such as **Google Drive → Upload** with Input Data Field Name `data`.

### Convert an image from a URL

**Switchfile → Convert URL** with File URL `https://example.com/photo.png`, Target Format `webp` and
**Options → Conversion Settings** `{"quality": 80}`. The output item has the WebP file in the binary field `data` and
the conversion details, including the credits used, in the JSON.

### Long conversions without a waiting workflow

Video or large office files can take longer than you want a workflow to wait.

1. In the first workflow, use **Convert File** with **Wait for Completion** off. The node returns right away with
   status `queued`.
2. In a second workflow, start with **Switchfile Trigger** (event Conversion Finished), then add
   **Switchfile → Get Conversion** with Conversion ID `{{ $json.data.id }}` and **Download Result** on.

## Compatibility

Tested with n8n 2.46.

## Development

```bash
npm install
npm run lint
npm run build
npx @n8n/scan-community-package .
```

Releases are published from GitHub Actions with npm provenance (`.github/workflows/publish.yml`) when a tag
`v<version>` is pushed.

## Resources

- [switchfile API documentation](https://switchfile.io/developers)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Changelog](CHANGELOG.md)

## License

MIT, Aura UG (haftungsbeschränkt).
