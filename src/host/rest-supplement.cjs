// Contracts manually transcribed from the linked official docs, 2026-11-06.
// Kept separate from the unmodified upstream REST OpenAPI snapshot.
const source = {
  retrieved: '2026-11-06',
  scim: 'https://developers.figma.com/docs/rest-api/scim-endpoints/',
  schemas: 'https://developers.figma.com/docs/rest-api/scim-supported-schemas/',
  discovery: 'https://developers.figma.com/docs/rest-api/discovery-endpoints/',
};
const string = { type: 'string', minLength: 1 };
const parameter = (name, location, schema = string, required = false) => ({
  name,
  in: location,
  schema,
  required,
});
const schemas = { type: 'array', minItems: 1, items: string };
const members = {
  type: 'array',
  items: {
    type: 'object',
    required: ['value'],
    properties: { value: string, display: { type: 'string' } },
  },
};
const user = {
  type: 'object',
  required: ['schemas', 'userName', 'active'],
  properties: {
    schemas,
    userName: { type: 'string', minLength: 1, maxLength: 100 },
    active: { type: 'boolean' },
    displayName: { type: 'string', maxLength: 100 },
    externalId: { type: 'string', maxLength: 255 },
    name: {
      type: 'object',
      properties: {
        givenName: { type: 'string' },
        familyName: { type: 'string' },
      },
    },
    title: { type: 'string' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'value'],
        properties: {
          type: { enum: ['seatType'] },
          value: { enum: ['Full', 'Dev', 'Collab', 'View'] },
        },
      },
    },
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
      type: 'object',
    },
    'urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User': {
      type: 'object',
      properties: { figmaAdmin: { type: 'boolean' } },
    },
  },
};
const group = {
  type: 'object',
  required: ['schemas', 'displayName'],
  properties: {
    schemas,
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    externalId: { type: 'string', maxLength: 255 },
    members,
  },
};
const patch = {
  type: 'object',
  required: ['schemas', 'Operations'],
  properties: {
    schemas,
    Operations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['op'],
        properties: {
          op: { enum: ['add', 'remove', 'replace'] },
          path: { type: 'string' },
          value: {},
        },
      },
    },
  },
};
function scim(operationId, method, suffix, parameters = [], body) {
  return {
    operationId,
    method,
    route: '/scim/v2/{tenant_id}' + suffix,
    baseUrl: 'https://www.figma.com',
    credentialProfile: 'scim',
    readOnly: !(method === 'GET' && suffix === '/Users') && method === 'GET',
    summary: method + ' SCIM ' + suffix,
    tags: ['SCIM'],
    security: [{ ScimBearer: [] }],
    parameters: [parameter('tenant_id', 'path', string, true), ...parameters],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: body } },
          },
        }
      : {}),
    responses: {
      [method === 'DELETE' ? '204' : '200']: {
        description:
          'SCIM response; resource/list format is defined in the linked official documentation',
        ...(method === 'DELETE'
          ? {}
          : { content: { 'application/json': { schema: {} } } }),
      },
    },
    source: source.scim,
  };
}
const operations = [
  scim('scimGetTenant', 'GET', ''),
  scim('scimGetServiceProviderConfig', 'GET', '/ServiceProviderConfig'),
];
for (const [resource, schema, id] of [
  ['Users', user, 'user_id'],
  ['Groups', group, 'group_id'],
]) {
  operations.push(
    scim('scimGet' + resource, 'GET', '/' + resource, [
      parameter('filter', 'query', { type: 'string' }),
      parameter('count', 'query', {
        type: 'integer',
        minimum: 1,
        ...(resource === 'Users' ? { maximum: 3000 } : {}),
      }),
      parameter('startIndex', 'query', { type: 'integer', minimum: 1 }),
    ]),
  );
  operations.push(
    scim('scimPost' + resource, 'POST', '/' + resource, [], schema),
  );
  for (const method of ['PUT', 'PATCH', 'DELETE'])
    operations.push(
      scim(
        'scim' + method[0] + method.slice(1).toLowerCase() + resource,
        method,
        '/' + resource + '/{' + id + '}',
        [parameter(id, 'path', string, true)],
        method === 'DELETE' ? undefined : method === 'PATCH' ? patch : schema,
      ),
    );
}
operations.push({
  operationId: 'getDiscovery',
  method: 'GET',
  route: '/v1/discovery',
  credentialProfile: 'org',
  summary: 'Retrieve hourly organization text event download links',
  tags: ['Discovery'],
  security: [{ OrgOAuth2: ['org:discovery_read'] }],
  parameters: [
    parameter('start_date', 'query', string, true),
    parameter('end_date', 'query'),
    parameter('file_ttl_in_seconds', 'query', {
      type: 'integer',
      minimum: 60,
      maximum: 86400,
    }),
  ],
  responses: {
    200: {
      description: 'Hourly download links',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'boolean' },
              status: { type: 'integer' },
              meta: {
                type: 'object',
                properties: {
                  urls: {
                    type: 'object',
                    additionalProperties: { type: 'array', items: string },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  source: source.discovery,
});
module.exports = { operations, source };
