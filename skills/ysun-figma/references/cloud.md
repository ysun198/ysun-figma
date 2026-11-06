# Cloud APIs

Choose the executor before adding credentials. Native canvas reads, edits and exports need no REST token. For supported cloud authoring, discover and reuse the host's official Figma tools and existing connection. If authorization is missing, use the host's official Figma connection flow. Do not register a second OAuth app, deploy a public authorization backend or request credential JSON during ordinary onboarding. An unavailable optional service does not block native canvas work.

The package declares `https://mcp.figma.com/mcp` and the registered Figma connector under the same `figma` alias. The host handles its grant and refresh; the local companion does not extract the connector's token. This connection exposes the actual hosted tools, not arbitrary REST requests. Permissions, plan gates and service quotas still apply. See the [official connection instructions](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/).

## Direct REST when needed

Use `figma_rest` when a requested endpoint is not covered by the native or hosted tool for that task. Its unmodified pinned OpenAPI specification includes 59 general REST operations, input schemas, authentication alternatives and response schemas. The same catalog also includes 12 separately documented SCIM operations and Discovery, for 72 HTTP operations. These supplemental contracts identify their official documentation source. `action="list"` works offline; choose an endpoint by its returned operation name. `action="describe", endpoint="getFileVersions"` returns its precise path/query/body contract and referenced schemas. Scope, plan and account rules are enforced by Figma.

For example, request a cloud version directory with `action="request", endpoint="getFileVersions", pathParams={file_key:exactKey}`. This is a server read, distinct from local native state. Pagination is explicit; follow returned pagination using the operation's documented query parameters. A partial page is not a whole directory. Larger responses are preserved as a JSON export in the same operation receipt; download them using `figma_export` rather than repeating the cloud request.

## Authentication

`action="auth_status"` reports configuration, never a credential value. Supported credentials are a personal access token (`pat`), user OAuth (`oauth`), plan access token (`plan`), organization OAuth (`org_oauth`) and SCIM token (`scim`). `credentialProfile` selects `default`, `org` or `scim`; configuring a separate profile preserves the personal connection. SCIM and Discovery infer their own profiles unless explicitly selected. Set `FIGMA_REST_TOKEN`, optionally `FIGMA_REST_TOKEN_TYPE`, or provide an absolute private credential-file path with `action="configure", credentialFile=...`. The JSON file must be owned by the current user, be a regular file, and have mode 0600. Format: `{ "type":"pat", "accessToken":"...", "accountId":"..." }`. Never paste credentials into source, tool arguments, chat or receipts.

PAT/user-OAuth identity is verified against `getMe` and checked against a declared accountId. OAuth refresh can use `refreshToken`, `clientId`, `clientSecret` and `expiresAt` in the same private credential file; refreshed credentials replace that private file atomically. Plan and organization-OAuth credentials declare the organization/plan accountId and validate authorization through their actual service endpoint; they do not call a user-only `getMe` endpoint. SCIM credentials additionally declare tenantId and verify its dedicated tenant endpoint. Credentials go only to fixed `https://api.figma.com` endpoints matching the selected official operation (including v1 and v2) or, for a separate SCIM token, `https://www.figma.com/scim/v2/`, never redirects or an arbitrary supplied URL. No Keychain/password/cookie extraction is used.

Only set up a separate REST credential when the requested task actually needs it. Inspect known private connection configuration and reuse an existing valid credential first; report metadata without secrets. PATs are for the user's own account and local tooling, not a shared developer credential for all installations. Handle authorized local file preparation as agent work, without asking a nontechnical user to find a credential JSON or paste a token. A new grant still needs its own authorization. Never extract browser cookies, Keychain items or another connector's token. See [Figma authentication use cases](https://developers.figma.com/docs/rest-api/authentication/).

OAuth registration and grant scopes are real authorization steps. Implementing an endpoint does not grant organization admin access or a paid seat. Complete the authorized Figma grant when needed; do not treat an HTML login page, HTTP 403 or a local method probe as API success.

## Mutations and recovery

Every mutation requires a stable `operationId`. Its input and result use the existing SQLite operation journal, deduplication, file queue and uncertain-outcome barrier. Read the original `figma_job` after lost responses. Transport failure or server-side uncertainty after a submitted write is retained as `outcome_unknown`; inspect the affected cloud resource, then use `figma_reconcile` with that evidence. Do not repeat the mutation under a new ID. HTTP 401/403/429 rejects do not claim a successful cloud write; rate-limit headers are returned.

The REST tool can invite users, create teams, post comments, change webhooks and modify other cloud resources. Only execute user-authorized actions. Prefer isolated test resources for reversible validation. A successful HTTP status confirms the request's transport result; inspect per-object errors and the actual resource for semantic acceptance.

## Enterprise services

Use `action="describe"` for `scimGetTenant`, `scimGetServiceProviderConfig`, SCIM Users/Groups list/create/replace/patch/delete, or `getDiscovery`. SCIM has its own base URL/token and configured tenant; requests for a different tenant fail before transport. Listing SCIM users can bind accounts according to Figma's contract, so it requires a stable operation ID and mutation authorization too. User/group writes may change seats or organizational access and are never an automatic QA step.

Discovery uses organization OAuth `org:discovery_read`, an ISO UTC start at least one hour in the past, up to 24 hours per range, and a 60–86400-second download-link TTL. Returned download URLs are private capabilities; do not log them unnecessarily. The tool returns Figma's actual response, without automatically downloading arbitrary returned URLs.

## Other services

The package mounts the official `https://mcp.figma.com/mcp` server and declares its public registered Figma connector. The host manages the actual Figma connection and can reuse an existing grant; the local companion neither extracts that token nor creates a second OAuth client. Discover the real hosted tools in the host tool inventory and use their exact current contracts. Load the corresponding Figma workflow skill before creating files, Specs, Make/Code Layers, shaders, generative plugins or hosted Code Connect mappings. Hosted execution and receipts belong to that service; local native/REST operation receipts do not pretend to prove a separate hosted call. Normal native edits do not consume hosted-tool quota.

The REST specification and native Plugin API are different from Widget runtime, hosted Make/Code Layers, Specs, shader compilation and hosted Code Connect publication. Discover each service through its real executor and authorized account. Do not manufacture a native replacement or label an untested service as integrated. See [capability inventory](capabilities.md).

Browser prototype Embed API has a separate packaged controller and origin/client-ID setup; see [Embed API](embeds.md). REST oEmbed metadata is not prototype playback control.
